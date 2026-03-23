# Resource Monitor for Antigravity

A lightweight extension that monitors and displays per-window memory usage in the status bar.

## Features

- **Real-time memory monitoring**: Shows footprint memory (matches Activity Monitor) in the status bar, updated every 3 seconds
- **Color-coded alerts**: Green (< 1 GB), Yellow (1-2 GB), Red (> 2 GB)
- **System memory pressure**: Displays macOS memory pressure level (Normal/Warn/Critical)
- **Braille sparkline**: Inline trend graph in the tooltip showing memory history
- **Process Dashboard**: Full WebView dashboard showing all Antigravity workspaces and their processes
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
npm run deploy    # Compile + copy to ~/.antigravity/extensions/
```

## Architecture

- **Memory metric**: Uses macOS `footprint` tool instead of RSS for accurate memory reporting (matches Activity Monitor)
- **System pressure**: Reads `kern.memorystatus_vm_pressure_level` with fallback heuristics
- **Registry**: Cross-window coordination via `~/.gemini/antigravity/.resource-monitor-registry.json`
- **Brain scanning**: Reads Antigravity brain artifacts to detect conversation titles for playground workspaces
