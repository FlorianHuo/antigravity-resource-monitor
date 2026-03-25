#!/usr/bin/env python3
"""
Suppress Antigravity's server crash notifications.

When our watchdog kills a leaked language_server, Antigravity shows 3 error
popups. This patch suppresses all of them:
  1. "Antigravity server crashed unexpectedly. Please restart..."
  2. "Restarting server failed"
  3. "couldn't create connection to server."

Usage: python3 scripts/patch_suppress_crash.py
       python3 scripts/patch_suppress_crash.py --restore
"""
import shutil
import os
import sys

TARGET = '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/dist/extension.js'
BACKUP = TARGET + '.bak'

REPLACEMENTS = [
    # 1. showErrorMessage popup with Reload button
    (
        'c.window.showErrorMessage("Antigravity server crashed unexpectedly. '
        'Please restart to fully restore AI features.","Reload").then(e=>{'
        '"Reload"===e&&c.commands.executeCommand("workbench.action.reloadWindow")})',
        'void 0',
    ),
    # 2. error() call for restart failure
    ('this.error("Restarting server failed",e,"force")', 'void 0'),
    # 3. error message string for connection failure
    ("couldn't create connection to server.", ''),
]


def patch():
    with open(TARGET, 'r', errors='replace') as f:
        content = f.read()

    # Create backup before first patch
    if not os.path.exists(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print(f'Backup: {BACKUP}')

    count = 0
    for old, new in REPLACEMENTS:
        if old in content:
            content = content.replace(old, new)
            label = old[:60].replace('\n', ' ')
            print(f'  Suppressed: {label}...')
            count += 1

    if count > 0:
        with open(TARGET, 'w') as f:
            f.write(content)
        print(f'\n{count} notification(s) suppressed. Reload Antigravity.')
    else:
        print('All notifications already suppressed.')


def restore():
    if not os.path.exists(BACKUP):
        print('ERROR: No backup found.')
        sys.exit(1)
    shutil.copy2(BACKUP, TARGET)
    print('Restored from backup. Reload Antigravity window.')


if __name__ == '__main__':
    if '--restore' in sys.argv:
        restore()
    else:
        patch()
