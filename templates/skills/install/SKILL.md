---
name: install
description: Set up or update Cortex Hub for the current project. Handles everything in one step - global skill, MCP config, enforcement hooks, quality gates, multi-IDE support. Safe to run multiple times.
disable-model-invocation: true
allowed-tools: Bash(bash:*), Bash(curl:*), Bash(chmod:*), Bash(powershell*), Read, Write, Edit
argument-hint: [--force | --check | --tools claude,gemini]
---

# Cortex Hub — Install

## Current Status
!`bash -c 'echo "hooks=$(cat .cortex/.hooks-version 2>/dev/null || echo 0)/3 mcp=$(grep -q cortex-hub ~/.claude.json 2>/dev/null && echo ok || echo missing) os=$(uname -s 2>/dev/null || echo Windows)"'`

## Run

Always download the latest install script from GitHub (source of truth):

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.sh -o /tmp/cortex-install.sh && bash /tmp/cortex-install.sh $ARGUMENTS
```

If curl fails (no internet / private repo), tell the user and suggest:
```
Cannot download install.sh from GitHub. Either:
1. Check your internet connection
2. Clone the repo: git clone https://github.com/lktiep/cortex-hub.git ~/Sources/cortex-hub
   Then run: bash ~/Sources/cortex-hub/scripts/install.sh
```

### Windows PowerShell
```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.ps1" -OutFile "$env:TEMP\cortex-install.ps1"; & "$env:TEMP\cortex-install.ps1" $ARGUMENTS
```

## After Setup

1. Report what was installed/updated/skipped and which IDEs were configured
2. If MCP not configured (missing API key), ask user for it:
   - `HUB_API_KEY=<key> bash /tmp/cortex-install.sh`
3. If MCP was newly configured, remind: **restart IDE** to pick up changes
4. Show quality gate commands from `.cortex/project-profile.json`
