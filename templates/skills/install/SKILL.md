---
name: install
description: Set up or update Cortex Hub for the current project. Handles everything in one step - global skill, MCP config, enforcement hooks, quality gates, multi-IDE support. Safe to run multiple times.
disable-model-invocation: true
allowed-tools: Bash(bash:*), Bash(curl:*), Bash(chmod:*), Bash(powershell*), Read, Write, Edit
argument-hint: [--force | --check | --tools claude,gemini]
---

# Cortex Hub — Install

## Current Status
!`bash -c 'echo "hooks=$(cat .cortex/.hooks-version 2>/dev/null || echo 0)/3 mcp=$(grep -q cortex-hub ~/.claude.json 2>/dev/null && echo ok || echo missing) skill=$(test -f ~/.claude/skills/install/SKILL.md && echo ok || echo missing) os=$(uname -s 2>/dev/null || echo Windows)"'`

## Locate install script
!`bash -c 'FOUND=""; if [ -f scripts/install.sh ]; then FOUND="scripts/install.sh"; else for d in ~/Sources ~/Projects ~/repos ~/code ~/dev ~/src; do f="$d/cortex-hub/scripts/install.sh"; if [ -f "$f" ]; then FOUND="$f"; break; fi; done; fi; if [ -n "$FOUND" ]; then echo "INSTALL_SH=$FOUND"; else echo "INSTALL_SH=REMOTE"; fi'`

## Run

Based on the `INSTALL_SH` value above:

- If `INSTALL_SH` is a local path (not `REMOTE`): run it directly:
  ```bash
  bash <INSTALL_SH path> $ARGUMENTS
  ```

- If `INSTALL_SH=REMOTE`: download from GitHub:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/main/scripts/install.sh -o /tmp/cortex-install.sh && bash /tmp/cortex-install.sh $ARGUMENTS
  ```
  If curl fails (404/private repo), tell the user:
  "Cannot download install.sh. Clone cortex-hub first: `git clone https://github.com/lktiep/cortex-hub.git ~/Sources/cortex-hub`"

### Windows PowerShell
```powershell
.\scripts\install.ps1 $ARGUMENTS
```

## After Setup

1. Report what was installed/updated/skipped and which IDEs were configured
2. If MCP not configured (missing API key), ask user for it:
   - `HUB_API_KEY=<key> bash scripts/install.sh`
3. If MCP was newly configured, remind: **restart IDE** to pick up changes
4. Show quality gate commands from `.cortex/project-profile.json`
