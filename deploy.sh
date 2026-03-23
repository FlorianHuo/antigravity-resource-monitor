#!/bin/bash
# Deploy compiled extension to Antigravity extensions directory
set -e

EXT_DIR="$HOME/.antigravity/extensions/florian.antigravity-resource-monitor-0.2.0"

echo "Deploying to $EXT_DIR..."
mkdir -p "$EXT_DIR/out"
cp -f out/extension.js out/extension.js.map "$EXT_DIR/out/"
cp -f package.json "$EXT_DIR/"
cp -f README.md "$EXT_DIR/readme.md"
echo "Done. Reload Antigravity window to apply changes."
