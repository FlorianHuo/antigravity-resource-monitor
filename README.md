# Resource Monitor for Antigravity

A lightweight extension that monitors per-window memory usage, system memory pressure, and provides a full process dashboard for all Antigravity windows.

## Features

### Status Bar

- **Window memory**: Shows extension host + child processes RSS, updated every 3 seconds
- **System pressure**: Displays macOS memory pressure level (Normal / Warn / Critical)
- **Color-coded alerts**: Green (< 1 GB), Yellow (1-2 GB), Red (> 2 GB)

### Process Dashboard

Click the status bar item to open a full process dashboard:

- **Per-workspace breakdown**: See memory usage for every open Antigravity window
- **Process tree**: Expand each workspace to see Extension Host, Language Servers, Pyre, TS Server, and workers
- **System overview**: Total RAM, App Memory, Swap, and memory pressure
- **Zombie detection**: Automatically flags unnamed playground workspaces wasting memory
- **Kill controls**: Terminate individual processes, entire workspaces, or all zombies at once
- **Custom labels**: Click workspace subtitles to add your own labels for identification

### Self-Registration

Each Antigravity window registers itself to a shared registry file, enabling the dashboard to show human-readable workspace names, open editors, and conversation titles from the Antigravity brain directory.

## Commands

| Command | Description |
|---------|-------------|
| `Resource Monitor: Process Dashboard` | Open the full process monitor dashboard |
| `Resource Monitor: Show Memory Details` | Show a detailed memory usage dialog |
| `Resource Monitor: Toggle Visibility` | Show or hide the status bar indicators |

## Install

```bash
npm run compile
npx -y @vscode/vsce package --no-dependencies
```

Then copy the compiled output to Antigravity's extension directory:

```bash
cp out/extension.js ~/.antigravity/extensions/florian.antigravity-resource-monitor-0.2.0/out/
cp out/extension.js.map ~/.antigravity/extensions/florian.antigravity-resource-monitor-0.2.0/out/
```

Reload Antigravity (`Cmd+Shift+P` -> "Developer: Reload Window").

> **Note**: Antigravity loads extensions from `~/.antigravity/extensions/`, not `~/.vscode/extensions/`. The `code --install-extension` CLI installs to the wrong directory.
