# Resource Monitor for Antigravity

A lightweight extension that monitors and displays per-window memory usage in the status bar.

## Features

- **Real-time memory monitoring**: Shows RSS (Resident Set Size) in the status bar, updated every 2 seconds
- **Color-coded alerts**: Green (< 1 GB), Yellow (1-2 GB), Red (> 2 GB)
- **Detailed tooltip**: Hover to see full memory breakdown (RSS, Heap Used/Total, External, Array Buffers)
- **Click for details**: Click the status bar item for a modal dialog with complete memory statistics
- **Toggle visibility**: Use the command palette to show/hide the monitor

## Commands

| Command | Description |
|---------|-------------|
| `Resource Monitor: Show Memory Details` | Show a detailed memory usage dialog |
| `Resource Monitor: Toggle Visibility` | Show or hide the status bar indicator |
