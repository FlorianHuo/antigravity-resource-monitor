**English** | [中文](./README_CN.md)

# Resource Monitor for Antigravity

A lightweight macOS extension that monitors per-window memory usage, **automatically detects and kills leaked `language_server` processes**, and provides a full process dashboard for managing all Antigravity workspaces.

> **Why?** Antigravity's `language_server` may develop severe memory leaks when starting new AI conversations. A single conversation can cause it to consume 10+ GB of memory, freezing your entire system. This extension detects and kills leaked processes automatically, keeping your Mac responsive.

## Features

### Memory Leak Watchdog

- Monitors `language_server` memory every few seconds using macOS `top` (matches Activity Monitor values)
- Automatically kills the process when memory exceeds the threshold (default: 2 GB)
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
python3 scripts/patch_suppress_crash.py           # Apply patches
python3 scripts/patch_suppress_crash.py --status   # Check patch status
python3 scripts/patch_suppress_crash.py --restore  # Restore originals
```

This patches Antigravity's internal files (backups are created automatically).
Re-run after each Antigravity update.

## Configuration

Search `Resource Monitor` in Antigravity Settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `leakWatchdog.enabled` | `true` | Enable/disable leak watchdog |
| `leakWatchdog.thresholdMB` | `2048` | Memory threshold (MB) to trigger kill |
| `leakWatchdog.checkIntervalSeconds` | `5` | Check interval (seconds) |
| `statusBar.updateIntervalSeconds` | `3` | Status bar refresh interval (seconds) |

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

## Changelog

### v0.4.0

- **Memory leak watchdog**: Automatically detects `language_server_macos_arm` memory leaks and kills the process when MEM exceeds threshold
  - Configurable threshold, interval, and enable/disable via Settings
  - Subtle status bar notification with warning background for 5s
- **Crash notification suppression**: Patch script suppresses Antigravity error popups + integrity warning
- **Status bar accuracy**: Now uses `top` MEM (full process tree) instead of `ps` RSS
- **Close workspace guard**: Prevents dashboard crash when closing the hosting workspace

### v0.3.x

- Auto-reload on cold start for language_server leak mitigation
- Process attribution with 3-phase Renderer matching algorithm
- Dashboard performance: reduced from approximately 9s to approximately 380ms

### v0.2.0

- Initial release with memory monitoring, system pressure detection, and process dashboard

## License

MIT
