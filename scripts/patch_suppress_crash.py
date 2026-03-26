#!/usr/bin/env python3
"""
Suppress Antigravity's server crash notifications, renderer crash dialog,
and integrity warning.

When our watchdog/zombie-killer terminates processes, Antigravity shows error
popups. This patch suppresses all of them AND the "installation corrupt"
warning that appears after modifying Antigravity's internal files.

Suppressed notifications:
  1. "Antigravity server crashed unexpectedly. Please restart..."
  2. "Restarting server failed"
  3. "antigravity client: couldn't create connection to server."
  4. "Installation corrupt / reinstall" integrity warning
  5. "The window terminated unexpectedly (reason: 'killed', code: '15')"
     renderer crash dialog (Reopen/Close) in main.js

Usage: python3 scripts/patch_suppress_crash.py
       python3 scripts/patch_suppress_crash.py --restore
       python3 scripts/patch_suppress_crash.py --status

Re-run after each Antigravity update.
"""
import hashlib
import base64
import json
import shutil
import os
import sys
import subprocess

EXTENSION_JS = '/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/dist/extension.js'
EXTENSION_BACKUP = EXTENSION_JS + '.bak'

WORKBENCH_JS = '/Applications/Antigravity.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js'
WORKBENCH_BACKUP = WORKBENCH_JS + '.bak'

MAIN_JS = '/Applications/Antigravity.app/Contents/Resources/app/out/main.js'
MAIN_BACKUP = MAIN_JS + '.bak'

PRODUCT_JSON = '/Applications/Antigravity.app/Contents/Resources/app/product.json'
CHECKSUM_KEY = 'vs/workbench/workbench.desktop.main.js'

# Replacements in extension.js (crash notifications)
EXTENSION_REPLACEMENTS = [
    # 1. showErrorMessage popup with Reload button
    (
        'c.window.showErrorMessage("Antigravity server crashed unexpectedly. '
        'Please restart to fully restore AI features.","Reload").then(e=>{'
        '"Reload"===e&&c.commands.executeCommand("workbench.action.reloadWindow")})',
        'void 0',
    ),
    # 2. error() call for restart failure
    ('this.error("Restarting server failed",e,"force")', 'void 0'),
    # 3. error() call for connection failure (keep n(e) for promise rejection)
    (
        "this.error(`${this._name} client: couldn't create connection to server.`,e,\"force\"),n(e)",
        'n(e)',
    ),
]

# Replacement in main.js (renderer crash dialog)
# When renderer dies (case t===2), the original code shows a dialog with
# Reopen/Close buttons. We replace it with silent window destruction.
MAIN_RENDERER_CRASH_OLD = (
    'else if(t===2){let n;r?n=Ee(2783,null,r.reason,r.exitCode??'
    '"<unknown>"):n=Ee(2782,null);const{response:a,checkboxChecked:s}='
    'await this.Bb.showMessageBox({type:"warning",buttons:[this.bb?.workspace?'
    'Ee(2784,null):Ee(2785,null),Ee(2786,null)],message:n,detail:'
    'this.bb?.workspace?Ee(2787,null):Ee(2788,null),checkboxLabel:'
    'this.bb?.workspace?Ee(2789,null):void 0},this.s),l=a===0;'
    'await this.Kb(l,s)}'
)

# Silent replacement: just destroy the window, no dialog
MAIN_RENDERER_CRASH_NEW = (
    'else if(t===2){this.s?.destroy()}'
)


def compute_checksum(filepath):
    """Compute base64-encoded SHA256 checksum."""
    with open(filepath, 'rb') as f:
        sha = hashlib.sha256(f.read()).digest()
    return base64.b64encode(sha).decode()


def update_product_checksum(new_checksum):
    """Update the checksum in product.json to suppress integrity warning."""
    with open(PRODUCT_JSON, 'r') as f:
        data = json.load(f)

    old = data.get('checksums', {}).get(CHECKSUM_KEY, '(not found)')
    data.setdefault('checksums', {})[CHECKSUM_KEY] = new_checksum

    with open(PRODUCT_JSON, 'w') as f:
        json.dump(data, f, indent='\t', ensure_ascii=False)
        f.write('\n')

    print(f'  Checksum: {old[:20]}... -> {new_checksum[:20]}...')


def suppress_integrity_warning():
    """
    Replace the integrity warning notification call this.n()
    with void 0 so it never shows the 'installation corrupt' prompt.
    """
    with open(WORKBENCH_JS, 'r', errors='replace') as f:
        content = f.read()

    old_pattern = r'i?.dontShowPrompt&&i.commit===this.f.commit||this.n()'
    new_pattern = r'i?.dontShowPrompt&&i.commit===this.f.commit||void 0'

    if old_pattern in content:
        if not os.path.exists(WORKBENCH_BACKUP):
            shutil.copy2(WORKBENCH_JS, WORKBENCH_BACKUP)
            print(f'  Backup: {WORKBENCH_BACKUP}')

        content = content.replace(old_pattern, new_pattern)
        with open(WORKBENCH_JS, 'w') as f:
            f.write(content)
        print('  Suppressed: integrity warning (installation corrupt)')

        # Update checksum so the notification won't reappear
        new_checksum = compute_checksum(WORKBENCH_JS)
        update_product_checksum(new_checksum)
        return True
    elif new_pattern in content:
        print('  Integrity warning: already suppressed')
        # Still update checksum in case product.json was reset
        new_checksum = compute_checksum(WORKBENCH_JS)
        update_product_checksum(new_checksum)
        return True
    else:
        print('  WARNING: Integrity warning pattern not found (Antigravity may have updated)')
        return False


def patch_main_js():
    """Suppress the renderer crash dialog in main.js."""
    print('=== Patching main.js (renderer crash dialog) ===')

    if not os.path.exists(MAIN_JS):
        print(f'  WARNING: {MAIN_JS} not found')
        return

    with open(MAIN_JS, 'r', errors='replace') as f:
        content = f.read()

    if MAIN_RENDERER_CRASH_OLD in content:
        if not os.path.exists(MAIN_BACKUP):
            shutil.copy2(MAIN_JS, MAIN_BACKUP)
            print(f'  Backup: {MAIN_BACKUP}')

        content = content.replace(MAIN_RENDERER_CRASH_OLD, MAIN_RENDERER_CRASH_NEW)
        with open(MAIN_JS, 'w') as f:
            f.write(content)
        print('  Suppressed: renderer crash dialog (window terminated unexpectedly)')
    elif MAIN_RENDERER_CRASH_NEW in content:
        print('  Renderer crash dialog: already suppressed')
    else:
        print('  WARNING: Renderer crash dialog pattern not found (Antigravity may have updated)')


def patch():
    """Apply all patches."""
    print('=== Patching extension.js (crash notifications) ===')
    with open(EXTENSION_JS, 'r', errors='replace') as f:
        content = f.read()

    if not os.path.exists(EXTENSION_BACKUP):
        shutil.copy2(EXTENSION_JS, EXTENSION_BACKUP)
        print(f'  Backup: {EXTENSION_BACKUP}')

    count = 0
    for old, new in EXTENSION_REPLACEMENTS:
        if old in content:
            content = content.replace(old, new)
            label = old[:50].replace('\n', ' ')
            print(f'  Suppressed: {label}...')
            count += 1

    if count > 0:
        with open(EXTENSION_JS, 'w') as f:
            f.write(content)
        print(f'  {count} notification(s) suppressed.')
    else:
        print('  All crash notifications already suppressed.')

    print()
    patch_main_js()

    print()
    print('=== Patching workbench.js (integrity warning) ===')
    suppress_integrity_warning()

    print()
    print('Done! Reload Antigravity window to apply.')


def restore():
    """Restore from backups."""
    restored = 0
    if os.path.exists(EXTENSION_BACKUP):
        shutil.copy2(EXTENSION_BACKUP, EXTENSION_JS)
        print(f'Restored: {EXTENSION_JS}')
        restored += 1
    if os.path.exists(MAIN_BACKUP):
        shutil.copy2(MAIN_BACKUP, MAIN_JS)
        print(f'Restored: {MAIN_JS}')
        restored += 1
    if os.path.exists(WORKBENCH_BACKUP):
        shutil.copy2(WORKBENCH_BACKUP, WORKBENCH_JS)
        # Update checksum for restored workbench
        new_checksum = compute_checksum(WORKBENCH_JS)
        update_product_checksum(new_checksum)
        print(f'Restored: {WORKBENCH_JS}')
        restored += 1
    if restored == 0:
        print('ERROR: No backups found.')
        sys.exit(1)
    print('Reload Antigravity window to apply.')


def status():
    """Check patch status."""
    print('=== Patch Status ===')

    with open(EXTENSION_JS, 'r', errors='replace') as f:
        ext = f.read()
    for old, _ in EXTENSION_REPLACEMENTS:
        label = old[:50]
        if old in ext:
            print(f'  [ ] {label}...')
        else:
            print(f'  [x] {label}...')

    if os.path.exists(MAIN_JS):
        with open(MAIN_JS, 'r', errors='replace') as f:
            mjs = f.read()
        if MAIN_RENDERER_CRASH_NEW in mjs:
            print('  [x] Renderer crash dialog suppressed')
        elif MAIN_RENDERER_CRASH_OLD in mjs:
            print('  [ ] Renderer crash dialog NOT suppressed')
        else:
            print('  [?] Renderer crash dialog pattern not found')

    with open(WORKBENCH_JS, 'r', errors='replace') as f:
        wb = f.read()
    if 'i?.dontShowPrompt&&i.commit===this.f.commit||void 0' in wb:
        print('  [x] Integrity warning suppressed')
    else:
        print('  [ ] Integrity warning NOT suppressed')


if __name__ == '__main__':
    if '--restore' in sys.argv:
        restore()
    elif '--status' in sys.argv:
        status()
    else:
        patch()
