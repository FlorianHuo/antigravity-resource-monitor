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
const REGISTRY_PATH = path.join(os.homedir(), '.gemini', 'antigravity', '.resource-monitor-registry.json');

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

// ============================================================
// Self-registration
// ============================================================

interface RegistryData {
    entries: Record<string, {
        folderName: string;
        openEditors: string[];
        customLabel: string;    // User-defined label (persists across reloads)
        detectedTitle: string;  // Auto-detected from Antigravity extension API
        pid: number;
        timestamp: number;
    }>;
}

function readRegistry(): RegistryData {
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
    } catch { /* ignore */ }
    return { entries: {} };
}

function writeRegistry(data: RegistryData): void {
    try {
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
    } catch { /* ignore */ }
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
                    } catch { continue; }
                }
            } catch { continue; }
        }
    } catch { /* ignore */ }

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
        } catch { /* tabGroups API may not be available */ }

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
        } catch { /* API not available */ }

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
            } catch { /* ignore */ }
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
    } catch { /* Never let registration crash activation */ }
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

// ============================================================
// System memory (macOS)
// ============================================================

interface SystemMemoryInfo {
    totalBytes: number;
    pressureLevel: string;
    appMemoryBytes: number;
    wiredBytes: number;
    compressedBytes: number;
    swapUsedBytes: number;
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
        } catch { /* ignore */ }

        const appRatio = appMemoryBytes / totalBytes;
        const swapGB = swapUsedBytes / 1073741824;
        const pressureLevel = appRatio > 0.90 || swapGB > 8 ? 'Critical'
            : appRatio > 0.75 || swapGB > 4 ? 'Warn' : 'Normal';

        return { totalBytes, pressureLevel, appMemoryBytes, wiredBytes, compressedBytes, swapUsedBytes };
    } catch { return null; }
}

// ============================================================
// Process scanning
// ============================================================

interface WorkspaceGroup {
    name: string;
    workspaceId: string;
    subtitle: string;
    isZombie: boolean;
    extHostPid: number;
    totalMemoryKB: number;
    processList: { pid: number; type: string; rssKB: number; cpu: number }[];
}

function scanWorkspaces(): { workspaces: WorkspaceGroup[]; sharedMemoryKB: number; totalMemoryKB: number; processCount: number } {
    const registry = readRegistry();

    try {
        const raw = execSync(
            'ps -eo pid,ppid,rss,pcpu,command | grep -i Antigravity | grep -v grep',
            { encoding: 'utf8', timeout: 3000 }
        );

        const allProcs: { pid: number; ppid: number; rssKB: number; cpu: number; command: string }[] = [];
        for (const line of raw.split('\n')) {
            if (line.trim() === '') { continue; }
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
            if (!m) { continue; }
            allProcs.push({
                pid: parseInt(m[1], 10),
                ppid: parseInt(m[2], 10),
                rssKB: parseInt(m[3], 10),
                cpu: parseFloat(m[4]),
                command: m[5],
            });
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
                    group.processList.push({ pid: p.pid, type: 'Extension Host', rssKB: p.rssKB, cpu: p.cpu });
                    group.totalMemoryKB += p.rssKB;
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
                    group.processList.push({ pid: p.pid, type, rssKB: p.rssKB, cpu: p.cpu });
                    group.totalMemoryKB += p.rssKB;
                    assignedPids.add(p.pid);
                }
            }

            workspaces.push(group);
        }

        let sharedMemoryKB = 0;
        for (const p of allProcs) {
            if (!assignedPids.has(p.pid)) { sharedMemoryKB += p.rssKB; }
        }

        workspaces.sort((a, b) => b.totalMemoryKB - a.totalMemoryKB);
        const totalMemoryKB = allProcs.reduce((sum, p) => sum + p.rssKB, 0);
        return { workspaces, sharedMemoryKB, totalMemoryKB, processCount: allProcs.length };
    } catch {
        return { workspaces: [], sharedMemoryKB: 0, totalMemoryKB: 0, processCount: 0 };
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
        const raw = execSync(
            `ps -eo pid,ppid,rss | grep -v grep`,
            { encoding: 'utf8', timeout: 2000 }
        );
        let total = 0;
        for (const line of raw.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
            if (!m) { continue; }
            const pid = parseInt(m[1], 10);
            const ppid = parseInt(m[2], 10);
            const rss = parseInt(m[3], 10);
            if (pid === myPid || ppid === myPid) {
                total += rss;
            }
        }
        return total || Math.round(process.memoryUsage().rss / 1024);
    } catch {
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

    const totalMB = (data.totalMemoryKB / 1024).toFixed(0);
    const sharedMB = (data.sharedMemoryKB / 1024).toFixed(0);

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
        const memMB = (ws.totalMemoryKB / 1024).toFixed(0);
        const memPercent = data.totalMemoryKB > 0
            ? ((ws.totalMemoryKB / data.totalMemoryKB) * 100).toFixed(1) : '0';
        const barColor = ws.totalMemoryKB > 500 * 1024 ? '#f44747'
            : ws.totalMemoryKB > 200 * 1024 ? '#cca700' : '#4ec44e';
        const barWidth = data.totalMemoryKB > 0
            ? Math.max(2, (ws.totalMemoryKB / data.totalMemoryKB) * 100) : 0;

        const procRows = ws.processList.map(p => `
            <div class="proc-row">
                <span class="proc-type">${p.type}</span>
                <span class="proc-mem">${(p.rssKB / 1024).toFixed(0)} MB</span>
                <span class="proc-cpu">${p.cpu.toFixed(1)}%</span>
                <span class="proc-pid">PID ${p.pid}</span>
                <button class="kill-btn" data-action="kill" data-pid="${p.pid}" title="Kill">x</button>
            </div>
        `).join('');

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
                    <span class="ws-mem">${memMB} MB</span>
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
        const zombieMB = (zombies.reduce((s, z) => s + z.totalMemoryKB, 0) / 1024).toFixed(0);
        const pids = zombies.map(z => z.extHostPid).join(',');
        zombieBar = `<div class="zombie-bar">
            <span><b>${zombies.length}</b> zombie playground(s) using <b>${zombieMB} MB</b> (unnamed, empty)</span>
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
    .header-actions { display: flex; gap: 8px; }
</style>
</head>
<body>
    <div class="header">
        <div>
            <h2>Antigravity Process Monitor</h2>
            <div class="summary">${data.workspaces.length} workspaces | ${data.processCount} processes | ${totalMB} MB total</div>
        </div>
        <div class="header-actions">
            <button class="refresh-btn" data-action="refresh">Refresh</button>
        </div>
    </div>
    ${sysBar}
    ${zombieBar}
    ${wsRows}
    <div class="shared-row">
        <span>Shared (main, GPU, renderers, utilities)</span>
        <span>${sharedMB} MB</span>
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
                var target = e.target;
                var action = target.dataset ? target.dataset.action : null;
                if (!action) {
                    var header = target.closest('.ws-header');
                    if (header) {
                        var details = header.parentElement.querySelector('.ws-details');
                        if (details) { details.classList.toggle('hidden'); }
                    }
                    return;
                }
                e.stopPropagation();
                if (action === 'refresh') {
                    vscode.postMessage({ command: 'refresh' });
                } else if (action === 'kill') {
                    vscode.postMessage({ command: 'kill', pid: parseInt(target.dataset.pid) });
                } else if (action === 'killWorkspace') {
                    vscode.postMessage({ command: 'killWorkspace', pid: parseInt(target.dataset.pid), name: target.dataset.name });
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

function getWindowColor(rssKB: number): vscode.ThemeColor | string {
    const bytes = rssKB * 1024;
    if (bytes >= THRESHOLD_CRITICAL) { return new vscode.ThemeColor('statusBarItem.errorForeground'); }
    if (bytes >= THRESHOLD_WARNING) { return new vscode.ThemeColor('statusBarItem.warningForeground'); }
    return '#4ec44e';
}

function getWindowBackground(rssKB: number): vscode.ThemeColor | undefined {
    const bytes = rssKB * 1024;
    if (bytes >= THRESHOLD_CRITICAL) { return new vscode.ThemeColor('statusBarItem.errorBackground'); }
    if (bytes >= THRESHOLD_WARNING) { return new vscode.ThemeColor('statusBarItem.warningBackground'); }
    return undefined;
}

function getPressureColor(level: string): string {
    return level === 'Critical' ? '#f44747' : level === 'Warn' ? '#cca700' : '#4ec44e';
}

// ============================================================
// Activation
// ============================================================

export function activate(context: vscode.ExtensionContext) {
    const windowItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    windowItem.command = 'resourceMonitor.showDashboard';
    windowItem.name = 'Window Memory';

    const systemItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
    systemItem.command = 'resourceMonitor.showDashboard';
    systemItem.name = 'System Memory';

    let isVisible = true;
    let dashboardPanel: vscode.WebviewPanel | undefined;

    // Register self immediately and when editors change
    registerSelf();
    const registryInterval = setInterval(registerSelf, 30000);
    const editorListener = vscode.window.onDidChangeActiveTextEditor(() => registerSelf());

    function updateStatusBar(): void {
        if (!isVisible) { return; }

        // Use the same metric as the dashboard: ext host + children RSS
        const totalKB = getCurrentWindowMemoryKB();
        const rssStr = formatBytes(totalKB * 1024);
        windowItem.text = `$(pulse) ${rssStr}`;
        windowItem.color = getWindowColor(totalKB);
        windowItem.backgroundColor = getWindowBackground(totalKB);
        windowItem.tooltip = `This Window: ${rssStr} (ext host + children)\nClick for dashboard`;
        windowItem.show();

        const sysInfo = getSystemMemoryInfo();
        if (sysInfo) {
            systemItem.text = `$(server) ${sysInfo.pressureLevel}`;
            systemItem.color = getPressureColor(sysInfo.pressureLevel);
            systemItem.backgroundColor = sysInfo.pressureLevel === 'Critical'
                ? new vscode.ThemeColor('statusBarItem.errorBackground')
                : sysInfo.pressureLevel === 'Warn'
                    ? new vscode.ThemeColor('statusBarItem.warningBackground')
                    : undefined;
            systemItem.tooltip = `System Memory Pressure: ${sysInfo.pressureLevel}`;
            systemItem.show();
        }
    }

    updateStatusBar();
    const statusBarInterval = setInterval(updateStatusBar, STATUS_BAR_POLL_MS);

    // --- Dashboard command ---
    const showDashboardCmd = vscode.commands.registerCommand('resourceMonitor.showDashboard', () => {
        registerSelf();

        if (dashboardPanel) {
            dashboardPanel.reveal();
            dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview);
            return;
        }

        dashboardPanel = vscode.window.createWebviewPanel(
            'resourceMonitor', 'Process Monitor',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview);

        dashboardPanel.webview.onDidReceiveMessage(async (msg: any) => {
            if (msg.command === 'refresh') {
                registerSelf();
                if (dashboardPanel) { dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview); }
            } else if (msg.command === 'kill') {
                try {
                    process.kill(msg.pid, 'SIGTERM');
                    vscode.window.showInformationMessage(`Process ${msg.pid} terminated.`);
                    setTimeout(() => {
                        if (dashboardPanel) { dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview); }
                    }, 1000);
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to kill ${msg.pid}: ${err.message}`);
                }
            } else if (msg.command === 'killWorkspace') {
                const confirm = await vscode.window.showWarningMessage(
                    `Kill workspace "${msg.name}"? This terminates the extension host and all child processes.`,
                    'Kill'
                );
                if (confirm === 'Kill') {
                    try {
                        process.kill(msg.pid, 'SIGTERM');
                        vscode.window.showInformationMessage(`Workspace "${msg.name}" terminated.`);
                        setTimeout(() => {
                            if (dashboardPanel) { dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview); }
                        }, 2000);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to kill: ${err.message}`);
                    }
                }
            } else if (msg.command === 'killZombies') {
                const pids = (msg.pids as string).split(',').map(Number);
                const confirm = await vscode.window.showWarningMessage(
                    `Kill ${pids.length} zombie playground(s)? These are empty workspaces with no identified purpose.`,
                    'Kill All'
                );
                if (confirm === 'Kill All') {
                    let killed = 0;
                    for (const pid of pids) {
                        try {
                            process.kill(pid, 'SIGTERM');
                            killed++;
                        } catch { /* ignore */ }
                    }
                    vscode.window.showInformationMessage(`Killed ${killed} zombie workspace(s).`);
                    setTimeout(() => {
                        if (dashboardPanel) { dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview); }
                    }, 2000);
                }
            } else if (msg.command === 'rename') {
                const newLabel = await vscode.window.showInputBox({
                    prompt: `Label for "${msg.name}"`,
                    placeHolder: 'e.g., Paper annotation, LaTeX project...',
                    value: '',
                });
                if (newLabel !== undefined) {
                    setCustomLabel(msg.name, newLabel);
                    if (dashboardPanel) { dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview); }
                }
            }
        });

        dashboardPanel.onDidDispose(() => { dashboardPanel = undefined; });
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
            windowItem.hide();
            systemItem.hide();
            vscode.window.showInformationMessage('Resource Monitor: Disabled');
        }
    });

    const refreshCmd = vscode.commands.registerCommand('resourceMonitor.refreshProcesses', () => {
        registerSelf();
        if (dashboardPanel) { dashboardPanel.webview.html = generateDashboardHtml(dashboardPanel.webview); }
    });

    context.subscriptions.push(
        windowItem, systemItem, editorListener,
        showDashboardCmd, showDetailsCmd, toggleCmd, refreshCmd,
        { dispose: () => { clearInterval(statusBarInterval); clearInterval(registryInterval); } },
    );
}

export function deactivate() {}
