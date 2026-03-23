import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

// ============================================================
// Constants
// ============================================================

const THRESHOLD_WARNING = 1 * 1024 * 1024 * 1024;
const THRESHOLD_CRITICAL = 2 * 1024 * 1024 * 1024;
const STATUS_BAR_POLL_MS = 3000;
const DASHBOARD_POLL_MS = 5000;
const SPARKLINE_MAX_SAMPLES = 20;
// Braille sparkline: each character encodes 2 data points (left + right column)
// Dot layout (top to bottom): 1,2,3,7 (left)  4,5,6,8 (right)
const BRAILLE_BASE = 0x2800;

const REGISTRY_PATH = path.join(os.homedir(), '.gemini', 'antigravity', '.resource-monitor-registry.json');

// ============================================================
// Types
// ============================================================

interface RegistryEntry {
    folderName: string;
    openEditors: string[];
    customLabel: string;
    detectedTitle: string;
    pid: number;
    timestamp: number;
}

interface Registry {
    entries: Record<string, RegistryEntry>;
}

interface SystemMemoryInfo {
    totalBytes: number;
    pressureLevel: string;
    appMemoryBytes: number;
    wiredBytes: number;
    compressedBytes: number;
    swapUsedBytes: number;
}

type PressureSeverity = 0 | 1 | 2;

interface ProcessInfo {
    pid: number;
    ppid: number;
    rssKB: number;
    memKB: number;
    cpu: number;
    command: string;
}

interface ProcessListItem {
    pid: number;
    type: string;
    memKB: number;
    cpu: number;
}

interface WorkspaceGroup {
    name: string;
    workspaceId: string;
    subtitle: string;
    isZombie: boolean;
    extHostPid: number;
    totalMemoryKB: number;
    processList: ProcessListItem[];
}

interface ScanResult {
    workspaces: WorkspaceGroup[];
    sharedMemoryKB: number;
    sharedProcesses: ProcessListItem[];
    totalMemoryKB: number;
    processCount: number;
}

// ============================================================
// Utilities
// ============================================================

function formatBytes(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(0)} MB`; }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function humanizeWorkspaceId(wsId: string): string {
    let name = wsId.replace(/^file_Users_[^_]+_/, '').replace(/^file_/, '');
    const segments = name.split('_');
    const playgroundIdx = segments.indexOf('playground');
    if (playgroundIdx >= 0 && playgroundIdx < segments.length - 1) {
        name = segments.slice(playgroundIdx + 1).join('-');
    } else {
        const projIdx = segments.indexOf('Projects');
        if (projIdx >= 0 && projIdx < segments.length - 1) {
            name = segments.slice(projIdx + 1).join('-');
        } else {
            name = segments.slice(-2).join('-');
        }
    }
    return name;
}

function wsIdToPath(wsId: string): string {
    return wsId.replace(/^file_Users_[^_]+_/, '~/').replace(/^file_/, '/').replace(/_/g, '/');
}

function isPlaygroundPath(wsId: string): boolean {
    return wsId.includes('playground');
}

function readRegistry(): Registry {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
            // Handle old format (direct keys, no entries wrapper)
            if (raw.entries && typeof raw.entries === 'object') {
                return raw;
            }
            // Old format: top-level keys are folder paths, migrate
            return { entries: {} };
        }
    }
    catch { /* ignore */ }
    return { entries: {} };
}

function writeRegistry(data: Registry): void {
    try {
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
    }
    catch { /* ignore */ }
}

// Cache: folderName -> title (avoids re-scanning brain dirs every refresh)
const titleCache = new Map<string, string>();
let titleCacheTime = 0;

/**
 * Scan brain .resolved files (artifacts rendered by Antigravity) for references
 * to a workspace folder name. If found, read the corresponding task.md for the
 * conversation title.
 */
function findConversationTitle(folderName: string): string {
    // Check cache (valid for 60s)
    if (Date.now() - titleCacheTime < 60000 && titleCache.has(folderName)) {
        return titleCache.get(folderName) || '';
    }

    try {
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        if (!fs.existsSync(brainDir)) { return ''; }

        const convDirs = fs.readdirSync(brainDir).filter(d => {
            try { return fs.statSync(path.join(brainDir, d)).isDirectory() && /^[0-9a-f-]{36}$/.test(d); }
            catch { return false; }
        });

        for (const convDir of convDirs) {
            const convPath = path.join(brainDir, convDir);
            // Search .resolved files for the folder name
            try {
                const files = fs.readdirSync(convPath).filter(f => f.includes('.resolved'));
                for (const file of files) {
                    const filePath = path.join(convPath, file);
                    try {
                        const content = fs.readFileSync(filePath, 'utf8');
                        if (content.includes(folderName)) {
                            // Found! Read task.md for title
                            const taskPath = path.join(convPath, 'task.md');
                            if (fs.existsSync(taskPath)) {
                                const taskContent = fs.readFileSync(taskPath, 'utf8');
                                const firstLine = taskContent.split('\n').find(l => l.trim().length > 0);
                                if (firstLine) {
                                    const title = firstLine.replace(/^#+\s*/, '').trim().slice(0, 60);
                                    titleCache.set(folderName, title);
                                    titleCacheTime = Date.now();
                                    return title;
                                }
                            }
                            break;
                        }
                    }
                    catch { continue; }
                }
            }
            catch { continue; }
        }
    }
    catch { /* ignore */ }

    titleCache.set(folderName, '');
    titleCacheTime = Date.now();
    return '';
}

function registerSelf(): void {
    try {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return; }

        const folderName = folders[0].name;

        // Get open editor basenames
        const openEditors: string[] = [];
        try {
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.label && !openEditors.includes(tab.label)) {
                        openEditors.push(tab.label);
                    }
                }
            }
        }
        catch { /* tabGroups API may not be available */ }

        // Try to get conversation title from Antigravity extension API
        let detectedTitle = '';
        try {
            const antigravity = vscode.extensions.getExtension('google.antigravity');
            if (antigravity?.isActive && antigravity.exports) {
                const api = antigravity.exports;
                // Try common API patterns
                if (typeof api.getConversationTitle === 'function') {
                    detectedTitle = api.getConversationTitle() || '';
                } else if (typeof api.getCurrentConversation === 'function') {
                    const conv = api.getCurrentConversation();
                    detectedTitle = conv?.title || conv?.name || '';
                }
            }
        }
        catch { /* API not available */ }

        // Fallback: try to read chat history title from VS Code chat API
        if (!detectedTitle) {
            try {
                // Use vscode.chat.participants or similar
                const chatExt = vscode.extensions.getExtension('AGI-is-going-to-arrive.antigravity-cockpit');
                if (chatExt?.isActive && chatExt.exports) {
                    const api = chatExt.exports;
                    if (typeof api.getConversationTitle === 'function') {
                        detectedTitle = api.getConversationTitle() || '';
                    }
                }
            }
            catch { /* ignore */ }
        }

        const registry = readRegistry();
        // Clean stale entries (> 2 hours old)
        const now = Date.now();
        for (const key of Object.keys(registry.entries)) {
            if (registry.entries[key] && now - registry.entries[key].timestamp > 7200000) {
                delete registry.entries[key];
            }
        }

        const existing = registry.entries[folderName];
        registry.entries[folderName] = {
            folderName,
            openEditors: openEditors.slice(0, 5),
            customLabel: existing?.customLabel || '',
            detectedTitle: detectedTitle || existing?.detectedTitle || '',
            pid: process.pid,
            timestamp: now,
        };
        writeRegistry(registry);
    }
    catch { /* Never let registration crash activation */ }
}

function setCustomLabel(folderName: string, label: string): void {
    const registry = readRegistry();
    if (registry.entries[folderName]) {
        registry.entries[folderName].customLabel = label;
    } else {
        registry.entries[folderName] = {
            folderName,
            openEditors: [],
            customLabel: label,
            detectedTitle: '',
            pid: 0,
            timestamp: Date.now(),
        };
    }
    writeRegistry(registry);
}

function pressureLabel(severity: PressureSeverity): string {
    return severity === 2 ? 'Critical' : severity === 1 ? 'Warn' : 'Normal';
}

function mapNativePressureLevel(level: number): PressureSeverity | null {
    switch (level) {
        case 1: return 0;
        case 2: return 1;
        case 4: return 2;
        default: return null;
    }
}

function maxSeverity(current: PressureSeverity, next: PressureSeverity): PressureSeverity {
    return current > next ? current : next;
}

function getSystemMemoryInfo(): SystemMemoryInfo | null {
    if (process.platform !== 'darwin') { return null; }
    try {
        const totalBytes = os.totalmem();
        const vmStatRaw = execSync('vm_stat', { encoding: 'utf8', timeout: 2000 });
        const pageSize = parseInt(vmStatRaw.match(/page size of (\d+)/)?.[1] ?? '16384', 10);
        const getPages = (label: string): number => {
            const match = vmStatRaw.match(new RegExp(`${label}:\\s+(\\d+)`));
            return match ? parseInt(match[1], 10) : 0;
        };
        const appMemoryBytes = (getPages('Pages active') + getPages('Pages wired down') + getPages('Pages occupied by compressor')) * pageSize;
        const wiredBytes = getPages('Pages wired down') * pageSize;
        const compressedBytes = getPages('Pages occupied by compressor') * pageSize;

        let swapUsedBytes = 0;
        try {
            const swapRaw = execSync('sysctl vm.swapusage', { encoding: 'utf8', timeout: 2000 });
            const m = swapRaw.match(/used\s*=\s*([\d.]+)([MGK])/);
            if (m) { swapUsedBytes = parseFloat(m[1]) * (m[2] === 'G' ? 1073741824 : m[2] === 'M' ? 1048576 : 1024); }
        }
        catch { /* ignore */ }

        const appRatio = appMemoryBytes / totalBytes;
        const compressedRatio = compressedBytes / totalBytes;
        let nativeSeverity: PressureSeverity | null = null;
        let fallbackSeverity: PressureSeverity = 0;

        // Prefer the native macOS pressure state used for memory pressure notifications:
        // 1 = normal, 2 = warning (yellow), 4 = critical (red).
        try {
            const nativeLevelRaw = execSync('sysctl -n kern.memorystatus_vm_pressure_level', { encoding: 'utf8', timeout: 1000 }).trim();
            const nativeLevel = parseInt(nativeLevelRaw, 10);
            nativeSeverity = mapNativePressureLevel(nativeLevel);
            if (nativeSeverity !== null) {
                fallbackSeverity = maxSeverity(fallbackSeverity, nativeSeverity);
            }
        }
        catch { /* ignore */ }

        try {
            // Lower available-memory percentage means higher pressure.
            const levelRaw = execSync('sysctl -n kern.memorystatus_level', { encoding: 'utf8', timeout: 1000 }).trim();
            const level = parseInt(levelRaw, 10);
            if (!Number.isNaN(level)) {
                fallbackSeverity = maxSeverity(fallbackSeverity, level <= 15 ? 2 : level <= 40 ? 1 : 0);
            }
        }
        catch { /* ignore */ }

        try {
            // memory_pressure tracks the same user-facing memory pressure view and is
            // a useful fallback when the kernel enum is missing or lags.
            const transitionRaw = execSync('sysctl -n kern.vm_pressure_level_transition_threshold', { encoding: 'utf8', timeout: 1000 }).trim();
            const transition = parseInt(transitionRaw, 10);
            const pressureRaw = execSync('memory_pressure', { encoding: 'utf8', timeout: 2000 });
            const freePct = parseInt(pressureRaw.match(/System-wide memory free percentage:\s*(\d+)%/)?.[1] ?? '', 10);
            if (!Number.isNaN(transition) && !Number.isNaN(freePct)) {
                const criticalFreePct = Math.max(5, transition - 10);
                fallbackSeverity = maxSeverity(fallbackSeverity, freePct <= criticalFreePct ? 2 : freePct <= transition + 5 ? 1 : 0);
            }
        }
        catch { /* ignore */ }

        // Heuristics are only a fallback when the native pressure enum is unavailable.
        // Swap/compression can be high for a while after pressure has fallen back to yellow.
        if (nativeSeverity === null) {
            if (appRatio > 0.95 || swapUsedBytes >= 2 * 1024 * 1024 * 1024) {
                fallbackSeverity = maxSeverity(fallbackSeverity, 2);
            } else if (appRatio > 0.85 || swapUsedBytes > 0 || compressedRatio > 0.2) {
                fallbackSeverity = maxSeverity(fallbackSeverity, 1);
            }
        }

        const pressureSeverity = nativeSeverity ?? fallbackSeverity;
        const pressureLvl = pressureLabel(pressureSeverity);
        return { totalBytes, pressureLevel: pressureLvl, appMemoryBytes, wiredBytes, compressedBytes, swapUsedBytes };
    }
    catch { return null; }
}

/**
 * Get per-process memory footprint (matches Activity Monitor's "Memory" column)
 * using the macOS `footprint` tool. Falls back to RSS if footprint is unavailable.
 * @param pids - Array of PIDs to query
 * @returns PID -> footprint in KB
 */
function getFootprints(pids: number[]): Map<number, number> {
    const result = new Map<number, number>();
    if (pids.length === 0 || process.platform !== 'darwin') {
        return result;
    }
    try {
        // Build space-separated PID args for footprint command
        const pidArgs = pids.join(' ');
        const raw = execSync(`footprint ${pidArgs} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
        // Parse lines like: "language_server_macos_arm [86654]: 64-bit    Footprint: 230 MB"
        const regex = /\[(\d+)\].*?Footprint:\s*([\d.]+)\s*(KB|MB|GB)/g;
        let match;
        while ((match = regex.exec(raw)) !== null) {
            const pid = parseInt(match[1], 10);
            const value = parseFloat(match[2]);
            const unit = match[3];
            let kb = value;
            if (unit === 'MB') { kb = value * 1024; }
            else if (unit === 'GB') { kb = value * 1024 * 1024; }
            result.set(pid, Math.round(kb));
        }
    }
    catch { /* footprint tool failed, caller will use RSS fallback */ }
    return result;
}

/**
 * Recursively kill an entire process tree (children, grandchildren, etc.).
 * Kills bottom-up so children die before parents, preventing orphan adoption.
 */
function killProcessTree(pid: number): void {
    try {
        // Find all direct children of this PID
        const childrenRaw = execSync(`pgrep -P ${pid}`, { encoding: 'utf8', timeout: 2000 }).trim();
        if (childrenRaw) {
            for (const childPid of childrenRaw.split('\n').map(Number)) {
                if (childPid > 0) { killProcessTree(childPid); }
            }
        }
    }
    catch { /* no children, or pgrep failed */ }

    try { process.kill(pid, 'SIGKILL'); }
    catch { /* already dead */ }
}

function classifySharedProcess(command: string): string {
    if (command.includes('--type=renderer') || command.includes('Helper (Renderer)')) { return 'Renderer'; }
    if (command.includes('--type=gpu') || command.includes('Helper (GPU)')) { return 'GPU'; }
    if (command.includes('--type=utility')) { return 'Utility'; }
    if (command.includes('language_server')) { return 'Language Server'; }
    if (command.includes('mathjax')) { return 'MathJax'; }
    if (command.includes('jsonServerMain')) { return 'JSON Server'; }
    if (command.includes('tsserver')) { return 'TS Server'; }
    if (command.includes('pyrefly') || command.includes('pyre')) { return 'Pyre'; }
    if (command.includes('codex')) { return 'Codex'; }
    if (command.includes('markdown-language-features')) { return 'Markdown Server'; }
    const basename = command.split('/').pop()?.split(' ')[0] || '';
    if (basename.includes('Antigravity') && !command.includes('--type=')) { return 'Main'; }
    if (basename.includes('Electron') && !command.includes('--type=')) { return 'Main'; }
    return 'Other';
}

function scanWorkspaces(): ScanResult {
    const registry = readRegistry();

    try {
        const raw = execSync(
            'ps -eo pid,ppid,rss,pcpu,command | grep -i Antigravity | grep -v grep',
            { encoding: 'utf8', timeout: 3000 }
        );

        const allProcs: ProcessInfo[] = [];
        for (const line of raw.split('\n')) {
            if (line.trim() === '') { continue; }
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
            if (!m) { continue; }
            allProcs.push({
                pid: parseInt(m[1], 10),
                ppid: parseInt(m[2], 10),
                rssKB: parseInt(m[3], 10),
                memKB: parseInt(m[3], 10),
                cpu: parseFloat(m[4]),
                command: m[5],
            });
        }

        // Get footprint for all Antigravity processes (matches Activity Monitor)
        const allPids = allProcs.map(p => p.pid);
        const footprints = getFootprints(allPids);
        for (const p of allProcs) {
            if (footprints.has(p.pid)) {
                p.memKB = footprints.get(p.pid)!;
            }
        }

        const wsToExtHost = new Map<string, number>();
        for (const p of allProcs) {
            const wsMatch = p.command.match(/--workspace_id\s+(\S+)/);
            if (wsMatch) {
                wsToExtHost.set(wsMatch[1], p.ppid);
            }
        }

        const assignedPids = new Set<number>();
        const workspaces: WorkspaceGroup[] = [];

        for (const [wsId, extHostPid] of wsToExtHost) {
            const name = humanizeWorkspaceId(wsId);

            // Build subtitle: customLabel > detectedTitle > brain title > open editors > path
            let subtitle = '';
            const regEntry = registry.entries[name];
            if (regEntry?.customLabel) {
                subtitle = regEntry.customLabel;
            } else if (regEntry?.detectedTitle) {
                subtitle = regEntry.detectedTitle;
            } else if (isPlaygroundPath(wsId)) {
                // For playground workspaces, try to find conversation title from brain
                subtitle = findConversationTitle(name);
                if (!subtitle && regEntry?.openEditors?.length) {
                    subtitle = regEntry.openEditors.slice(0, 3).join(', ');
                }
            } else {
                subtitle = wsIdToPath(wsId);
            }

            const isZombie = isPlaygroundPath(wsId) && !subtitle;

            const group: WorkspaceGroup = {
                name, workspaceId: wsId, subtitle, isZombie, extHostPid,
                totalMemoryKB: 0, processList: [],
            };

            for (const p of allProcs) {
                if (p.pid === extHostPid) {
                    group.processList.push({ pid: p.pid, type: 'Extension Host', memKB: p.memKB, cpu: p.cpu });
                    group.totalMemoryKB += p.memKB;
                    assignedPids.add(p.pid);
                    break;
                }
            }

            for (const p of allProcs) {
                if (p.ppid === extHostPid && !assignedPids.has(p.pid)) {
                    let type = 'Worker';
                    if (p.command.includes('language_server')) { type = 'Language Server'; }
                    else if (p.command.includes('tsserver')) { type = 'TS Server'; }
                    else if (p.command.includes('jsonServerMain')) { type = 'JSON Server'; }
                    else if (p.command.includes('pyrefly') || p.command.includes('pyre')) { type = 'Pyre'; }
                    group.processList.push({ pid: p.pid, type, memKB: p.memKB, cpu: p.cpu });
                    group.totalMemoryKB += p.memKB;
                    assignedPids.add(p.pid);
                }
            }

            workspaces.push(group);
        }

        let sharedMemoryKB = 0;
        const sharedProcesses: ProcessListItem[] = [];
        for (const p of allProcs) {
            if (!assignedPids.has(p.pid)) {
                sharedMemoryKB += p.memKB;
                sharedProcesses.push({ pid: p.pid, type: classifySharedProcess(p.command), memKB: p.memKB, cpu: p.cpu });
            }
        }

        sharedProcesses.sort((a, b) => b.memKB - a.memKB);
        workspaces.sort((a, b) => b.totalMemoryKB - a.totalMemoryKB);
        const totalMemoryKB = allProcs.reduce((sum, p) => sum + p.memKB, 0);
        return { workspaces, sharedMemoryKB, sharedProcesses, totalMemoryKB, processCount: allProcs.length };
    }
    catch {
        return { workspaces: [], sharedMemoryKB: 0, sharedProcesses: [], totalMemoryKB: 0, processCount: 0 };
    }
}

/**
 * Get total memory for the CURRENT window (ext host PID = process.pid + children).
 * This matches the dashboard metric, unlike process.memoryUsage().rss which only
 * shows the extension host's own RSS.
 */
function getCurrentWindowMemoryKB(): number {
    try {
        const myPid = process.pid;
        // Collect self + direct children PIDs
        const raw = execSync(
            `ps -eo pid,ppid,rss | grep -v grep`,
            { encoding: 'utf8', timeout: 2000 }
        );
        const relevantPids: number[] = [];
        let rssTotal = 0;
        for (const line of raw.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
            if (!m) { continue; }
            const pid = parseInt(m[1], 10);
            const ppid = parseInt(m[2], 10);
            const rss = parseInt(m[3], 10);
            if (pid === myPid || ppid === myPid) {
                relevantPids.push(pid);
                rssTotal += rss;
            }
        }
        // Try footprint for accurate memory (matches Activity Monitor)
        if (relevantPids.length > 0) {
            const footprints = getFootprints(relevantPids);
            if (footprints.size > 0) {
                let fpTotal = 0;
                for (const kb of footprints.values()) {
                    fpTotal += kb;
                }
                if (fpTotal > 0) {
                    return fpTotal;
                }
            }
        }
        return rssTotal || Math.round(process.memoryUsage().rss / 1024);
    }
    catch {
        return Math.round(process.memoryUsage().rss / 1024);
    }
}

// ============================================================
// WebView dashboard
// ============================================================

function generateDashboardHtml(webview: vscode.Webview): string {
    const data = scanWorkspaces();
    const sysInfo = getSystemMemoryInfo();

    // Generate CSP nonce for inline script
    const nonce = crypto.randomBytes(16).toString('base64');

    const totalStr = formatBytes(data.totalMemoryKB * 1024);
    const sharedStr = formatBytes(data.sharedMemoryKB * 1024);

    let sysBar = '';
    if (sysInfo) {
        const totalRAM = formatBytes(sysInfo.totalBytes);
        const appMem = formatBytes(sysInfo.appMemoryBytes);
        const swap = formatBytes(sysInfo.swapUsedBytes);
        const pressureColor = sysInfo.pressureLevel === 'Critical' ? '#f44747'
            : sysInfo.pressureLevel === 'Warn' ? '#cca700' : '#4ec44e';
        sysBar = `
        <div class="sys-bar">
            <span>System: <b>${totalRAM}</b> RAM</span>
            <span>App Memory: <b>${appMem}</b></span>
            <span>Swap: <b>${swap}</b></span>
            <span>Pressure: <b style="color:${pressureColor}">${sysInfo.pressureLevel}</b></span>
        </div>`;
    }

    const wsRows = data.workspaces.map(ws => {
        const memStr = formatBytes(ws.totalMemoryKB * 1024);
        const memPercent = data.totalMemoryKB > 0
            ? ((ws.totalMemoryKB / data.totalMemoryKB) * 100).toFixed(1) : '0';
        const barColor = ws.totalMemoryKB > 500 * 1024 ? '#f44747'
            : ws.totalMemoryKB > 200 * 1024 ? '#cca700' : '#4ec44e';
        const barWidth = data.totalMemoryKB > 0
            ? Math.max(2, (ws.totalMemoryKB / data.totalMemoryKB) * 100) : 0;

        const procRows = ws.processList.map(p => {
            const memValue = p.memKB;
            const procMemStr = memValue >= 1024 * 1024 ? `${(memValue / (1024 * 1024)).toFixed(1)} GB` : `${(memValue / 1024).toFixed(0)} MB`;
            return `
            <div class="proc-row">
                <span class="proc-type">${p.type}</span>
                <span class="proc-mem">${procMemStr}</span>
                <span class="proc-cpu">${p.cpu.toFixed(1)}%</span>
                <span class="proc-pid">PID ${p.pid}</span>
                <button class="kill-btn" data-action="kill" data-pid="${p.pid}" title="Kill">x</button>
            </div>
        `;
        }).join('');

        // Escape the name for use in JS strings
        const escapedName = ws.name.replace(/'/g, "\\'");
        const subtitleHtml = ws.subtitle
            ? `<div class="ws-subtitle" data-action="rename" data-name="${ws.name}">` + ws.subtitle + `</div>`
            : `<div class="ws-subtitle ws-subtitle-empty" data-action="rename" data-name="${ws.name}">click to label</div>`;

        return `
        <div class="ws-card${ws.isZombie ? ' zombie' : ''}">
            <div class="ws-header">
                <div class="ws-info">
                    <div class="ws-name">${ws.name}</div>
                    ${subtitleHtml}
                </div>
                <div class="ws-stats">
                    <span class="ws-mem">${memStr}</span>
                    <span class="ws-pct">${memPercent}%</span>
                    <button class="kill-all-btn" data-action="killWorkspace" data-pid="${ws.extHostPid}" data-name="${ws.name}" title="Kill this workspace">Kill</button>
                </div>
            </div>
            <div class="ws-bar-track">
                <div class="ws-bar-fill" style="width:${barWidth}%; background:${barColor}"></div>
            </div>
            <div class="ws-details hidden">
                ${procRows}
            </div>
        </div>`;
    }).join('');

    // Build zombie bar HTML before the template
    const zombies = data.workspaces.filter(ws => ws.isZombie);
    let zombieBar = '';
    if (zombies.length > 0) {
        const zombieStr = formatBytes(zombies.reduce((s, z) => s + z.totalMemoryKB, 0) * 1024);
        const pids = zombies.map(z => z.extHostPid).join(',');
        zombieBar = `<div class="zombie-bar">
            <span><b>${zombies.length}</b> zombie playground(s) using <b>${zombieStr}</b> (unnamed, empty)</span>
            <button class="zombie-kill-btn" data-action="killZombies" data-pids="${pids}">Kill All Zombies</button>
        </div>`;
    }

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    :root {
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-editor-foreground);
        --border: var(--vscode-widget-border, #333);
        --card-bg: var(--vscode-editorWidget-background, #1e1e1e);
        --hover: var(--vscode-list-hoverBackground, #2a2d2e);
        --accent: var(--vscode-focusBorder, #007fd4);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family, system-ui);
        font-size: 13px;
        color: var(--fg);
        background: var(--bg);
        padding: 12px;
    }
    .header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 12px; padding-bottom: 8px;
        border-bottom: 1px solid var(--border);
    }
    .header h2 { font-size: 14px; font-weight: 600; }
    .header .summary { font-size: 12px; opacity: 0.7; }
    .refresh-btn {
        background: var(--accent); color: white; border: none;
        padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 12px;
    }
    .refresh-btn:hover { opacity: 0.85; }
    .sys-bar {
        display: flex; gap: 16px; font-size: 12px; padding: 8px 12px;
        background: var(--card-bg); border-radius: 6px; margin-bottom: 12px;
        border: 1px solid var(--border);
    }
    .sys-bar span { opacity: 0.8; }
    .sys-bar b { opacity: 1; }
    .ws-card {
        background: var(--card-bg); border: 1px solid var(--border);
        border-radius: 6px; margin-bottom: 6px; overflow: hidden;
    }
    .ws-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 12px; cursor: pointer; transition: background 0.15s;
    }
    .ws-header:hover { background: var(--hover); }
    .ws-info { flex: 1; min-width: 0; }
    .ws-name { font-weight: 600; font-size: 13px; }
    .ws-subtitle {
        font-size: 11px; opacity: 0.45; margin-top: 2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        cursor: pointer;
    }
    .ws-subtitle:hover { opacity: 0.7; text-decoration: underline; }
    .ws-subtitle-empty { font-style: italic; opacity: 0.25; }
    .ws-subtitle-empty:hover { opacity: 0.5; }
    .ws-stats {
        display: flex; align-items: center; gap: 10px;
        font-size: 12px; flex-shrink: 0;
    }
    .ws-mem { font-weight: 600; min-width: 55px; text-align: right; }
    .ws-pct { opacity: 0.5; min-width: 40px; text-align: right; }
    .ws-bar-track { height: 2px; background: var(--border); }
    .ws-bar-fill { height: 100%; transition: width 0.3s ease; border-radius: 1px; }
    .ws-details { padding: 0 12px; }
    .ws-details.hidden { display: none; }
    .proc-row {
        display: flex; align-items: center; gap: 8px; padding: 4px 0;
        font-size: 12px; border-top: 1px solid var(--border); opacity: 0.8;
    }
    .proc-type { flex: 1; }
    .proc-mem { min-width: 50px; text-align: right; font-variant-numeric: tabular-nums; }
    .proc-cpu { min-width: 40px; text-align: right; opacity: 0.6; font-variant-numeric: tabular-nums; }
    .proc-pid { min-width: 65px; text-align: right; opacity: 0.4; font-size: 11px; }
    .kill-btn {
        background: transparent; color: #f44747; border: 1px solid #f4474766;
        border-radius: 3px; cursor: pointer; font-size: 11px;
        padding: 1px 6px; opacity: 0.5; transition: opacity 0.15s;
    }
    .kill-btn:hover { opacity: 1; background: #f4474722; }
    .kill-all-btn {
        background: transparent; color: #f44747; border: 1px solid #f4474755;
        border-radius: 3px; cursor: pointer; font-size: 11px;
        padding: 2px 8px; opacity: 0; transition: opacity 0.15s;
    }
    .ws-header:hover .kill-all-btn { opacity: 0.7; }
    .kill-all-btn:hover { opacity: 1 !important; background: #f4474722; }
    .shared-row {
        display: flex; justify-content: space-between; padding: 8px 12px;
        font-size: 12px; opacity: 0.6; margin-top: 4px;
    }
    .zombie-bar {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 12px; margin-bottom: 12px;
        background: #f4474711; border: 1px solid #f4474733;
        border-radius: 6px; font-size: 12px;
    }
    .zombie-bar span { opacity: 0.8; }
    .zombie-bar b { color: #f44747; }
    .zombie-kill-btn {
        background: #f44747; color: white; border: none;
        padding: 4px 14px; border-radius: 3px; cursor: pointer; font-size: 12px;
        font-weight: 600; transition: opacity 0.15s;
    }
    .zombie-kill-btn:hover { opacity: 0.85; }
    .ws-card.zombie { opacity: 0.5; border-style: dashed; }
    .ws-card.zombie:hover { opacity: 0.8; }
    .header-actions { display: flex; gap: 8px; align-items: center; }
    .auto-refresh-label { font-size: 11px; opacity: 0.4; }
</style>
</head>
<body>
    <div class="header">
        <div>
            <h2>Antigravity Process Monitor</h2>
            <div class="summary">${data.workspaces.length} workspaces | ${data.processCount} processes | ${totalStr} total (footprint)</div>
        </div>
        <div class="header-actions">
            <span class="auto-refresh-label">Auto-refresh: ${DASHBOARD_POLL_MS / 1000}s</span>
            <button class="refresh-btn" data-action="reloadWindow" style="background:#1389fd">Reload Window</button>
            <button class="refresh-btn" data-action="refresh">Refresh</button>
        </div>
    </div>
    ${sysBar}
    ${zombieBar}
    ${wsRows}
    <div class="ws-card" style="opacity:0.7">
        <div class="ws-header">
            <div class="ws-info">
                <div class="ws-name">Shared Processes</div>
                <div class="ws-subtitle">main, GPU, renderers, utilities</div>
            </div>
            <div class="ws-stats">
                <span class="ws-mem">${sharedStr}</span>
                <span class="ws-pct">${data.totalMemoryKB > 0 ? ((data.sharedMemoryKB / data.totalMemoryKB) * 100).toFixed(1) : '0'}%</span>
            </div>
        </div>
        <div class="ws-bar-track">
            <div class="ws-bar-fill" style="width:${data.totalMemoryKB > 0 ? Math.max(2, (data.sharedMemoryKB / data.totalMemoryKB) * 100) : 0}%; background:#888"></div>
        </div>
        <div class="ws-details hidden">
            ${data.sharedProcesses.map(p => {
                const procMemStr = formatBytes(p.memKB * 1024);
                return `<div class="proc-row">
                    <span class="proc-type">${p.type}</span>
                    <span class="proc-mem">${procMemStr}</span>
                    <span class="proc-cpu">${p.cpu.toFixed(1)}%</span>
                    <span class="proc-pid">PID ${p.pid}</span>
                    <button class="kill-btn" data-action="kill" data-pid="${p.pid}" title="Kill">x</button>
                </div>`;
            }).join('')}
        </div>
    </div>
    <script nonce="${nonce}">
        (function() {
            try {
                var vscode = acquireVsCodeApi();
            } catch(err) {
                document.body.insertAdjacentHTML('beforeend',
                    '<pre style="color:red;padding:8px">Script Error: ' + err.message + '</pre>');
                return;
            }
            document.addEventListener('click', function(e) {
                var target = e.target as HTMLElement;
                var action = target.dataset ? target.dataset.action : null;
                if (!action) {
                    var header = target.closest('.ws-header');
                    if (header) {
                        var details = header.parentElement?.querySelector('.ws-details');
                        if (details) { details.classList.toggle('hidden'); }
                    }
                    return;
                }
                e.stopPropagation();
                if (action === 'refresh') {
                    vscode.postMessage({ command: 'refresh' });
                } else if (action === 'reloadWindow') {
                    vscode.postMessage({ command: 'reloadWindow' });
                } else if (action === 'kill') {
                    vscode.postMessage({ command: 'kill', pid: parseInt(target.dataset.pid!) });
                } else if (action === 'killWorkspace') {
                    vscode.postMessage({ command: 'killWorkspace', pid: parseInt(target.dataset.pid!), name: target.dataset.name });
                } else if (action === 'rename') {
                    vscode.postMessage({ command: 'rename', name: target.dataset.name });
                } else if (action === 'killZombies') {
                    vscode.postMessage({ command: 'killZombies', pids: target.dataset.pids });
                }
            });
            document.body.insertAdjacentHTML('beforeend',
                '<div style="color:#4ec44e;font-size:11px;padding:4px 12px;opacity:0.5">JS loaded OK</div>');
        })();
    </script>
</body>
</html>`;
}

// ============================================================
// Status bar helpers
// ============================================================

function getWindowColor(rssKB: number): vscode.ThemeColor | undefined {
    const bytes = rssKB * 1024;
    if (bytes >= THRESHOLD_CRITICAL) {
        return new vscode.ThemeColor('statusBarItem.errorForeground');
    }
    if (bytes >= THRESHOLD_WARNING) {
        return new vscode.ThemeColor('statusBarItem.warningForeground');
    }
    return undefined; // Use default foreground for normal state
}

function getWindowBackground(rssKB: number): vscode.ThemeColor | undefined {
    const bytes = rssKB * 1024;
    if (bytes >= THRESHOLD_CRITICAL) {
        return new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    if (bytes >= THRESHOLD_WARNING) {
        return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
}

function getPressureColor(level: string): string {
    return level === 'Critical' ? '#f44747' : level === 'Warn' ? '#cca700' : '#4ec44e';
}

function generateSparkline(history: number[]): string {
    if (history.length < 2) { return ''; }
    const min = Math.min(...history);
    const max = Math.max(...history);
    const range = max - min || 1;

    // Map each value to a height 0-3 (4 vertical levels per Braille column)
    const heights = history.map(v =>
        Math.min(Math.floor(((v - min) / range) * 4), 3)
    );

    // Braille dot bits for left column heights (bottom-to-top: dots 7,3,2,1)
    const leftBits  = [0, 0x40, 0x44, 0x46, 0x47]; // h=0..4
    // Braille dot bits for right column heights (bottom-to-top: dots 8,6,5,4)
    const rightBits = [0, 0x80, 0xA0, 0xB0, 0xB8]; // h=0..4

    let result = '';
    for (let i = 0; i < heights.length; i += 2) {
        const left = heights[i];
        const right = i + 1 < heights.length ? heights[i + 1] : 0;
        // Each height is 0-3, but our lookup tables go 0-4; add 1 to make bars visible
        result += String.fromCharCode(BRAILLE_BASE | leftBits[left + 1] | rightBits[right + 1]);
    }
    return result;
}

// ============================================================
// Activation
// ============================================================

export function activate(context: vscode.ExtensionContext): void {
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    statusItem.command = 'resourceMonitor.showDashboard';
    statusItem.name = 'Resource Monitor';

    let isVisible = true;
    let dashboardPanel: vscode.WebviewPanel | undefined;
    const memoryHistory: number[] = [];

    // Register self immediately and when editors change
    registerSelf();
    const registryInterval = setInterval(registerSelf, 30000);
    const editorListener = vscode.window.onDidChangeActiveTextEditor(() => registerSelf());

    function updateStatusBar(): void {
        if (!isVisible) { return; }

        // Use the same metric as the dashboard: ext host + children RSS
        const totalKB = getCurrentWindowMemoryKB();
        const rssStr = formatBytes(totalKB * 1024);

        // Track memory history for sparkline
        memoryHistory.push(totalKB);
        if (memoryHistory.length > SPARKLINE_MAX_SAMPLES) { memoryHistory.shift(); }
        const sparkline = generateSparkline(memoryHistory);

        // Combine window memory + system pressure in one item
        const sysInfo = getSystemMemoryInfo();
        const pressureLbl = sysInfo ? ` | ${sysInfo.pressureLevel}` : '';
        statusItem.text = `$(pulse) ${rssStr}${pressureLbl}`;
        statusItem.color = getWindowColor(totalKB);
        statusItem.backgroundColor = getWindowBackground(totalKB);

        // Rich tooltip with sparkline
        const tooltipLines = [`Window: ${rssStr} (footprint)`];
        if (sparkline) { tooltipLines.push(`Trend:  ${sparkline}  (${SPARKLINE_MAX_SAMPLES} samples)`); }
        if (sysInfo) {
            tooltipLines.push(`System: ${formatBytes(sysInfo.appMemoryBytes)} / ${formatBytes(sysInfo.totalBytes)} | Swap: ${formatBytes(sysInfo.swapUsedBytes)}`);
            tooltipLines.push(`Pressure: ${sysInfo.pressureLevel}`);
        }
        tooltipLines.push('Click for dashboard');
        statusItem.tooltip = tooltipLines.join('\n');
        statusItem.show();
    }

    updateStatusBar();
    const statusBarInterval = setInterval(updateStatusBar, STATUS_BAR_POLL_MS);

    // --- Dashboard auto-refresh ---
    let dashboardRefreshInterval: ReturnType<typeof setInterval> | undefined;

    function refreshDashboard(): void {
        if (dashboardPanel) {
            registerSelf();
            dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview);
        }
    }

    function startDashboardAutoRefresh(): void {
        stopDashboardAutoRefresh();
        dashboardRefreshInterval = setInterval(refreshDashboard, DASHBOARD_POLL_MS);
    }

    function stopDashboardAutoRefresh(): void {
        if (dashboardRefreshInterval) {
            clearInterval(dashboardRefreshInterval);
            dashboardRefreshInterval = undefined;
        }
    }

    // --- Dashboard command ---
    const showDashboardCmd = vscode.commands.registerCommand('resourceMonitor.showDashboard', () => {
        registerSelf();

        if (dashboardPanel) {
            dashboardPanel.reveal();
            refreshDashboard();
            return;
        }

        dashboardPanel = vscode.window.createWebviewPanel(
            'resourceMonitor', 'Process Monitor',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview);
        startDashboardAutoRefresh();

        dashboardPanel.webview.onDidReceiveMessage(async (msg: any) => {
            if (msg.command === 'refresh') {
                refreshDashboard();
            } else if (msg.command === 'reloadWindow') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            } else if (msg.command === 'kill') {
                try {
                    process.kill(msg.pid, 'SIGTERM');
                    vscode.window.showInformationMessage(`Process ${msg.pid} terminated.`);
                    setTimeout(refreshDashboard, 1000);
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to kill ${msg.pid}: ${err.message}`);
                }
            } else if (msg.command === 'killWorkspace') {
                try {
                    // Recursively kill the entire process tree (children, grandchildren, etc.)
                    killProcessTree(msg.pid);
                    vscode.window.showInformationMessage(`Workspace "${msg.name}" killed.`);
                } catch { /* ignore */ }
                setTimeout(refreshDashboard, 1500);
            } else if (msg.command === 'killZombies') {
                const pids = (msg.pids as string).split(',').map(Number);
                for (const pid of pids) {
                    try { killProcessTree(pid); }
                    catch { /* ignore */ }
                }
                vscode.window.showInformationMessage(`Killed ${pids.length} zombie workspace(s).`);
                setTimeout(refreshDashboard, 1500);
            } else if (msg.command === 'rename') {
                const newLabel = await vscode.window.showInputBox({
                    prompt: `Label for "${msg.name}"`,
                    placeHolder: 'e.g., Paper annotation, LaTeX project...',
                    value: '',
                });
                if (newLabel !== undefined) {
                    setCustomLabel(msg.name, newLabel);
                    refreshDashboard();
                }
            }
        });

        dashboardPanel.onDidDispose(() => {
            stopDashboardAutoRefresh();
            dashboardPanel = undefined;
        });
    });

    const showDetailsCmd = vscode.commands.registerCommand('resourceMonitor.showDetails', () => {
        vscode.commands.executeCommand('resourceMonitor.showDashboard');
    });

    const toggleCmd = vscode.commands.registerCommand('resourceMonitor.toggle', () => {
        isVisible = !isVisible;
        if (isVisible) {
            updateStatusBar();
            vscode.window.showInformationMessage('Resource Monitor: Enabled');
        } else {
            statusItem.hide();
            vscode.window.showInformationMessage('Resource Monitor: Disabled');
        }
    });

    const refreshCmd = vscode.commands.registerCommand('resourceMonitor.refreshProcesses', () => {
        registerSelf();
        if (dashboardPanel) { dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview); }
    });

    context.subscriptions.push(
        statusItem, editorListener,
        showDashboardCmd, showDetailsCmd, toggleCmd, refreshCmd,
        { dispose: () => { clearInterval(statusBarInterval); clearInterval(registryInterval); stopDashboardAutoRefresh(); } }
    );
}

export function deactivate() {}
