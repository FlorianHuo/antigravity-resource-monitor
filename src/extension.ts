import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

// Non-blocking shell execution to keep the event loop responsive.
// Returns stdout even if the command exits non-zero (common with batched
// commands where sub-commands like footprint may fail due to permissions).
async function execAsync(cmd: string, timeout: number = 3000): Promise<string> {
    try {
        const { stdout } = await execPromise(cmd, { timeout });
        return stdout;
    } catch (err: any) {
        // exec rejects on non-zero exit, but stdout is still available
        if (err.stdout) { return err.stdout; }
        throw err;
    }
}

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
const LEAK_THRESHOLD_KB = 4 * 1024 * 1024; // 4 GB language_server = definitely a leak
const LEAK_CHECK_INTERVAL_MS = 10_000; // Check every 10s
const RELOAD_COOLDOWN_MS = 5 * 60 * 1000; // 5 min after reload

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
    rendererPid?: number;
    timestamp: number;
    lastReloaded?: number;
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
    peakMemKB?: number;
    cpu: number;
    command: string;
    startTime?: number; // epoch seconds from lstart
}

interface ProcessListItem {
    pid: number;
    type: string;
    memKB: number;
    peakMemKB?: number;
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

async function getSystemMemoryInfo(): Promise<SystemMemoryInfo | null> {
    if (process.platform !== 'darwin') { return null; }
    try {
        const totalBytes = os.totalmem();

        // Single shell command gathers ALL system memory data in one process fork
        const batchRaw = await execAsync(
            'echo "===VMSTAT===" && vm_stat 2>/dev/null;'
            + ' echo "===SWAP===" && sysctl vm.swapusage 2>/dev/null;'
            + ' echo "===PRESSURE===" && sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null;'
            + ' echo "===LEVEL===" && sysctl -n kern.memorystatus_level 2>/dev/null;'
            + ' echo "===TRANSITION===" && sysctl -n kern.vm_pressure_level_transition_threshold 2>/dev/null;'
            + ' echo "===MEMPRESSURE===" && memory_pressure 2>/dev/null;'
            + ' echo "===END==="',
            5000
        );

        // Helper to extract section between markers
        const getSection = (start: string, end: string): string => {
            const startIdx = batchRaw.indexOf(start);
            const endIdx = batchRaw.indexOf(end);
            if (startIdx < 0) { return ''; }
            return batchRaw.slice(startIdx + start.length, endIdx >= 0 ? endIdx : undefined).trim();
        };

        // Parse vm_stat
        const vmStatRaw = getSection('===VMSTAT===', '===SWAP===');
        const pageSize = parseInt(vmStatRaw.match(/page size of (\d+)/)?.[1] ?? '16384', 10);
        const getPages = (label: string): number => {
            const match = vmStatRaw.match(new RegExp(`${label}:\\s+(\\d+)`));
            return match ? parseInt(match[1], 10) : 0;
        };
        const appMemoryBytes = (getPages('Pages active') + getPages('Pages wired down') + getPages('Pages occupied by compressor')) * pageSize;
        const wiredBytes = getPages('Pages wired down') * pageSize;
        const compressedBytes = getPages('Pages occupied by compressor') * pageSize;

        // Parse swap
        let swapUsedBytes = 0;
        const swapRaw = getSection('===SWAP===', '===PRESSURE===');
        const swapMatch = swapRaw.match(/used\s*=\s*([\d.]+)([MGK])/);
        if (swapMatch) { swapUsedBytes = parseFloat(swapMatch[1]) * (swapMatch[2] === 'G' ? 1073741824 : swapMatch[2] === 'M' ? 1048576 : 1024); }

        const appRatio = appMemoryBytes / totalBytes;
        const compressedRatio = compressedBytes / totalBytes;
        let nativeSeverity: PressureSeverity | null = null;
        let fallbackSeverity: PressureSeverity = 0;

        // Parse native pressure level (1=normal, 2=warning, 4=critical)
        const pressureRaw = getSection('===PRESSURE===', '===LEVEL===');
        if (pressureRaw) {
            const nativeLevel = parseInt(pressureRaw, 10);
            nativeSeverity = mapNativePressureLevel(nativeLevel);
            if (nativeSeverity !== null) {
                fallbackSeverity = maxSeverity(fallbackSeverity, nativeSeverity);
            }
        }

        // Parse memorystatus_level
        const levelRaw = getSection('===LEVEL===', '===TRANSITION===');
        if (levelRaw) {
            const level = parseInt(levelRaw, 10);
            if (!Number.isNaN(level)) {
                fallbackSeverity = maxSeverity(fallbackSeverity, level <= 15 ? 2 : level <= 40 ? 1 : 0);
            }
        }

        // Parse transition threshold + memory_pressure free percentage
        const transitionRaw = getSection('===TRANSITION===', '===MEMPRESSURE===');
        const memPressureRaw = getSection('===MEMPRESSURE===', '===END===');
        if (transitionRaw && memPressureRaw) {
            const transition = parseInt(transitionRaw, 10);
            const freePct = parseInt(memPressureRaw.match(/System-wide memory free percentage:\s*(\d+)%/)?.[1] ?? '', 10);
            if (!Number.isNaN(transition) && !Number.isNaN(freePct)) {
                const criticalFreePct = Math.max(5, transition - 10);
                fallbackSeverity = maxSeverity(fallbackSeverity, freePct <= criticalFreePct ? 2 : freePct <= transition + 5 ? 1 : 0);
            }
        }

        // Heuristics are only a fallback when the native pressure enum is unavailable.
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

interface TopMemInfo {
    currentKB: number;
    peakKB: number;
}

// Background cache for top-based memory data.
// `footprint` hangs on language_server processes, so we use `top -l 1`
// which reports MEM (matches Activity Monitor) and never hangs.
// The cache refreshes asynchronously so the dashboard is never blocked.
const topMemCache = new Map<number, TopMemInfo>();
let topCacheTime = 0;
let topCacheRefreshing = false;
const TOP_CACHE_TTL_MS = 15_000;

function parseTopMem(s: string): number {
    const m = s.match(/^([\d.]+)(K|M|G)$/);
    if (!m) { return 0; }
    const v = parseFloat(m[1]);
    if (m[2] === 'G') { return Math.round(v * 1024 * 1024); }
    if (m[2] === 'M') { return Math.round(v * 1024); }
    return Math.round(v);
}

async function refreshTopMemCache(): Promise<void> {
    if (topCacheRefreshing || process.platform !== 'darwin') { return; }
    topCacheRefreshing = true;
    try {
        const raw = await execAsync('top -l 1 -stats pid,mem -n 500 2>/dev/null', 12000);
        for (const line of raw.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+([\d.]+[KMG])\s*$/);
            if (!m) { continue; }
            const pid = parseInt(m[1], 10);
            const memKB = parseTopMem(m[2]);
            if (memKB === 0) { continue; }
            const existing = topMemCache.get(pid);
            if (existing) {
                existing.currentKB = memKB;
                existing.peakKB = Math.max(existing.peakKB, memKB);
            } else {
                topMemCache.set(pid, { currentKB: memKB, peakKB: memKB });
            }
        }
        topCacheTime = Date.now();
    } catch { /* top failed, keep stale cache */ }
    finally { topCacheRefreshing = false; }
}

/**
 * Get per-process memory (matches Activity Monitor MEM column) via cached
 * `top` data. Returns immediately with cached data; triggers a background
 * refresh if the cache is stale. Never blocks the caller.
 */
function getTopMem(pids: number[]): Map<number, TopMemInfo> {
    const result = new Map<number, TopMemInfo>();
    // Trigger background refresh if stale (fire-and-forget)
    if (Date.now() - topCacheTime > TOP_CACHE_TTL_MS) {
        refreshTopMemCache();
    }
    for (const pid of pids) {
        const info = topMemCache.get(pid);
        if (info) { result.set(pid, info); }
    }
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

async function scanWorkspaces(): Promise<ScanResult> {
    const registry = readRegistry();

    try {
        // Parse ps with lstart for time-correlation of Renderer/Plugin processes.
        // Format: PID PPID RSS %CPU LSTART(day month dd hh:mm:ss yyyy) COMMAND
        // Timeout increased to 6s because under heavy memory pressure (12+ GB swap)
        // even basic commands like ps can be slow.
        const raw = await execAsync(
            'ps -eo pid,ppid,rss,pcpu,lstart,command | grep -i Antigravity | grep -v grep',
            6000
        );

        const MONTHS: Record<string, number> = {
            Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11
        };
        function parseLstart(dayOfWeek: string, month: string, day: string, time: string, year: string): number {
            const [h, m, s] = time.split(':').map(Number);
            const mon = MONTHS[month] ?? 0;
            return new Date(parseInt(year), mon, parseInt(day), h, m, s).getTime() / 1000;
        }

        const allRawProcs: ProcessInfo[] = [];
        for (const line of raw.split('\n')) {
            if (line.trim() === '') { continue; }
            // PID PPID RSS CPU DAY MONTH DD HH:MM:SS YYYY COMMAND
            const m = line.trim().match(
                /^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\w+)\s+(\w+)\s+(\d+)\s+([\d:]+)\s+(\d{4})\s+(.+)$/
            );
            if (!m) { continue; }
            allRawProcs.push({
                pid: parseInt(m[1], 10),
                ppid: parseInt(m[2], 10),
                rssKB: parseInt(m[3], 10),
                memKB: parseInt(m[3], 10),
                cpu: parseFloat(m[4]),
                startTime: parseLstart(m[5], m[6], m[7], m[8], m[9]),
                command: m[10],
            });
        }

        // Filter to only Antigravity process tree.
        // The grep catches processes from other Electron apps (e.g. Obsidian)
        // if they have "antigravity" anywhere in their command line. We identify
        // the Antigravity main process (PPID=1, not a helper/renderer/gpu) and
        // keep only its descendants (depth 2: main -> helpers -> workers).
        // NOTE: there may be multiple stale/zombie main processes from crashed
        // instances. Pick the one with the most children (= active instance).
        const mainCandidates = allRawProcs.filter(p =>
            p.ppid === 1 && !p.command.includes('--type=')
            && p.command.includes('Antigravity.app')
        );
        let mainProc: ProcessInfo | undefined;
        let maxChildren = -1;
        for (const mc of mainCandidates) {
            const childCount = allRawProcs.filter(p => p.ppid === mc.pid).length;
            if (childCount > maxChildren) {
                maxChildren = childCount;
                mainProc = mc;
            }
        }
        let allProcs: ProcessInfo[];
        if (mainProc) {
            const mainPid = mainProc.pid;
            const validPids = new Set<number>([mainPid]);
            // Depth 1: direct children of main
            for (const p of allRawProcs) {
                if (p.ppid === mainPid) { validPids.add(p.pid); }
            }
            // Depth 2: grandchildren (lang_server, workers under ext hosts)
            for (const p of allRawProcs) {
                if (validPids.has(p.ppid)) { validPids.add(p.pid); }
            }
            allProcs = allRawProcs.filter(p => validPids.has(p.pid));
        } else {
            allProcs = allRawProcs;
        }

        // Use top MEM data for language_server processes to capture leaked memory
        // that is compressed/swapped and invisible to RSS. Without this, a
        // language_server leaking 9 GB appears as only ~100 MB via RSS.
        // getTopMem() is synchronous (reads from cache) and never blocks.
        const lsPids = allProcs
            .filter(p => p.command.includes('language_server'))
            .map(p => p.pid);
        if (lsPids.length > 0) {
            const topMem = getTopMem(lsPids);
            for (const p of allProcs) {
                const tm = topMem.get(p.pid);
                if (tm) {
                    if (tm.currentKB > p.rssKB) { p.memKB = tm.currentKB; }
                    if (tm.peakKB > p.memKB) { p.peakMemKB = tm.peakKB; }
                }
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
                    group.processList.push({ pid: p.pid, type, memKB: p.memKB, peakMemKB: p.peakMemKB, cpu: p.cpu });
                    group.totalMemoryKB += p.memKB;
                    assignedPids.add(p.pid);
                }
            }

            workspaces.push(group);
        }

        // Second pass: attribute Renderer and sibling Plugin processes to
        // workspaces using a 3-phase matching algorithm.
        //
        // KEY INSIGHT: Window Renderers are created at startup (PID near Main)
        // and persist through Reload Window. After reload, new ExtHosts get
        // new PIDs far from the original Renderers. Dynamic Renderers (WebView,
        // panels) are created later with higher PIDs near their ExtHosts.
        //
        // Phase A: Startup Renderers (PID within 100 of Main) -> window Renderers
        //          Take the N largest (N = workspace count), match by PID order.
        // Phase B: Dynamic Renderers (all others) -> nearest ExtHost by PID.
        // Phase C: Sibling Plugin processes -> nearest ExtHost within 200 PIDs.

        const mainPpid = mainProc ? mainProc.pid : 0;
        const sameParentRenderers = allProcs.filter(
            p => !assignedPids.has(p.pid) && p.command.includes('--type=renderer') && p.ppid === mainPpid
        );

        // Phase A: identify startup Renderers and assign to workspaces
        const startupRenderers = sameParentRenderers
            .filter(r => Math.abs(r.pid - mainPpid) <= 100)
            .sort((a, b) => b.memKB - a.memKB); // Largest first
        const windowRenderers = startupRenderers.slice(0, workspaces.length);
        const sortedWindowRenderers = [...windowRenderers].sort((a, b) => a.pid - b.pid);
        const sortedWs = [...workspaces].sort((a, b) => a.extHostPid - b.extHostPid);

        for (let i = 0; i < sortedWindowRenderers.length && i < sortedWs.length; i++) {
            const r = sortedWindowRenderers[i];
            const group = sortedWs[i];
            group.processList.push({ pid: r.pid, type: 'Renderer', memKB: r.memKB, cpu: r.cpu });
            group.totalMemoryKB += r.memKB;
            assignedPids.add(r.pid);
        }

        // Phase B: dynamic Renderers -> nearest workspace ExtHost by PID
        for (const group of sortedWs) {
            let bestRenderer: ProcessInfo | undefined;
            let bestDist = Infinity;
            for (const r of sameParentRenderers) {
                if (assignedPids.has(r.pid)) { continue; }
                const dist = Math.abs(r.pid - group.extHostPid);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestRenderer = r;
                }
            }
            if (bestRenderer) {
                group.processList.push({ pid: bestRenderer.pid, type: 'Renderer', memKB: bestRenderer.memKB, cpu: bestRenderer.cpu });
                group.totalMemoryKB += bestRenderer.memKB;
                assignedPids.add(bestRenderer.pid);
            }
        }

        // Phase C: sibling Plugin processes (same parent, within 200 PIDs)
        for (const group of sortedWs) {
            for (const p of allProcs) {
                if (assignedPids.has(p.pid)) { continue; }
                if (p.ppid !== mainPpid) { continue; }
                if (!p.command.includes('node.mojom.NodeService')) { continue; }
                if (Math.abs(p.pid - group.extHostPid) <= 200) {
                    group.processList.push({ pid: p.pid, type: 'Plugin', memKB: p.memKB, cpu: p.cpu });
                    group.totalMemoryKB += p.memKB;
                    assignedPids.add(p.pid);
                }
            }
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
async function getCurrentWindowMemoryKB(): Promise<number> {
    try {
        const myPid = process.pid;
        const raw = await execAsync('ps -eo pid,ppid,rss', 2000);
        // Build parent->children map and PID->RSS map
        const children: Record<number, number[]> = {};
        const rssOf: Record<number, number> = {};
        for (const line of raw.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
            if (!m) { continue; }
            const pid = parseInt(m[1], 10);
            const ppid = parseInt(m[2], 10);
            rssOf[pid] = parseInt(m[3], 10);
            if (!children[ppid]) { children[ppid] = []; }
            children[ppid].push(pid);
        }
        // Walk full descendant tree from myPid
        let total = rssOf[myPid] || 0;
        const queue = children[myPid] ? [...children[myPid]] : [];
        while (queue.length > 0) {
            const p = queue.pop()!;
            total += rssOf[p] || 0;
            if (children[p]) { queue.push(...children[p]); }
        }
        return total || Math.round(process.memoryUsage().rss / 1024);
    }
    catch {
        return Math.round(process.memoryUsage().rss / 1024);
    }
}

// ============================================================
// WebView dashboard
// ============================================================

/**
 * Generate the static dashboard HTML shell. This is loaded ONCE into the WebView.
 * Subsequent updates are sent via postMessage to avoid full-page reloads.
 */
function generateDashboardShell(): string {
    const nonce = crypto.randomBytes(16).toString('base64');

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
    .kill-all-btn, .close-ws-btn {
        background: transparent; border: 1px solid; border-radius: 3px;
        cursor: pointer; font-size: 11px; padding: 2px 8px;
        opacity: 0; transition: opacity 0.15s;
    }
    .kill-all-btn { color: #f44747; border-color: #f4474755; }
    .close-ws-btn { color: #e0a030; border-color: #e0a03055; }
    .ws-header:hover .kill-all-btn, .ws-header:hover .close-ws-btn { opacity: 0.7; }
    .kill-all-btn:hover { opacity: 1 !important; background: #f4474722; }
    .close-ws-btn:hover { opacity: 1 !important; background: #e0a03022; }
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
    .loading { text-align: center; padding: 40px; opacity: 0.5; }
</style>
</head>
<body>
    <div class="header">
        <div>
            <h2>Antigravity Process Monitor</h2>
            <div class="summary" id="summary">Loading...</div>
        </div>
        <div class="header-actions">
            <span class="auto-refresh-label">Auto-refresh: ${DASHBOARD_POLL_MS / 1000}s</span>
            <button class="refresh-btn" data-action="reloadWindow" style="background:#1389fd">Reload Window</button>
            <button class="refresh-btn" data-action="refresh" style="background:#4ec44e">Refresh</button>
        </div>
    </div>
    <div id="sys-bar-container"></div>
    <div id="zombie-bar-container"></div>
    <div id="workspaces-container"><div class="loading">Scanning processes...</div></div>
    <div id="shared-container"></div>
    <script nonce="${nonce}">
    (function() {
        try {
            var vscode = acquireVsCodeApi();
        } catch(err) {
            document.body.insertAdjacentHTML('beforeend',
                '<pre style="color:red;padding:8px">Script Error: ' + err.message + '</pre>');
            return;
        }

        // Track which workspace details are expanded (preserved across data updates)
        var expandedWorkspaces = {};

        function escapeHtml(s) {
            return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function fmtBytes(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
            if (bytes < 1024*1024*1024) return (bytes/(1024*1024)).toFixed(0) + ' MB';
            return (bytes/(1024*1024*1024)).toFixed(1) + ' GB';
        }

        function renderData(msg) {
            var data = msg.scan;
            var sysInfo = msg.sysInfo;

            // Summary
            document.getElementById('summary').textContent =
                data.workspaces.length + ' workspaces | ' + data.processCount + ' processes | ' + fmtBytes(data.totalMemoryKB * 1024) + ' total (footprint)';

            // System bar
            var sysEl = document.getElementById('sys-bar-container');
            if (sysInfo) {
                var pressureColor = sysInfo.pressureLevel === 'Critical' ? '#f44747'
                    : sysInfo.pressureLevel === 'Warn' ? '#cca700' : '#4ec44e';
                sysEl.innerHTML = '<div class="sys-bar">'
                    + '<span>System: <b>' + fmtBytes(sysInfo.totalBytes) + '</b> RAM</span>'
                    + '<span>App Memory: <b>' + fmtBytes(sysInfo.appMemoryBytes) + '</b></span>'
                    + '<span>Swap: <b>' + fmtBytes(sysInfo.swapUsedBytes) + '</b></span>'
                    + '<span>Pressure: <b style="color:' + pressureColor + '">' + sysInfo.pressureLevel + '</b></span>'
                    + '</div>';
            } else {
                sysEl.innerHTML = '';
            }

            // Zombie bar
            var zombies = data.workspaces.filter(function(ws) { return ws.isZombie; });
            var zombieEl = document.getElementById('zombie-bar-container');
            if (zombies.length > 0) {
                var zombieMemKB = zombies.reduce(function(s,z) { return s + z.totalMemoryKB; }, 0);
                var zombiePids = zombies.map(function(z) { return z.extHostPid; }).join(',');
                zombieEl.innerHTML = '<div class="zombie-bar">'
                    + '<span><b>' + zombies.length + '</b> zombie playground(s) using <b>' + fmtBytes(zombieMemKB * 1024) + '</b> (unnamed, empty)</span>'
                    + '<button class="zombie-kill-btn" data-action="killZombies" data-pids="' + zombiePids + '">Kill All Zombies</button>'
                    + '</div>';
            } else {
                zombieEl.innerHTML = '';
            }

            // Workspace cards
            var wsHtml = '';
            for (var i = 0; i < data.workspaces.length; i++) {
                var ws = data.workspaces[i];
                var memStr = fmtBytes(ws.totalMemoryKB * 1024);
                var memPct = data.totalMemoryKB > 0
                    ? ((ws.totalMemoryKB / data.totalMemoryKB) * 100).toFixed(1) : '0';
                var barColor = ws.totalMemoryKB > 500*1024 ? '#f44747'
                    : ws.totalMemoryKB > 200*1024 ? '#cca700' : '#4ec44e';
                var barWidth = data.totalMemoryKB > 0
                    ? Math.max(2, (ws.totalMemoryKB / data.totalMemoryKB) * 100) : 0;

                var isExpanded = expandedWorkspaces[ws.name] || false;

                var procHtml = '';
                for (var j = 0; j < ws.processList.length; j++) {
                    var p = ws.processList[j];
                    var pMem = p.memKB >= 1024*1024 ? (p.memKB/(1024*1024)).toFixed(1)+' GB' : (p.memKB/1024).toFixed(0)+' MB';
                    var peakStr = '';
                    if (p.peakMemKB && p.peakMemKB > p.memKB * 1.5) {
                        var peakFmt = p.peakMemKB >= 1024*1024 ? (p.peakMemKB/(1024*1024)).toFixed(1)+' GB' : (p.peakMemKB/1024).toFixed(0)+' MB';
                        peakStr = ' <span style="color:#f44747;opacity:0.7;font-size:11px">(peak ' + peakFmt + ')</span>';
                    }
                    procHtml += '<div class="proc-row">'
                        + '<span class="proc-type">' + escapeHtml(p.type) + '</span>'
                        + '<span class="proc-mem">' + pMem + peakStr + '</span>'
                        + '<span class="proc-cpu">' + p.cpu.toFixed(1) + '%</span>'
                        + '<span class="proc-pid">PID ' + p.pid + '</span>'
                        + '<button class="kill-btn" data-action="kill" data-pid="' + p.pid + '" title="Kill">x</button>'
                        + '</div>';
                }

                var subtitleHtml = ws.subtitle
                    ? '<div class="ws-subtitle" data-action="rename" data-name="' + escapeHtml(ws.name) + '">' + escapeHtml(ws.subtitle) + '</div>'
                    : '<div class="ws-subtitle ws-subtitle-empty" data-action="rename" data-name="' + escapeHtml(ws.name) + '">click to label</div>';

                var allWsPids = ws.processList.map(function(p) { return p.pid; }).join(',');
                wsHtml += '<div class="ws-card' + (ws.isZombie ? ' zombie' : '') + '" data-ws-name="' + escapeHtml(ws.name) + '">'
                    + '<div class="ws-header">'
                    + '<div class="ws-info"><div class="ws-name">' + escapeHtml(ws.name) + '</div>' + subtitleHtml + '</div>'
                    + '<div class="ws-stats"><span class="ws-mem">' + memStr + '</span><span class="ws-pct">' + memPct + '%</span>'
                    + '<button class="close-ws-btn" data-action="closeWorkspace" data-pids="' + allWsPids + '" data-name="' + escapeHtml(ws.name) + '" title="Close workspace (kill all processes)">Close</button>'
                    + '</div></div>'
                    + '<div class="ws-bar-track"><div class="ws-bar-fill" style="width:' + barWidth + '%;background:' + barColor + '"></div></div>'
                    + '<div class="ws-details' + (isExpanded ? '' : ' hidden') + '">' + procHtml + '</div>'
                    + '</div>';
            }
            document.getElementById('workspaces-container').innerHTML = wsHtml;

            // Shared processes card
            var sharedStr = fmtBytes(data.sharedMemoryKB * 1024);
            var sharedPct = data.totalMemoryKB > 0 ? ((data.sharedMemoryKB / data.totalMemoryKB) * 100).toFixed(1) : '0';
            var sharedBarW = data.totalMemoryKB > 0 ? Math.max(2, (data.sharedMemoryKB / data.totalMemoryKB) * 100) : 0;
            var sharedIsExpanded = expandedWorkspaces['__shared__'] || false;
            var sharedProcHtml = '';
            for (var k = 0; k < data.sharedProcesses.length; k++) {
                var sp = data.sharedProcesses[k];
                var spMem = fmtBytes(sp.memKB * 1024);
                sharedProcHtml += '<div class="proc-row">'
                    + '<span class="proc-type">' + escapeHtml(sp.type) + '</span>'
                    + '<span class="proc-mem">' + spMem + '</span>'
                    + '<span class="proc-cpu">' + sp.cpu.toFixed(1) + '%</span>'
                    + '<span class="proc-pid">PID ' + sp.pid + '</span>'
                    + '<button class="kill-btn" data-action="kill" data-pid="' + sp.pid + '" title="Kill">x</button>'
                    + '</div>';
            }
            document.getElementById('shared-container').innerHTML =
                '<div class="ws-card" style="opacity:0.7" data-ws-name="__shared__">'
                + '<div class="ws-header"><div class="ws-info"><div class="ws-name">Shared Processes</div>'
                + '<div class="ws-subtitle">main, GPU, renderers, utilities</div></div>'
                + '<div class="ws-stats"><span class="ws-mem">' + sharedStr + '</span><span class="ws-pct">' + sharedPct + '%</span></div></div>'
                + '<div class="ws-bar-track"><div class="ws-bar-fill" style="width:' + sharedBarW + '%;background:#888"></div></div>'
                + '<div class="ws-details' + (sharedIsExpanded ? '' : ' hidden') + '">' + sharedProcHtml + '</div>'
                + '</div>';
        }

        // Listen for data updates from the extension
        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (msg.command === 'updateData') {
                renderData(msg);
            }
        });

        // Handle clicks (delegated)
        document.addEventListener('click', function(e) {
            var target = e.target;
            var action = target.dataset ? target.dataset.action : null;
            if (!action) {
                var header = target.closest('.ws-header');
                if (header) {
                    var card = header.parentElement;
                    var details = card ? card.querySelector('.ws-details') : null;
                    if (details) {
                        details.classList.toggle('hidden');
                        // Remember expand state
                        var wsName = card.dataset.wsName;
                        if (wsName) {
                            expandedWorkspaces[wsName] = !details.classList.contains('hidden');
                        }
                    }
                }
                return;
            }
            e.stopPropagation();
            if (action === 'refresh') {
                document.getElementById('summary').textContent = 'Refreshing...';
                vscode.postMessage({ command: 'refresh' });
            } else if (action === 'reloadWindow') {
                vscode.postMessage({ command: 'reloadWindow' });
            } else if (action === 'kill') {
                vscode.postMessage({ command: 'kill', pid: parseInt(target.dataset.pid) });
            } else if (action === 'killWorkspace') {
                vscode.postMessage({ command: 'killWorkspace', pid: parseInt(target.dataset.pid), name: target.dataset.name });
            } else if (action === 'closeWorkspace') {
                vscode.postMessage({ command: 'closeWorkspace', pids: target.dataset.pids, name: target.dataset.name });
            } else if (action === 'rename') {
                vscode.postMessage({ command: 'rename', name: target.dataset.name });
            } else if (action === 'killZombies') {
                vscode.postMessage({ command: 'killZombies', pids: target.dataset.pids });
            }
        });

        // Request initial data
        vscode.postMessage({ command: 'refresh' });
    })();
    </script>
</body>
</html>`;
}

/**
 * Gather dashboard data and send it to the WebView via postMessage.
 * This avoids full-page reloads, keeping button responsiveness instant.
 */
async function sendDashboardData(panel: vscode.WebviewPanel): Promise<void> {
    // Run data gathering in parallel for faster response
    const [data, sysInfo] = await Promise.all([scanWorkspaces(), getSystemMemoryInfo()]);
    // Only push if scan returned real data; skip empty results to preserve
    // the last known good state (avoids dashboard flashing to "0 workspaces")
    if (data.processCount > 0) {
        panel.webview.postMessage({
            command: 'updateData',
            scan: data,
            sysInfo: sysInfo,
        });
    }
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
// Auto-reload on language_server memory leak
// ============================================================

// The first AI conversation in a cold workspace triggers a memory leak
// in language_server_macos_arm. Reloading the window AFTER the leak
// clears it; subsequent conversations don't leak. This watchdog polls
// language_server RSS and auto-reloads when it exceeds the threshold.
function startLeakWatchdog(): void {
    let lastReloaded = 0;

    // Check registry for recent reload to avoid reload-on-startup loops
    try {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            const registry = readRegistry();
            const entry = registry.entries[folders[0].name];
            if (entry?.lastReloaded) { lastReloaded = entry.lastReloaded; }
        }
    } catch { /* ignore */ }

    const watchdogInterval = setInterval(async () => {
        // Cooldown check
        if (Date.now() - lastReloaded < RELOAD_COOLDOWN_MS) { return; }

        try {
            // Get language_server RSS for this workspace's ExtHost PID
            const myPid = process.pid;
            const raw = await execAsync(
                `ps -eo pid,ppid,rss,command | grep language_server_macos_arm | grep -v grep`,
                3000
            );
            // Find language_server whose parent chain includes our ExtHost
            // Simple heuristic: find one with PID close to ours (within 500)
            let maxRssKB = 0;
            for (const line of raw.trim().split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 4) { continue; }
                const pid = parseInt(parts[0]);
                const rssKB = parseInt(parts[2]);
                // Check PID proximity to our ExtHost (language_server is a sibling)
                if (Math.abs(pid - myPid) < 500 && rssKB > maxRssKB) {
                    maxRssKB = rssKB;
                }
            }

            if (maxRssKB > LEAK_THRESHOLD_KB) {
                clearInterval(watchdogInterval);
                // Mark as reloaded to prevent loop
                try {
                    const folders = vscode.workspace.workspaceFolders;
                    if (folders && folders.length > 0) {
                        const reg = readRegistry();
                        const fn = folders[0].name;
                        if (reg.entries[fn]) {
                            reg.entries[fn].lastReloaded = Date.now();
                        } else {
                            reg.entries[fn] = {
                                folderName: fn, openEditors: [], customLabel: '',
                                detectedTitle: '', pid: myPid, timestamp: Date.now(),
                                lastReloaded: Date.now(),
                            };
                        }
                        writeRegistry(reg);
                    }
                } catch { /* ignore */ }
                vscode.window.showWarningMessage(
                    `Language server leak detected (${Math.round(maxRssKB/1024)} MB). Auto-reloading...`
                );
                setTimeout(() => {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }, 2000); // Give user 2s to see the warning
            }
        } catch { /* ps failed, skip this cycle */ }
    }, LEAK_CHECK_INTERVAL_MS);
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
    refreshTopMemCache(); // Eagerly populate top MEM cache for accurate dashboard
    startLeakWatchdog();
    const registryInterval = setInterval(registerSelf, 30000);
    const editorListener = vscode.window.onDidChangeActiveTextEditor(() => registerSelf());

    let statusBarUpdating = false;
    async function updateStatusBar(): Promise<void> {
        if (!isVisible || statusBarUpdating) { return; }
        statusBarUpdating = true;
        try {
        // Use the same metric as the dashboard: ext host + children RSS
        const totalKB = await getCurrentWindowMemoryKB();
        const rssStr = formatBytes(totalKB * 1024);

        // Track memory history for sparkline
        memoryHistory.push(totalKB);
        if (memoryHistory.length > SPARKLINE_MAX_SAMPLES) { memoryHistory.shift(); }
        const sparkline = generateSparkline(memoryHistory);

        // Combine window memory + system pressure in one item
        const sysInfo = await getSystemMemoryInfo();
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
        } catch { /* swallow errors to keep timer alive */ }
        finally { statusBarUpdating = false; }
    }

    updateStatusBar();
    const statusBarInterval = setInterval(updateStatusBar, STATUS_BAR_POLL_MS);

    // --- Dashboard auto-refresh ---
    let dashboardRefreshInterval: ReturnType<typeof setInterval> | undefined;

    let dashboardRefreshing = false;
    async function refreshDashboard(): Promise<void> {
        if (!dashboardPanel || dashboardRefreshing) { return; }
        dashboardRefreshing = true;
        try {
            registerSelf();
            await sendDashboardData(dashboardPanel);
        } catch { /* swallow */ }
        finally { dashboardRefreshing = false; }
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
    const showDashboardCmd = vscode.commands.registerCommand('resourceMonitor.showDashboard', async () => {
        registerSelf();

        if (dashboardPanel) {
            dashboardPanel.reveal();
            refreshDashboard();
            return;
        }

        // Pre-fetch data while the WebView is initializing (runs in parallel)
        const dataPromise = Promise.all([scanWorkspaces(), getSystemMemoryInfo()]);

        dashboardPanel = vscode.window.createWebviewPanel(
            'resourceMonitor', 'Process Monitor',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        dashboardPanel.webview.html = generateDashboardShell();
        startDashboardAutoRefresh();

        // Send pre-fetched data immediately (no waiting for WebView JS init or 5s timer)
        dataPromise.then(([scan, sysInfo]) => {
            if (dashboardPanel && scan.processCount > 0) {
                dashboardPanel.webview.postMessage({ command: 'updateData', scan, sysInfo });
            }
        }).catch(() => { /* swallow, auto-refresh will retry */ });

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
                    killProcessTree(msg.pid);
                    vscode.window.showInformationMessage(`Workspace "${msg.name}" killed.`);
                } catch { /* ignore */ }
                setTimeout(refreshDashboard, 1500);
            } else if (msg.command === 'closeWorkspace') {
                // Kill ALL processes atomically in one shell command
                // to prevent Antigravity from respawning them between kills
                const pids = (msg.pids as string).split(',').map(Number);
                try {
                    execSync(`kill -9 ${pids.join(' ')} 2>/dev/null; true`, { timeout: 3000 });
                } catch { /* some may already be dead */ }
                // Second pass: catch any children that were missed
                setTimeout(() => {
                    for (const pid of pids) {
                        try { killProcessTree(pid); } catch { /* ignore */ }
                    }
                }, 500);
                // Clean up registry entry
                try {
                    const registry = readRegistry();
                    if (registry.entries[msg.name]) {
                        delete registry.entries[msg.name];
                        writeRegistry(registry);
                    }
                } catch { /* ignore */ }
                vscode.window.showInformationMessage(`Workspace "${msg.name}" closed (${pids.length} processes killed).`);
                setTimeout(refreshDashboard, 2000);
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

    const refreshCmd = vscode.commands.registerCommand('resourceMonitor.refreshProcesses', async () => {
        registerSelf();
        if (dashboardPanel) { await sendDashboardData(dashboardPanel); }
    });

    context.subscriptions.push(
        statusItem, editorListener,
        showDashboardCmd, showDetailsCmd, toggleCmd, refreshCmd,
        { dispose: () => { clearInterval(statusBarInterval); clearInterval(registryInterval); stopDashboardAutoRefresh(); } }
    );
}

export function deactivate() {}
