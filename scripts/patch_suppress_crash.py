#!/usr/bin/env python3
"""
Suppress Antigravity's 'server crashed unexpectedly' notification.

When our watchdog kills a leaked language_server, Antigravity shows a scary
error popup. This patch replaces the showErrorMessage call with void 0.

No checksum update needed since this file is in extensions/, not workbench.
"""
import re
import shutil
import os
import sys

TARGET = '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/dist/extension.js'
BACKUP = TARGET + '.bak'

# The exact showErrorMessage call to suppress
# Pattern: c.window.showErrorMessage("Antigravity server crashed unexpectedly. Please restart to fully restore AI features.","Reload").then(e=>{"Reload"===e&&c.commands.executeCommand("workbench.action.reloadWindow")})
OLD = 'c.window.showErrorMessage("Antigravity server crashed unexpectedly. Please restart to fully restore AI features.","Reload").then(e=>{"Reload"===e&&c.commands.executeCommand("workbench.action.reloadWindow")})'
NEW = 'void 0'


def patch():
    with open(TARGET, 'r', errors='replace') as f:
        content = f.read()

    if OLD not in content:
        if 'Antigravity server crashed unexpectedly' not in content:
            print('Already patched or string not found.')
            return
        else:
            print('ERROR: Found the error string but not the exact pattern.')
            print('Antigravity may have been updated. Manual inspection needed.')
            sys.exit(1)

    # Create backup
    if not os.path.exists(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print(f'Backup: {BACKUP}')

    new_content = content.replace(OLD, NEW)
    with open(TARGET, 'w') as f:
        f.write(new_content)

    print('Patch applied: "server crashed" notification suppressed.')
    print('Reload Antigravity window to activate.')


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
