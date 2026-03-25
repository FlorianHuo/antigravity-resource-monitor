---
description: Project-specific rules for antigravity-resource-monitor
globalRulesPath: /Users/florian/.gemini/GEMINI.md
---

### README Sync Rule

Any change to commands, configuration options, features, or user-facing behavior **must** be reflected in both `README.md` (English) and `README_CN.md` (Chinese) **in the same commit**. Never leave READMEs out of sync with the code.

Checklist before committing:
- [ ] Commands table matches `package.json` contributes.commands
- [ ] Configuration table matches `package.json` contributes.configuration
- [ ] Feature descriptions match actual behavior
- [ ] Both language versions are consistent
