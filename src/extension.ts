import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as os from 'os';

// Memory threshold constants for per-window RSS (in bytes)
const THRESHOLD_WARNING = 1 * 1024 * 1024 * 1024;  // 1 GB
const THRESHOLD_CRITICAL = 2 * 1024 * 1024 * 1024; // 2 GB

// Polling interval in milliseconds
const POLL_INTERVAL_MS = 3000;

/**
 * Format bytes to a human-readable string with appropriate unit.
 */
function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
}

// ---------- macOS system memory pressure ----------

interface SystemMemoryInfo {
    totalBytes: number;       // Total physical RAM
    pressureLevel: string;    // 'Normal' | 'Warn' | 'Critical'
    appMemoryBytes: number;   // App memory (wired + app purgeable + compressor)
    wiredBytes: number;       // Wired (non-evictable kernel/system)
    compressedBytes: number;  // Compressed memory
    swapUsedBytes: number;    // Swap used on disk
}

/**
 * Parse macOS vm_stat output and sysctl to determine real memory pressure.
 *
 * macOS memory model:
 *   - "Used" memory includes file caches which are instantly reclaimable
 *   - Real pressure comes from: high app memory + compression + swap usage
 *   - The `memory_pressure` CLI gives a direct pressure level from the kernel
 */
function getSystemMemoryInfo(): SystemMemoryInfo | null {
    if (process.platform !== 'darwin') {
        return null;
    }

    try {
        const totalBytes = os.totalmem();

        // Parse vm_stat for page-level stats
        const vmStatRaw = execSync('vm_stat', { encoding: 'utf8', timeout: 2000 });
        const pageSize = parseInt(vmStatRaw.match(/page size of (\d+)/)?.[1] ?? '16384', 10);

        // Helper to extract a page count from vm_stat output
        const getPages = (label: string): number => {
            const match = vmStatRaw.match(new RegExp(`${label}:\\s+(\\d+)`));
            return match ? parseInt(match[1], 10) : 0;
        };

        const wiredPages = getPages('Pages wired down');
        const compressorPages = getPages('Pages occupied by compressor');
        const activePages = getPages('Pages active');
        const inactivePages = getPages('Pages inactive');

        const wiredBytes = wiredPages * pageSize;
        const compressedBytes = compressorPages * pageSize;
        // App memory approximation: active + wired + compressor
        const appMemoryBytes = (activePages + wiredPages + compressorPages) * pageSize;

        // Get swap usage from sysctl
        let swapUsedBytes = 0;
        try {
            const swapRaw = execSync('sysctl vm.swapusage', { encoding: 'utf8', timeout: 2000 });
            const swapUsedMatch = swapRaw.match(/used\s*=\s*([\d.]+)([MGK])/);
            if (swapUsedMatch) {
                const val = parseFloat(swapUsedMatch[1]);
                const unit = swapUsedMatch[2];
                swapUsedBytes = val * (unit === 'G' ? 1024 * 1024 * 1024
                    : unit === 'M' ? 1024 * 1024 : 1024);
            }
        } catch {
            // Ignore swap read errors
        }

        // Determine pressure level based on practical heuristics:
        //   - Normal: app memory < 75% of total, swap < 4 GB
        //   - Warn: app memory 75-90% of total, or swap 4-8 GB
        //   - Critical: app memory > 90% of total, or swap > 8 GB
        const appRatio = appMemoryBytes / totalBytes;
        const swapGB = swapUsedBytes / (1024 * 1024 * 1024);

        let pressureLevel: string;
        if (appRatio > 0.90 || swapGB > 8) {
            pressureLevel = 'Critical';
        } else if (appRatio > 0.75 || swapGB > 4) {
            pressureLevel = 'Warn';
        } else {
            pressureLevel = 'Normal';
        }

        return {
            totalBytes,
            pressureLevel,
            appMemoryBytes,
            wiredBytes,
            compressedBytes,
            swapUsedBytes,
        };
    } catch {
        return null;
    }
}

/**
 * Get color for the system memory pressure indicator.
 */
function getPressureColor(level: string): string {
    switch (level) {
        case 'Critical': return '#f44747';  // Red
        case 'Warn': return '#cca700';      // Yellow
        default: return '#89d185';          // Green
    }
}

/**
 * Get codicon for pressure level.
 */
function getPressureIcon(level: string): string {
    switch (level) {
        case 'Critical': return '$(error)';
        case 'Warn': return '$(warning)';
        default: return '$(check)';
    }
}

// ---------- Per-window memory helpers ----------

function getWindowColor(rss: number): vscode.ThemeColor | string {
    if (rss >= THRESHOLD_CRITICAL) {
        return new vscode.ThemeColor('statusBarItem.errorForeground');
    } else if (rss >= THRESHOLD_WARNING) {
        return new vscode.ThemeColor('statusBarItem.warningForeground');
    }
    return '#89d185';
}

function getWindowBackground(rss: number): vscode.ThemeColor | undefined {
    if (rss >= THRESHOLD_CRITICAL) {
        return new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (rss >= THRESHOLD_WARNING) {
        return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
}

// ---------- Activation ----------

export function activate(context: vscode.ExtensionContext) {
    // --- Status bar item 1: per-window memory (right side) ---
    const windowItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 50
    );
    windowItem.command = 'resourceMonitor.showDetails';
    windowItem.name = 'Window Memory';

    // --- Status bar item 2: system memory pressure (right side, next to window item) ---
    const systemItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 49
    );
    systemItem.command = 'resourceMonitor.showDetails';
    systemItem.name = 'System Memory';

    let isVisible = true;

    /**
     * Update both status bar items.
     */
    function updateDisplay(): void {
        if (!isVisible) {
            return;
        }

        // --- Per-window memory ---
        const mem = process.memoryUsage();
        const rssStr = formatBytes(mem.rss);
        windowItem.text = `$(pulse) ${rssStr}`;
        windowItem.color = getWindowColor(mem.rss);
        windowItem.backgroundColor = getWindowBackground(mem.rss);

        const windowTooltip = new vscode.MarkdownString('', true);
        windowTooltip.isTrusted = true;
        windowTooltip.appendMarkdown(`### $(pulse) Window Memory: ${rssStr}\n\n`);
        windowTooltip.appendMarkdown(`_This window's extension host process_\n\n`);
        windowTooltip.appendMarkdown(`_Click for full details_`);
        windowItem.tooltip = windowTooltip;
        windowItem.show();

        // --- System memory pressure (macOS only) ---
        const sysInfo = getSystemMemoryInfo();
        if (sysInfo) {
            const icon = getPressureIcon(sysInfo.pressureLevel);
            systemItem.text = `$(server) ${sysInfo.pressureLevel}`;
            systemItem.color = getPressureColor(sysInfo.pressureLevel);
            systemItem.backgroundColor = sysInfo.pressureLevel === 'Critical'
                ? new vscode.ThemeColor('statusBarItem.errorBackground')
                : sysInfo.pressureLevel === 'Warn'
                    ? new vscode.ThemeColor('statusBarItem.warningBackground')
                    : undefined;

            const sysTooltip = new vscode.MarkdownString('', true);
            sysTooltip.isTrusted = true;
            sysTooltip.appendMarkdown(`### $(server) System Memory Pressure: ${sysInfo.pressureLevel}\n\n`);
            sysTooltip.appendMarkdown(`| | |\n|---|---|\n`);
            sysTooltip.appendMarkdown(`| Total RAM | ${formatBytes(sysInfo.totalBytes)} |\n`);
            sysTooltip.appendMarkdown(`| App Memory | ${formatBytes(sysInfo.appMemoryBytes)} |\n`);
            sysTooltip.appendMarkdown(`| Wired | ${formatBytes(sysInfo.wiredBytes)} |\n`);
            sysTooltip.appendMarkdown(`| Compressed | ${formatBytes(sysInfo.compressedBytes)} |\n`);
            sysTooltip.appendMarkdown(`| Swap Used | ${formatBytes(sysInfo.swapUsedBytes)} |\n`);
            sysTooltip.appendMarkdown(`\n${icon} **${sysInfo.pressureLevel}** pressure\n\n`);
            sysTooltip.appendMarkdown(`_Click for details_`);
            systemItem.tooltip = sysTooltip;
            systemItem.show();
        } else {
            systemItem.hide();
        }
    }

    updateDisplay();
    const intervalId = setInterval(updateDisplay, POLL_INTERVAL_MS);

    // --- Command: show combined details ---
    const showDetailsCmd = vscode.commands.registerCommand(
        'resourceMonitor.showDetails',
        () => {
            const mem = process.memoryUsage();
            const rssMB = (mem.rss / (1024 * 1024)).toFixed(0);

            const lines: string[] = [
                `--- Window ---`,
                `This window is using ${rssMB} MB of memory.`,
            ];

            const sysInfo = getSystemMemoryInfo();
            if (sysInfo) {
                const totalGB = (sysInfo.totalBytes / (1024 * 1024 * 1024)).toFixed(0);
                const appGB = (sysInfo.appMemoryBytes / (1024 * 1024 * 1024)).toFixed(1);
                const swapStr = formatBytes(sysInfo.swapUsedBytes);
                const compStr = formatBytes(sysInfo.compressedBytes);

                lines.push(``);
                lines.push(`--- System (${totalGB} GB RAM) ---`);
                lines.push(`Pressure: ${sysInfo.pressureLevel}`);
                lines.push(`App Memory: ${appGB} GB`);
                lines.push(`Compressed: ${compStr}`);
                lines.push(`Swap Used: ${swapStr}`);
                lines.push(``);

                if (sysInfo.pressureLevel === 'Critical') {
                    lines.push(`Your Mac is under heavy memory pressure. Close unused apps to improve performance.`);
                } else if (sysInfo.pressureLevel === 'Warn') {
                    lines.push(`Memory is getting tight. Consider closing some apps if things feel slow.`);
                } else {
                    lines.push(`Your Mac has plenty of memory available.`);
                }
            }

            vscode.window.showInformationMessage(
                `Memory Details`,
                { modal: true, detail: lines.join('\n') }
            );
        }
    );

    // --- Command: toggle visibility ---
    const toggleCmd = vscode.commands.registerCommand(
        'resourceMonitor.toggle',
        () => {
            isVisible = !isVisible;
            if (isVisible) {
                updateDisplay();
                vscode.window.showInformationMessage('Resource Monitor: Enabled');
            } else {
                windowItem.hide();
                systemItem.hide();
                vscode.window.showInformationMessage('Resource Monitor: Disabled');
            }
        }
    );

    context.subscriptions.push(windowItem, systemItem, showDetailsCmd, toggleCmd, {
        dispose: () => clearInterval(intervalId),
    });
}

export function deactivate() {
    // Cleanup is handled by disposables registered in context.subscriptions
}
