# Resource Monitor for Antigravity

A lightweight extension that monitors and displays per-window memory usage in the status bar, with a full process dashboard for managing all Antigravity workspaces.

## Features

- **Real-time memory monitoring**: Shows RSS memory in the status bar, updated every 3 seconds
- **Color-coded alerts**: Green (< 1 GB), Yellow (1-2 GB), Red (> 2 GB)
- **System memory pressure**: Displays macOS memory pressure level (Normal/Warn/Critical)
- **Braille sparkline**: Inline trend graph in the tooltip showing memory history
- **Process Dashboard**: Full WebView dashboard showing all Antigravity workspaces and their processes
- **Incremental updates**: Dashboard uses postMessage for fast data updates without full page reloads
- **Workspace labeling**: Click subtitle in dashboard to set custom labels for workspaces
- **Zombie detection**: Identifies and allows batch-killing of orphaned playground workspaces
- **Process tree kill**: Recursively kills workspace process trees (children first)

## Commands

| Command | Description |
|---------|-------------|
| `Resource Monitor: Process Dashboard` | Open the full process monitor dashboard |
| `Resource Monitor: Show Memory Details` | Alias for Process Dashboard |
| `Resource Monitor: Toggle Visibility` | Show or hide the status bar indicator |

## Development

```bash
npm install
npm run compile
npm run deploy    # Compile + copy to the Antigravity extensions directory
```

## Architecture

- **Memory metric**: Uses macOS `ps` RSS for per-process memory (fast, no permission issues)
- **System pressure**: Batched single-command gathering of `vm_stat`, `sysctl`, and `memory_pressure` for minimal process fork overhead
- **Dashboard rendering**: Static HTML shell loaded once; data pushed via `postMessage` for incremental DOM updates (preserves expand/collapse state)
- **Registry**: Cross-window coordination via `~/.gemini/antigravity/.resource-monitor-registry.json`
- **Brain scanning**: Reads Antigravity brain artifacts to detect conversation titles for playground workspaces

## Changelog

### v0.3.2

- **Auto-reload on cold start**: when a workspace hasn't been opened for >4 hours, automatically reload the window 60s after activation to clear `language_server` indexing memory leak
- **Memory display fix**: workspace total now shows real-time memory instead of peak; peak is still annotated per-process

### v0.3.1

- **Process attribution**: 3-phase Renderer matching algorithm
  - Phase A: window Renderers identified by startup PID proximity to Main process
  - Phase B: WebView/panel Renderers matched by nearest PID to Extension Host
  - Phase C: sibling Plugin processes matched within 200 PIDs of Extension Host
- **Process tree filter**: only include descendants of the active Antigravity main process, excluding Obsidian and other Electron apps from the dashboard
- **Dashboard fix**: eliminated white screen on open by pre-fetching scan data before creating WebView
- **Startup fix**: removed blocking `execSync` call from `registerSelf()` that caused UI hangs

### v0.3.0

- **Performance**: Dashboard refresh reduced from approximately 9s to approximately 380ms
  - Replaced full `webview.html` replacement with `postMessage`-based incremental DOM updates
  - Batched 6 separate `exec` calls in `getSystemMemoryInfo` into 1 shell command
  - Parallelized `scanWorkspaces` + `getSystemMemoryInfo` with `Promise.all`
  - Removed `footprint` command (permission failures caused 9s hangs), using RSS instead
  - Fixed `execAsync` to return stdout even on non-zero exit codes
- **UI**: Refresh button now green; immediate "Refreshing..." feedback on click
- **Stability**: Dashboard preserves expanded/collapsed workspace state across refreshes

### v0.2.0

- Switched from RSS to macOS `footprint` tool for accurate memory reporting
- Added system memory pressure detection with native kernel API
- Added process dashboard with workspace grouping and labeling
- Added zombie workspace detection and batch kill
