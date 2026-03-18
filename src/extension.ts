import * as vscode from 'vscode';

// Memory threshold constants (in bytes)
const THRESHOLD_WARNING = 1 * 1024 * 1024 * 1024;  // 1 GB
const THRESHOLD_CRITICAL = 2 * 1024 * 1024 * 1024; // 2 GB

// Polling interval in milliseconds
const POLL_INTERVAL_MS = 2000;

/**
 * Format bytes to a human-readable string with appropriate unit.
 * Automatically picks KB, MB, or GB depending on magnitude.
 */
function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
}

/**
 * Determine the status bar color based on RSS memory usage.
 * - Green (normal):  RSS < 1 GB
 * - Yellow (warning): 1 GB <= RSS < 2 GB
 * - Red (critical):  RSS >= 2 GB
 */
function getStatusColor(rss: number): vscode.ThemeColor {
    if (rss >= THRESHOLD_CRITICAL) {
        return new vscode.ThemeColor('statusBarItem.errorForeground');
    } else if (rss >= THRESHOLD_WARNING) {
        return new vscode.ThemeColor('statusBarItem.warningForeground');
    }
    return new vscode.ThemeColor('statusBarItem.foreground');
}

/**
 * Get the background color for the status bar item based on memory usage level.
 */
function getStatusBackground(rss: number): vscode.ThemeColor | undefined {
    if (rss >= THRESHOLD_CRITICAL) {
        return new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (rss >= THRESHOLD_WARNING) {
        return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
}

export function activate(context: vscode.ExtensionContext) {
    // Create the status bar item on the right side, with a moderate priority
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        50
    );
    statusBarItem.command = 'resourceMonitor.showDetails';
    statusBarItem.name = 'Resource Monitor';

    // Track visibility state
    let isVisible = true;

    /**
     * Poll process.memoryUsage() and update the status bar display.
     */
    function updateMemoryDisplay(): void {
        if (!isVisible) {
            return;
        }

        const mem = process.memoryUsage();

        // Main display: RSS (total physical memory held by the process)
        const rssStr = formatBytes(mem.rss);
        statusBarItem.text = `$(pulse) ${rssStr}`;

        // Tooltip with user-friendly summary
        const tooltip = new vscode.MarkdownString('', true);
        tooltip.isTrusted = true;

        // Determine status label and emoji
        let statusLabel: string;
        let statusIcon: string;
        if (mem.rss >= THRESHOLD_CRITICAL) {
            statusLabel = 'Very High';
            statusIcon = '$(error)';
        } else if (mem.rss >= THRESHOLD_WARNING) {
            statusLabel = 'High';
            statusIcon = '$(warning)';
        } else {
            statusLabel = 'Normal';
            statusIcon = '$(check)';
        }

        tooltip.appendMarkdown(`### $(pulse) Window Memory: ${rssStr}\n\n`);
        tooltip.appendMarkdown(`${statusIcon} Status: **${statusLabel}**\n\n`);
        tooltip.appendMarkdown(`_Click for more info_`);

        statusBarItem.tooltip = tooltip;

        // Color coding based on RSS
        statusBarItem.color = getStatusColor(mem.rss);
        statusBarItem.backgroundColor = getStatusBackground(mem.rss);

        statusBarItem.show();
    }

    // Run the initial update immediately
    updateMemoryDisplay();

    // Set up periodic polling
    const intervalId = setInterval(updateMemoryDisplay, POLL_INTERVAL_MS);

    // Command: show user-friendly memory information
    const showDetailsCmd = vscode.commands.registerCommand(
        'resourceMonitor.showDetails',
        () => {
            const mem = process.memoryUsage();
            const rssMB = (mem.rss / (1024 * 1024)).toFixed(0);

            let level: string;
            let tip: string;
            if (mem.rss >= THRESHOLD_CRITICAL) {
                level = 'Very High (> 2 GB)';
                tip = 'Consider closing unused tabs or disabling some extensions to free up memory.';
            } else if (mem.rss >= THRESHOLD_WARNING) {
                level = 'High (1 - 2 GB)';
                tip = 'Memory usage is elevated. Close some tabs if things feel slow.';
            } else {
                level = 'Normal (< 1 GB)';
                tip = 'Everything looks good!';
            }

            const details = [
                `This window is using ${rssMB} MB of memory.`,
                ``,
                `Level: ${level}`,
                `Tip: ${tip}`,
            ].join('\n');

            vscode.window.showInformationMessage(
                `Window Memory: ${formatBytes(mem.rss)}`,
                { modal: true, detail: details }
            );
        }
    );

    // Command: toggle visibility of the status bar item
    const toggleCmd = vscode.commands.registerCommand(
        'resourceMonitor.toggle',
        () => {
            isVisible = !isVisible;
            if (isVisible) {
                updateMemoryDisplay();
                vscode.window.showInformationMessage('Resource Monitor: Enabled');
            } else {
                statusBarItem.hide();
                vscode.window.showInformationMessage('Resource Monitor: Disabled');
            }
        }
    );

    // Register disposables for proper cleanup
    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(showDetailsCmd);
    context.subscriptions.push(toggleCmd);
    context.subscriptions.push({
        dispose: () => clearInterval(intervalId),
    });
}

export function deactivate() {
    // Cleanup is handled by disposables registered in context.subscriptions
}
