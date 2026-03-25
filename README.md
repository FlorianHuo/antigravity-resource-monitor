# Resource Monitor for Antigravity

A lightweight macOS extension that monitors per-window memory usage, automatically kills leaked `language_server` processes, and provides a full process dashboard for managing all Antigravity workspaces.

> **Why?** Antigravity's `language_server` has a known memory leak triggered by new AI conversations. A single conversation can cause it to consume 10+ GB of memory, freezing your entire system. This extension detects and kills leaked processes automatically, keeping your Mac responsive.

## Features

### Memory Leak Watchdog

- Monitors `language_server` memory every 5 seconds using macOS `top` (matches Activity Monitor values)
- Automatically kills the process when memory exceeds **2 GB**
- Antigravity seamlessly restarts a fresh server -- your AI features continue working
- Subtle status bar notification on kill: shield icon with warning background for 5s

### Status Bar

- **Real-time memory display**: Per-window memory usage matching Activity Monitor
- **Color-coded alerts**: Green (< 1 GB), Yellow (1-2 GB), Red (> 2 GB)
- **System pressure**: macOS memory pressure level (Normal/Warn/Critical)
- **Braille sparkline**: Inline trend graph in the tooltip

### Process Dashboard

- Full WebView dashboard showing all Antigravity workspaces and processes
- Close remote workspaces with atomic process tree cleanup
- Zombie workspace detection and batch kill
- Workspace labeling and conversation title detection

## Installation

### Option 1: From Release (Recommended)

1. Download the latest `.vsix` from [Releases](https://github.com/FlorianHuo/antigravity-resource-monitor/releases)
2. In Antigravity, open the Command Palette (`Cmd+Shift+P`)
3. Run `Extensions: Install from VSIX...` and select the downloaded file
4. Reload the window

### Option 2: Manual Install

```bash
git clone https://github.com/FlorianHuo/antigravity-resource-monitor.git
cd antigravity-resource-monitor
npm install
npm run compile

# Copy to Antigravity extensions directory
VERSION=$(node -p "require('./package.json').version")
EXT_DIR="$HOME/.antigravity/extensions/florian.antigravity-resource-monitor-${VERSION}"
mkdir -p "$EXT_DIR/out"
cp -f out/extension.js out/extension.js.map "$EXT_DIR/out/"
cp -f package.json "$EXT_DIR/"
```

Reload the Antigravity window to activate.

### Optional: Suppress Crash Notifications

When the watchdog kills a leaked server, Antigravity shows error popups ("server crashed unexpectedly"). To suppress them:

```bash
# Requires Python 3
python3 scripts/patch_suppress_crash.py
```

This patches Antigravity's internal extension.js (backup is created automatically).
Re-run after each Antigravity update.

## Requirements

- **macOS only** (uses `top`, `ps`, `memory_pressure`, `vm_stat`)
- Antigravity (any recent version)
- Python 3 (only for the optional crash notification patch)

## Commands

| Command | Description |
|---------|-------------|
| `Resource Monitor: Process Dashboard` | Open the full process monitor dashboard |
| `Resource Monitor: Show Memory Details` | Alias for Process Dashboard |
| `Resource Monitor: Toggle Visibility` | Show or hide the status bar indicator |

## How It Works

The watchdog uses a two-phase approach for minimal overhead:

1. **PID Discovery** (every 30s): Finds `language_server_macos_arm` PIDs associated with the current extension host using `ps`
2. **Memory Check** (every 5s): Reads from a shared `topMemCache` (same data source as the dashboard) to check the process's real memory footprint. The cache refreshes every 5s via `top -l 1`.
3. **Kill** (on threshold): Sends `SIGTERM` when MEM > 2 GB. Antigravity's built-in recovery restarts a fresh language server within seconds.

## Changelog

### v0.4.0

- **Memory leak watchdog**: Automatically detects `language_server_macos_arm` memory leaks and kills the process when MEM exceeds 2 GB
  - Uses `topMemCache` (same data source as dashboard) for zero-overhead detection
  - Subtle status bar notification with warning background for 5s
  - 10s kill cooldown to prevent double-trigger from stale cache
- **Crash notification suppression**: Patch script (`scripts/patch_suppress_crash.py`) suppresses Antigravity error popups
- **Status bar accuracy**: Now uses `top` MEM (full process tree) instead of `ps` RSS, matching Activity Monitor
- **Close workspace guard**: Prevents dashboard crash when closing the hosting workspace

### v0.3.2

- **Auto-reload on cold start**: Automatic reload after activation to clear language_server indexing memory leak
- **Memory display fix**: Workspace total shows real-time memory instead of peak

### v0.3.1

- **Process attribution**: 3-phase Renderer matching algorithm for accurate per-window process grouping
- **Process tree filter**: Excludes non-Antigravity Electron apps from the dashboard

### v0.3.0

- **Performance**: Dashboard refresh reduced from approximately 9s to approximately 380ms
- **Incremental updates**: `postMessage`-based DOM updates preserve expand/collapse state

### v0.2.0

- Initial release with memory monitoring, system pressure detection, and process dashboard

## License

MIT
