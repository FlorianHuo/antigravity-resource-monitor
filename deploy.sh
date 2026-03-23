#!/bin/bash
# Deploy compiled extension to Antigravity extensions directory
set -e

# Read version from package.json so we don't hardcode it
VERSION=$(node -p "require('./package.json').version")
EXT_DIR="$HOME/.antigravity/extensions/florian.antigravity-resource-monitor-${VERSION}"

echo "Deploying v${VERSION} to $EXT_DIR..."
mkdir -p "$EXT_DIR/out"
cp -f out/extension.js out/extension.js.map "$EXT_DIR/out/"
cp -f package.json "$EXT_DIR/"
cp -f README.md "$EXT_DIR/readme.md"
echo "Done. Reload Antigravity window to apply changes."
