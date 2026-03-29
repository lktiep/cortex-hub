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

Download via GitHub API (bypasses CDN cache, always latest):

### Unix/macOS
```bash
curl -fsSL "$(curl -fsSL https://api.github.com/repos/lktiep/cortex-hub/contents/scripts/install.sh?ref=master | grep download_url | cut -d'"' -f4)" -o /tmp/cortex-install.sh && bash /tmp/cortex-install.sh $ARGUMENTS
```

If the API call fails (rate limited), fallback to raw:
```bash
curl -fsSL "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.sh" -o /tmp/cortex-install.sh && bash /tmp/cortex-install.sh $ARGUMENTS
```

### Windows PowerShell
```powershell
$url = (Invoke-RestMethod "https://api.github.com/repos/lktiep/cortex-hub/contents/scripts/install.ps1?ref=master").download_url; Invoke-WebRequest -Uri $url -OutFile $env:TEMP\install.ps1; & $env:TEMP\install.ps1 $ARGUMENTS
```

### If all else fails
Tell the user to clone the repo and run locally:
```
git clone https://github.com/lktiep/cortex-hub.git ~/Sources/cortex-hub
bash ~/Sources/cortex-hub/scripts/install.sh
```

## After Setup

1. Report what was installed/updated/skipped and which IDEs were configured
2. If MCP not configured (missing API key), ask user for it:
   - `HUB_API_KEY=<key> bash /tmp/cortex-install.sh`
3. If MCP was newly configured, remind: **restart IDE** to pick up changes
4. Show quality gate commands from `.cortex/project-profile.json`
