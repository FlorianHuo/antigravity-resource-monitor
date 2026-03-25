**English** | [中文](./README_CN.md)

<h1 align="center">
  <br>
  Resource Monitor for Antigravity
  <br>
</h1>

<p align="center">
  <strong>Real-time memory monitoring &middot; Leak auto-fix &middot; Process dashboard</strong>
</p>

<p align="center">
  <a href="https://github.com/FlorianHuo/antigravity-resource-monitor/releases"><img src="https://img.shields.io/github/v/release/FlorianHuo/antigravity-resource-monitor?style=flat-square&color=blue" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square" alt="macOS">
  <img src="https://img.shields.io/github/license/FlorianHuo/antigravity-resource-monitor?style=flat-square" alt="License">
</p>

---

## The Problem

Antigravity's language server may develop **severe memory leaks** when starting new AI conversations. A single conversation can consume **10+ GB** of memory, freezing your entire system. There is no built-in protection.

## The Solution

This extension runs a lightweight background monitor that:

1. **Detects** leaked language server processes in real-time (via macOS top, matching Activity Monitor)
2. **Kills** the process when memory exceeds a configurable threshold (default: 2 GB)
3. **Lets Antigravity recover** -- it seamlessly restarts a fresh server, your AI features continue working

All fully automatic. Zero user intervention required.

---

## Features

### Memory Leak Auto-fix

> Background monitor checks language server memory every few seconds. When it exceeds the threshold, the process is terminated gracefully. Antigravity auto-restarts a fresh server within seconds.

- Configurable threshold, interval, and on/off toggle
- Subtle status bar flash on kill (red text, 2s)
- 5s cooldown prevents double-triggers

### Status Bar

> Real-time per-window memory in the status bar, color-coded by severity.

- **Green** < 1 GB &middot; **Yellow** 1-2 GB &middot; **Red** > 2 GB
- System memory pressure indicator (Normal / Warn / Critical)
- Braille sparkline trend in tooltip

### Process Dashboard

> Full WebView panel showing all Antigravity workspaces and their process trees.

- Close remote workspaces with atomic process tree cleanup
- Zombie workspace detection and batch kill
- Custom workspace labels and conversation title detection

---

## Quick Start

### Install

Download the **.vsix** from [**Releases**](https://github.com/FlorianHuo/antigravity-resource-monitor/releases), then:

> <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> &rarr; **Extensions: Install from VSIX...**

Reload the window. Done -- the leak monitor starts automatically.

### Suppress Crash Popups (Optional)

When the monitor kills a leaked server, Antigravity shows error popups. To silence them:

> <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> &rarr; **Resource Monitor: Apply Crash Notification Patch**

Or via CLI:

```bash
python3 scripts/patch_suppress_crash.py
```

Re-run after each Antigravity update. Use `--restore` to undo.

> **Disclaimer**: The patch script modifies Antigravity's internal files. Backups are created automatically
> and can be restored at any time. This is an optional feature provided as-is with no warranty.
> Use at your own risk.

---

## Configuration

Search **Resource Monitor** in Settings (<kbd>Cmd</kbd> + <kbd>,</kbd>):

| Setting | Default | Description |
|---------|---------|-------------|
| **leakWatchdog.enabled** | true | Enable/disable the leak monitor |
| **leakWatchdog.thresholdMB** | 2048 | Kill threshold in MB |
| **leakWatchdog.checkIntervalSeconds** | 5 | Check frequency |
| **statusBar.updateIntervalSeconds** | 3 | Status bar refresh rate |

## Commands

| Command | Description |
|---------|-------------|
| **Process Dashboard** | Open the process monitor panel |
| **Toggle Visibility** | Show/hide the status bar indicator |
| **Apply Crash Notification Patch** | Suppress crash popups (one-click) |
| **Restore Original Files** | Undo the patch |

## Requirements

- **macOS only** (uses top, ps, memory_pressure, vm_stat)
- Antigravity (any recent version)
- Python 3 (only for the optional patch)

---

## Build from Source

```bash
git clone https://github.com/FlorianHuo/antigravity-resource-monitor.git
cd antigravity-resource-monitor
npm install
npm run deploy   # Compile + install to ~/.antigravity/extensions/
```

## Changelog

### v0.4.1

- Dashboard settings panel with custom stepper controls (- / value / +)
- Restart Extensions button on dashboard
- Watchdog PID detection rewritten to use process tree (ppid) instead of PID distance heuristic
- Dashboard auto-refresh now reuses check interval config
- Close button moved below progress bar for consistent card alignment
- Workspace path displayed in card footer row
- Memory color thresholds doubled (warning 2 GB, critical 4 GB)
- Status bar update lock with 10s safety timeout
- Leak kill flash: red text, 2s duration

### v0.4.0

- Automatic memory leak detection and killing for language server
- One-click crash notification + integrity warning patch
- All settings configurable via Settings UI
- Status bar uses top MEM (matches Activity Monitor)

### v0.3.x

- Process dashboard with 3-phase Renderer matching
- Dashboard performance: 9s to 380ms
- Auto-reload on cold start

### v0.2.0

- Initial release

## License

[MIT](./LICENSE)
