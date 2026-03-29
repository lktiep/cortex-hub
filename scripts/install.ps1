# Cortex Hub — Unified Installer (v3) — Windows PowerShell
# One script for everything: global skill + MCP + hooks + IDE setup.
# Idempotent. Version-aware. Auto-updating. Multi-IDE.
#
# Usage:
#   .\install.ps1                              # Full setup (global + project)
#   .\install.ps1 -Force                       # Force regenerate
#   .\install.ps1 -CheckOnly                   # Status check only
#   .\install.ps1 -Tools "claude,gemini"       # Specific IDEs
#   .\install.ps1 -SkipGlobal                  # Project setup only
#
# Requirements: PowerShell 5.1+, Python 3 (for JSON manipulation)

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$CheckOnly,
    [switch]$SkipGlobal,
    [string]$Tools = ""
)

$ErrorActionPreference = "Stop"
$HOOKS_VERSION = 3
$MCP_URL_DEFAULT = "https://cortex-mcp.jackle.dev/mcp"

# ── Helpers ──
function Write-Info  { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Blue }
function Write-Ok    { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Red }

# ── Find project root ──
$ProjectDir = git rev-parse --show-toplevel 2>$null
if (-not $ProjectDir) { $ProjectDir = (Get-Location).Path }
Set-Location $ProjectDir
$GitRepo = git remote get-url origin 2>$null
if (-not $GitRepo) { $GitRepo = "unknown" }

Write-Info "Project: $ProjectDir"

# ── IDE Detection ──
function Get-DetectedIDEs {
    $detected = @()
    if ((Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path "$env:USERPROFILE\.claude.json") -or (Test-Path "$env:USERPROFILE\.claude")) {
        $detected += "claude"
    }
    if ((Get-Command gemini -ErrorAction SilentlyContinue) -or (Test-Path "$env:USERPROFILE\.gemini")) {
        $detected += "gemini"
    }
    if ((Test-Path "$env:USERPROFILE\.cursor") -or (Get-Command cursor -ErrorAction SilentlyContinue)) {
        $detected += "cursor"
    }
    if (Get-Command code -ErrorAction SilentlyContinue) {
        $detected += "vscode"
    }
    if ((Get-Command codex -ErrorAction SilentlyContinue) -or (Test-Path "$env:USERPROFILE\.codex")) {
        $detected += "codex"
    }
    return $detected
}

if ($Tools -ne "") {
    $SelectedIDEs = $Tools -split "," | ForEach-Object { $_.Trim() }
    Write-Info "IDEs (specified): $($SelectedIDEs -join ', ')"
} else {
    $SelectedIDEs = Get-DetectedIDEs
    if ($SelectedIDEs.Count -gt 0) {
        Write-Info "IDEs (detected): $($SelectedIDEs -join ', ')"
    } else {
        $SelectedIDEs = @("claude")
        Write-Info "IDEs: defaulting to claude"
    }
}

function Test-IDESelected { param([string]$ide) return $SelectedIDEs -contains $ide }

# ══════════════════════════════════════════════
# Phase 0: Global Skill Install
# ══════════════════════════════════════════════
if (-not $SkipGlobal -and -not $CheckOnly -and (Test-IDESelected "claude")) {
    $skillDir = Join-Path $env:USERPROFILE ".claude\skills\install"
    $scriptDir = Split-Path -Parent $PSCommandPath
    $localSkill = Join-Path $scriptDir "..\templates\skills\install\SKILL.md"

    if (Test-Path $localSkill) {
        if (-not (Test-Path $skillDir)) { New-Item -ItemType Directory -Path $skillDir -Force | Out-Null }
        Copy-Item $localSkill (Join-Path $skillDir "SKILL.md") -Force
        Write-Ok "Global: /install skill installed"
    } elseif (-not (Test-Path (Join-Path $skillDir "SKILL.md"))) {
        if (-not (Test-Path $skillDir)) { New-Item -ItemType Directory -Path $skillDir -Force | Out-Null }
        try {
            Invoke-WebRequest -Uri "https://raw.githubusercontent.com/lktiep/cortex-hub/master/templates/skills/install/SKILL.md" -OutFile (Join-Path $skillDir "SKILL.md")
            Write-Ok "Global: /install skill downloaded"
        } catch {
            Write-Warn "Global: could not download /install skill"
        }
    } else {
        Write-Ok "Global: /install skill up to date"
    }
}

# ══════════════════════════════════════════════
# Phase 1: Global MCP Config
# ══════════════════════════════════════════════
$ClaudeJson = Join-Path $env:USERPROFILE ".claude.json"
$McpConfigured = $false

if ((Test-Path $ClaudeJson) -and (Select-String -Path $ClaudeJson -Pattern "cortex-hub" -Quiet)) {
    $McpConfigured = $true
    Write-Ok "MCP: configured in ~/.claude.json"
} else {
    $ApiKey = $env:HUB_API_KEY
    if (-not $ApiKey -and (Test-Path ".env")) {
        $envLine = Select-String -Path ".env" -Pattern "^HUB_API_KEY=" | Select-Object -First 1
        if ($envLine) { $ApiKey = ($envLine.Line -split "=", 2)[1].Trim('"', "'") }
    }

    if ($ApiKey -and -not $CheckOnly) {
        $McpUrl = if ($env:HUB_MCP_URL) { $env:HUB_MCP_URL } else { $MCP_URL_DEFAULT }
        Write-Info "Configuring MCP in ~/.claude.json..."

        python3 -c @"
import json, os
path = os.path.join(os.environ['USERPROFILE'], '.claude.json')
config = {}
if os.path.exists(path):
    with open(path) as f: config = json.load(f)
if 'mcpServers' not in config: config['mcpServers'] = {}
config['mcpServers']['cortex-hub'] = {
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '$McpUrl', '--header', 'Authorization:`${AUTH_HEADER}'],
    'env': {'AUTH_HEADER': 'Bearer $ApiKey'}
}
with open(path, 'w') as f: json.dump(config, f, indent=2)
"@
        $McpConfigured = $true
        Write-Ok "MCP: configured with provided API key"

        # Configure other IDEs
        if (Test-IDESelected "cursor") {
            $cursorDir = Join-Path $env:USERPROFILE ".cursor"
            if (-not (Test-Path $cursorDir)) { New-Item -ItemType Directory -Path $cursorDir -Force | Out-Null }
            python3 -c @"
import json, os
path = os.path.join(os.environ['USERPROFILE'], '.cursor', 'mcp.json')
config = {}
if os.path.exists(path):
    with open(path) as f: config = json.load(f)
if 'mcpServers' not in config: config['mcpServers'] = {}
config['mcpServers']['cortex-hub'] = {
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '$McpUrl', '--header', 'Authorization:`${AUTH_HEADER}'],
    'env': {'AUTH_HEADER': 'Bearer $ApiKey'}
}
with open(path, 'w') as f: json.dump(config, f, indent=2)
"@
            Write-Ok "MCP: configured Cursor"
        }
    } else {
        Write-Warn "MCP: not configured. Set HUB_API_KEY in env or .env file, then re-run"
    }
}

# ══════════════════════════════════════════════
# Phase 2: Version Check
# ══════════════════════════════════════════════
if (-not (Test-Path ".cortex")) { New-Item -ItemType Directory -Path ".cortex" -Force | Out-Null }
$InstalledVersion = 0
if (Test-Path ".cortex\.hooks-version") {
    $InstalledVersion = [int](Get-Content ".cortex\.hooks-version" -ErrorAction SilentlyContinue)
}

if ($CheckOnly) {
    Write-Host ""
    Write-Host "=== Cortex Hub Status ===" -ForegroundColor Cyan
    Write-Host "  Project:        $ProjectDir"
    Write-Host "  MCP configured: $McpConfigured"
    Write-Host "  Hooks version:  $InstalledVersion (latest: $HOOKS_VERSION)"
    Write-Host "  Profile:        $(if (Test-Path '.cortex\project-profile.json') { 'yes' } else { 'no' })"
    Write-Host "  Claude hooks:   $(if (Test-Path '.claude\hooks\enforce-session.ps1') { 'yes' } else { 'no' })"
    Write-Host "  Lefthook:       $(if (Test-Path 'lefthook.yml') { 'yes' } else { 'no' })"
    if ($InstalledVersion -lt $HOOKS_VERSION) { Write-Warn "Hooks outdated! Run /onboard to update." }
    exit 0
}

$NeedsUpdate = $false
if ($Force) {
    $NeedsUpdate = $true
    Write-Info "Force mode: regenerating all files"
} elseif ($InstalledVersion -lt $HOOKS_VERSION) {
    $NeedsUpdate = $true
    Write-Info "Updating hooks v$InstalledVersion -> v$HOOKS_VERSION"
} elseif (-not (Test-Path ".claude\hooks\enforce-session.ps1")) {
    $NeedsUpdate = $true
    Write-Info "Missing files detected, regenerating..."
} else {
    Write-Ok "Hooks: up to date (v$HOOKS_VERSION)"
}

# ══════════════════════════════════════════════
# Phase 3: Detect Project Stack
# ══════════════════════════════════════════════
if (-not (Test-Path ".cortex\project-profile.json") -or $Force) {
    Write-Info "Detecting project stack..."
    $PkgManager = "unknown"
    $PreCommitCmds = @()
    $FullCmds = @()

    if (Test-Path "package.json") {
        if (Test-Path "pnpm-lock.yaml") { $PkgManager = "pnpm" }
        elseif (Test-Path "yarn.lock") { $PkgManager = "yarn" }
        else { $PkgManager = "npm" }

        $scripts = python3 -c "import json; s=json.load(open('package.json',encoding='utf-8-sig')).get('scripts',{}); print(' '.join(s.keys()))" 2>$null
        foreach ($s in @("build", "typecheck", "lint")) {
            if ($scripts -match "\b$s\b") {
                $PreCommitCmds += "`"$PkgManager $s`""
                $FullCmds += "`"$PkgManager $s`""
            }
        }
        if ($scripts -match "\btest\b") { $FullCmds += "`"$PkgManager test`"" }
    } elseif (Test-Path "go.mod") {
        $PkgManager = "go"
        $PreCommitCmds = @('"go build ./..."', '"go vet ./..."')
        $FullCmds = @('"go build ./..."', '"go vet ./..."', '"go test ./..."')
    } elseif (Test-Path "Cargo.toml") {
        $PkgManager = "cargo"
        $PreCommitCmds = @('"cargo build"', '"cargo clippy"')
        $FullCmds = @('"cargo build"', '"cargo clippy"', '"cargo test"')
    } elseif ((Test-Path "*.csproj") -or (Test-Path "*.sln")) {
        $PkgManager = "dotnet"
        $PreCommitCmds = @('"dotnet build"')
        $FullCmds = @('"dotnet build"', '"dotnet test"')
    }

    $profileJson = @"
{
  "schema_version": "1.0",
  "project_name": "$(Split-Path $ProjectDir -Leaf)",
  "fingerprint": {
    "package_manager": "$PkgManager",
    "detected_at": "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')"
  },
  "verify": {
    "pre_commit": [$($PreCommitCmds -join ',')],
    "full": [$($FullCmds -join ',')],
    "auto_fix": true,
    "max_retries": 2
  }
}
"@
    $profileJson | Out-File -FilePath ".cortex\project-profile.json" -Encoding utf8
    Write-Ok "Profile: .cortex\project-profile.json created ($PkgManager)"
} else {
    Write-Ok "Profile: already exists"
}

# ══════════════════════════════════════════════
# Phase 4: Install Hooks (if needed)
# ══════════════════════════════════════════════
if ($NeedsUpdate) {
    # ── Claude Code hooks (PowerShell) ──
    if (Test-IDESelected "claude") {
        $hooksDir = ".claude\hooks"
        if (-not (Test-Path $hooksDir)) { New-Item -ItemType Directory -Path $hooksDir -Force | Out-Null }
        if (-not (Test-Path ".cortex\.session-state")) { New-Item -ItemType Directory -Path ".cortex\.session-state" -Force | Out-Null }

        # session-init.ps1
        @'
$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (git rev-parse --show-toplevel 2>$null) }
if (-not $ProjectDir) { $ProjectDir = "." }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
@("session-started","quality-gates-passed","gate-build","gate-typecheck","gate-lint","session-ended") | ForEach-Object {
    Remove-Item (Join-Path $StateDir $_) -ErrorAction SilentlyContinue
}
Write-Output "MANDATORY SESSION PROTOCOL: Call cortex_session_start before any work."
exit 0
'@ | Out-File -FilePath "$hooksDir\session-init.ps1" -Encoding utf8

        # enforce-session.ps1
        @'
$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (git rev-parse --show-toplevel 2>$null) }
if (-not $ProjectDir) { $ProjectDir = "." }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
if (Test-Path (Join-Path $StateDir "session-started")) { exit 0 }
try {
    $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ToolName = $json.tool_name
} catch {
    Write-Error "BLOCKED: Cannot parse hook input."
    exit 2
}
if ($ToolName -match "^(Edit|Write|NotebookEdit)$") {
    Write-Error "BLOCKED: Call cortex_session_start before editing files."
    exit 2
}
if ($ToolName -eq "Bash") {
    $Command = $json.tool_input.command
    if ($Command -match "^(ls|cat|head|tail|pwd|which|echo|git (status|log|diff|branch|remote)|pnpm (build|typecheck|lint|test)|curl|python)") {
        exit 0
    }
    if ($Command -match "(git (add|commit|push|reset)|rm |mv |cp |mkdir |touch |chmod |sed -i|> )") {
        Write-Error "BLOCKED: Call cortex_session_start before modifying files."
        exit 2
    }
}
exit 0
'@ | Out-File -FilePath "$hooksDir\enforce-session.ps1" -Encoding utf8

        # enforce-commit.ps1
        @'
$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (git rev-parse --show-toplevel 2>$null) }
if (-not $ProjectDir) { $ProjectDir = "." }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
try {
    $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $Command = $json.tool_input.command
} catch { exit 0 }
if ($Command -match "^git commit" -and -not (Test-Path (Join-Path $StateDir "quality-gates-passed"))) {
    Write-Error "BLOCKED: Quality gates not passed. Run build/typecheck/lint first."
    exit 2
}
if ($Command -match "^git push") {
    Write-Host "REMINDER: After push, call cortex_code_reindex." -ForegroundColor Yellow
}
exit 0
'@ | Out-File -FilePath "$hooksDir\enforce-commit.ps1" -Encoding utf8

        # track-quality.ps1
        @'
$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (git rev-parse --show-toplevel 2>$null) }
if (-not $ProjectDir) { $ProjectDir = "." }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
try {
    $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $Command = $json.tool_input.command
    $ToolName = $json.tool_name
} catch { exit 0 }
if ($Command -match "(pnpm|npm|yarn) build")     { New-Item (Join-Path $StateDir "gate-build") -Force | Out-Null }
if ($Command -match "(pnpm|npm|yarn) typecheck") { New-Item (Join-Path $StateDir "gate-typecheck") -Force | Out-Null }
if ($Command -match "(pnpm|npm|yarn) lint")       { New-Item (Join-Path $StateDir "gate-lint") -Force | Out-Null }
if ((Test-Path (Join-Path $StateDir "gate-build")) -and (Test-Path (Join-Path $StateDir "gate-typecheck")) -and (Test-Path (Join-Path $StateDir "gate-lint"))) {
    New-Item (Join-Path $StateDir "quality-gates-passed") -Force | Out-Null
}
if ($ToolName -match "cortex_session_start")  { New-Item (Join-Path $StateDir "session-started") -Force | Out-Null }
if ($ToolName -match "cortex_session_end")    { New-Item (Join-Path $StateDir "session-ended") -Force | Out-Null }
if ($ToolName -match "cortex_quality_report") { New-Item (Join-Path $StateDir "quality-gates-passed") -Force | Out-Null }
exit 0
'@ | Out-File -FilePath "$hooksDir\track-quality.ps1" -Encoding utf8

        # session-end-check.ps1
        @'
$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (git rev-parse --show-toplevel 2>$null) }
if (-not $ProjectDir) { $ProjectDir = "." }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
if ((Test-Path (Join-Path $StateDir "session-started")) -and -not (Test-Path (Join-Path $StateDir "session-ended"))) {
    Write-Host "WARNING: cortex_session_end has not been called." -ForegroundColor Yellow
}
exit 0
'@ | Out-File -FilePath "$hooksDir\session-end-check.ps1" -Encoding utf8

        # settings.json for Windows
        # Use bash (Git Bash) for hooks — more reliable than PowerShell on Windows Claude Code
        @'
{
  "hooks": {
    "SessionStart": [{"matcher": "", "hooks": [{"type": "command", "command": "bash ${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-init.sh"}]}],
    "PreToolUse": [
      {"matcher": "Edit|Write|NotebookEdit|Bash", "hooks": [{"type": "command", "command": "bash ${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/enforce-session.sh"}]},
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "bash ${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/enforce-commit.sh"}]}
    ],
    "PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "bash ${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/track-quality.sh"}]}],
    "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "bash ${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-end-check.sh"}]}]
  }
}
'@ | Out-File -FilePath ".claude\settings.json" -Encoding utf8

        # Also install bash hooks (settings.json uses bash via Git Bash on Windows)
        @'
#!/bin/bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/session-started" "$STATE_DIR/quality-gates-passed" "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" "$STATE_DIR/session-ended" 2>/dev/null
echo "HARD REQUIREMENT: Call cortex_session_start IMMEDIATELY. ALL edits BLOCKED until you do."
'@ | Out-File -FilePath "$hooksDir\session-init.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
[ -f "$STATE_DIR/session-started" ] && exit 0
INPUT=$(cat)
TOOL_NAME=""
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || true)
  COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi
if [ -z "$TOOL_NAME" ]; then echo "BLOCKED: Cannot parse hook input." >&2; exit 2; fi
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) echo "BLOCKED: Call cortex_session_start first." >&2; exit 2 ;;
  Bash)
    if [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ (status|log|diff|branch|remote)|pnpm\ |npm\ |yarn\ |cargo\ |go\ |python|curl|dotnet\ ) ]]; then exit 0; fi
    if [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ |touch\ |chmod\ |sed\ -i|>\ ) ]]; then echo "BLOCKED: Call cortex_session_start first." >&2; exit 2; fi
    exit 0 ;;
esac
exit 0
'@ | Out-File -FilePath "$hooksDir\enforce-session.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
[[ ! "$COMMAND" =~ ^git\ (commit|push) ]] && exit 0
if [[ "$COMMAND" =~ ^git\ commit ]] && [ ! -f "$STATE_DIR/quality-gates-passed" ]; then echo "BLOCKED: Quality gates not passed." >&2; exit 2; fi
if [[ "$COMMAND" =~ ^git\ push ]]; then echo "REMINDER: Call cortex_code_reindex after push." >&2; fi
exit 0
'@ | Out-File -FilePath "$hooksDir\enforce-commit.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ build ]]    && touch "$STATE_DIR/gate-build"
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ typecheck ]] && touch "$STATE_DIR/gate-typecheck"
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ lint ]]      && touch "$STATE_DIR/gate-lint"
[ -f "$STATE_DIR/gate-build" ] && [ -f "$STATE_DIR/gate-typecheck" ] && [ -f "$STATE_DIR/gate-lint" ] && touch "$STATE_DIR/quality-gates-passed"
[[ "$TOOL_NAME" =~ cortex_session_start ]]  && touch "$STATE_DIR/session-started"
[[ "$TOOL_NAME" =~ cortex_session_end ]]    && touch "$STATE_DIR/session-ended"
[[ "$TOOL_NAME" =~ cortex_quality_report ]] && touch "$STATE_DIR/quality-gates-passed"
exit 0
'@ | Out-File -FilePath "$hooksDir\track-quality.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
if [ -f "$STATE_DIR/session-started" ] && [ ! -f "$STATE_DIR/session-ended" ]; then
  echo "WARNING: cortex_session_end has not been called."
fi
exit 0
'@ | Out-File -FilePath "$hooksDir\session-end-check.sh" -Encoding utf8 -NoNewline

        Write-Ok "Claude: hooks + settings.json installed (v$HOOKS_VERSION)"
    }

    # ── Gemini / Antigravity hooks ──
    if (Test-IDESelected "gemini") {
        $geminiHooksDir = ".gemini\hooks"
        if (-not (Test-Path $geminiHooksDir)) { New-Item -ItemType Directory -Path $geminiHooksDir -Force | Out-Null }

        @'
#!/bin/bash
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/session-started" "$STATE_DIR/quality-gates-passed" "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" "$STATE_DIR/session-ended" 2>/dev/null
echo '{"systemMessage":"MANDATORY: Call cortex_session_start before any work."}'
'@ | Out-File -FilePath "$geminiHooksDir\session-init.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
[ -f "$STATE_DIR/session-started" ] && { echo '{"decision":"allow"}'; exit 0; }
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
case "$TOOL_NAME" in
  write_file|edit_file|create_file|insert_text)
    echo '{"decision":"deny","reason":"BLOCKED: Call cortex_session_start first."}'; exit 0 ;;
  run_shell_command|shell)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
    if [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ ) ]]; then
      echo '{"decision":"deny","reason":"BLOCKED: Call cortex_session_start first."}'; exit 0
    fi ;;
esac
echo '{"decision":"allow"}'
'@ | Out-File -FilePath "$geminiHooksDir\enforce-session.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
if [[ "$COMMAND" =~ ^git\ commit ]] && [ ! -f "$STATE_DIR/quality-gates-passed" ]; then
  echo '{"decision":"deny","reason":"Quality gates not passed."}'; exit 0
fi
echo '{"decision":"allow"}'
'@ | Out-File -FilePath "$geminiHooksDir\enforce-commit.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ build ]]    && touch "$STATE_DIR/gate-build"
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ typecheck ]] && touch "$STATE_DIR/gate-typecheck"
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ lint ]]      && touch "$STATE_DIR/gate-lint"
[ -f "$STATE_DIR/gate-build" ] && [ -f "$STATE_DIR/gate-typecheck" ] && [ -f "$STATE_DIR/gate-lint" ] && touch "$STATE_DIR/quality-gates-passed"
[[ "$TOOL_NAME" =~ cortex_session_start ]]  && touch "$STATE_DIR/session-started"
[[ "$TOOL_NAME" =~ cortex_session_end ]]    && touch "$STATE_DIR/session-ended"
[[ "$TOOL_NAME" =~ cortex_quality_report ]] && touch "$STATE_DIR/quality-gates-passed"
echo '{"decision":"allow"}'
'@ | Out-File -FilePath "$geminiHooksDir\track-quality.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
if [ -f "$STATE_DIR/session-started" ] && [ ! -f "$STATE_DIR/session-ended" ]; then
  echo '{"systemMessage":"WARNING: Call cortex_session_end before ending."}'
fi
'@ | Out-File -FilePath "$geminiHooksDir\session-end-check.sh" -Encoding utf8 -NoNewline

        # Gemini settings.json
        @'
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": ".gemini/hooks/session-init.sh", "name": "cortex_session_init"}]}],
    "BeforeTool": [
      {"matcher": "write_file|edit_file|create_file|insert_text|run_shell_command|shell", "hooks": [{"type": "command", "command": ".gemini/hooks/enforce-session.sh", "name": "cortex_enforce_session"}]},
      {"matcher": "run_shell_command|shell", "hooks": [{"type": "command", "command": ".gemini/hooks/enforce-commit.sh", "name": "cortex_enforce_commit"}]}
    ],
    "AfterTool": [{"matcher": ".*", "hooks": [{"type": "command", "command": ".gemini/hooks/track-quality.sh", "name": "cortex_track_quality"}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": ".gemini/hooks/session-end-check.sh", "name": "cortex_session_end_check"}]}]
  }
}
'@ | Out-File -FilePath ".gemini\settings.json" -Encoding utf8

        Write-Ok "Gemini: hooks + settings.json installed (v$HOOKS_VERSION)"
    }

    # ── Instruction files for other IDEs ──
    $instructionContent = @"
<!-- cortex-hub:auto-mcp -->
## Cortex Hub - Auto MCP (MANDATORY)

At the START of every conversation:
1. Call ``cortex_session_start`` with repo: "$GitRepo", agentId: "__AGENT_ID__", mode: "development"
2. If ``recentChanges.count > 0``, warn user and run ``git pull``
3. Read ``STATE.md`` if it exists

### Error Protocol
1. ``cortex_knowledge_search`` first
2. Fix the error
3. Non-obvious fixes: ``cortex_knowledge_store``

### Quality Gates
Run verify commands from ``.cortex/project-profile.json``, then ``cortex_quality_report``.
End session: ``cortex_session_end`` with sessionId and summary.
<!-- cortex-hub:auto-mcp -->
"@

    if (Test-IDESelected "cursor") {
        ($instructionContent -replace "__AGENT_ID__", "cursor") | Out-File -FilePath ".cursorrules" -Encoding utf8
        Write-Ok "Created .cursorrules (cursor)"
    }
    if (Test-IDESelected "windsurf") {
        ($instructionContent -replace "__AGENT_ID__", "windsurf") | Out-File -FilePath ".windsurfrules" -Encoding utf8
        Write-Ok "Created .windsurfrules (windsurf)"
    }
    if (Test-IDESelected "vscode") {
        if (-not (Test-Path ".vscode")) { New-Item -ItemType Directory -Path ".vscode" -Force | Out-Null }
        ($instructionContent -replace "__AGENT_ID__", "vscode-copilot") | Out-File -FilePath ".vscode\copilot-instructions.md" -Encoding utf8
        Write-Ok "Created .vscode\copilot-instructions.md (vscode-copilot)"
    }
    if (Test-IDESelected "codex") {
        if (-not (Test-Path ".codex")) { New-Item -ItemType Directory -Path ".codex" -Force | Out-Null }
        ($instructionContent -replace "__AGENT_ID__", "codex") | Out-File -FilePath ".codex\instructions.md" -Encoding utf8
        Write-Ok "Created .codex\instructions.md (codex)"
    }

    # Write version marker
    $HOOKS_VERSION | Out-File -FilePath ".cortex\.hooks-version" -Encoding utf8 -NoNewline
    Write-Ok "Version: v$HOOKS_VERSION marked"
}

# ══════════════════════════════════════════════
# Phase 5: Lefthook
# ══════════════════════════════════════════════
if (-not (Test-Path "lefthook.yml")) {
    Write-Warn "Lefthook: run 'bash scripts/install.sh' on Git Bash for lefthook.yml generation"
} else {
    Write-Ok "Lefthook: already configured"
}

# ══════════════════════════════════════════════
# Phase 6: CLAUDE.md Injection
# ══════════════════════════════════════════════
$cortexMarker = "<!-- cortex-hub:auto-mcp -->"
$claudeMdContent = @"
$cortexMarker
## Cortex Hub — MANDATORY (enforced by hooks)

**YOUR FIRST ACTION in every conversation MUST be calling ``cortex_session_start``.**
If you skip this, all Edit/Write/file-modifying Bash commands will return exit code 2 (BLOCKED).

``cortex_session_start(repo: "$GitRepo", mode: "development", agentId: "claude-code")``

Then:
- If ``recentChanges.count > 0`` → warn user and ``git pull``
- Read ``STATE.md`` if it exists

### Quality gates (enforced — commit blocked without these)
Run verify commands from ``.cortex/project-profile.json``.
Call ``cortex_quality_report`` then ``cortex_session_end``.
$cortexMarker
"@

if (-not (Test-Path "CLAUDE.md")) {
    $claudeMdContent | Out-File -FilePath "CLAUDE.md" -Encoding utf8
    Write-Ok "CLAUDE.md: created"
} elseif (Select-String -Path "CLAUDE.md" -Pattern "cortex-hub:auto-mcp" -Quiet) {
    # Replace existing section
    $existing = Get-Content "CLAUDE.md" -Raw
    $pattern = [regex]::Escape($cortexMarker) + '[\s\S]*?' + [regex]::Escape($cortexMarker)
    $updated = [regex]::Replace($existing, $pattern, $claudeMdContent.Trim())
    $updated | Out-File -FilePath "CLAUDE.md" -Encoding utf8
    Write-Ok "CLAUDE.md: cortex section updated"
} else {
    Add-Content -Path "CLAUDE.md" -Value "`n$claudeMdContent"
    Write-Ok "CLAUDE.md: cortex section appended"
}

# ══════════════════════════════════════════════
# Phase 7: Summary
# ══════════════════════════════════════════════
Write-Host ""
Write-Host "  Cortex Hub setup complete (v$HOOKS_VERSION)" -ForegroundColor Green
Write-Host ""
Write-Host "  Project:   $(Split-Path $ProjectDir -Leaf)"
Write-Host "  MCP:       $(if ($McpConfigured) { 'configured' } else { 'needs API key' })"
Write-Host "  IDEs:      $($SelectedIDEs -join ', ')"
Write-Host "  Hooks:     v$HOOKS_VERSION"
Write-Host ""
if (-not $McpConfigured) { Write-Warn "Set HUB_API_KEY and re-run to configure MCP" }
Write-Host "  Restart your IDE to pick up changes" -ForegroundColor Cyan
Write-Host ""
