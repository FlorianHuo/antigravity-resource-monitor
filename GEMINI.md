# Antigravity Resource Monitor Extension

## Important: Extension Install Path

Antigravity loads extensions from `~/.antigravity/extensions/`, **not** `~/.vscode/extensions/`.

The `code --install-extension` CLI installs to the wrong directory for Antigravity. To update the extension during development:

```bash
# Compile
npx tsc -p ./

# Copy to Antigravity's extension directory
cp out/extension.js ~/.antigravity/extensions/florian.antigravity-resource-monitor-0.2.0/out/
cp out/extension.js.map ~/.antigravity/extensions/florian.antigravity-resource-monitor-0.2.0/out/

# Then reload the window (Cmd+Shift+P -> "Developer: Reload Window")
```

For a full VSIX install, after packaging, manually extract or copy to `~/.antigravity/extensions/`.

## Build

```bash
npm run compile    # TypeScript -> out/extension.js
npx -y @vscode/vsce package --no-dependencies  # Package VSIX
```
