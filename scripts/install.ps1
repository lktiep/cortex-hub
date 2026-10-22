# Cortex Hub — Unified Installer (v0.9.0) — Windows PowerShell
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
$HOOKS_VERSION = 7
$HOOKS_MINOR = 15
$LATEST_VERSION = "$HOOKS_VERSION.$HOOKS_MINOR"
$MCP_URL_DEFAULT = "http://localhost:8318/mcp"

# ── Helpers ──
function Write-Info  { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Blue }
function Write-Ok    { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Red }



# ── Find project root ──
try {
    $ProjectDir = (git rev-parse --show-toplevel 2>&1) | Where-Object { $_ -is [string] }
    if ($LASTEXITCODE -ne 0 -or -not $ProjectDir) { throw "not a git repo" }
} catch {
    $ProjectDir = (Get-Location).Path
}
Set-Location $ProjectDir
try {
    $GitRepo = (git remote get-url origin 2>&1) | Where-Object { $_ -is [string] }
    if ($LASTEXITCODE -ne 0 -or -not $GitRepo) { throw "no remote" }
} catch {
    $GitRepo = "unknown"
}

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
    if ((Test-Path "$env:USERPROFILE\.codeium") -or (Get-Command windsurf -ErrorAction SilentlyContinue)) {
        $detected += "windsurf"
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

# Check ALL IDE config files for cortex-hub MCP entry
$IdeConfigs = @(
    $ClaudeJson,
    (Join-Path $env:USERPROFILE ".cursor\mcp.json"),
    (Join-Path $env:USERPROFILE ".codeium\windsurf\mcp_config.json"),
    (Join-Path $env:USERPROFILE ".gemini\antigravity\mcp_config.json"),
    ".vscode\mcp.json"
)
foreach ($cf in $IdeConfigs) {
    if ((Test-Path $cf) -and (Select-String -Path $cf -Pattern "cortex-hub" -Quiet)) {
        $McpConfigured = $true
        Write-Ok "MCP: configured (found cortex-hub in $cf)"
        break
    }
}

if (-not $McpConfigured) {
    $ApiKey = $env:HUB_API_KEY
    if (-not $ApiKey -and (Test-Path ".env")) {
        $envLine = Select-String -Path ".env" -Pattern "^HUB_API_KEY=" | Select-Object -First 1
        if ($envLine) { $ApiKey = ($envLine.Line -split "=", 2)[1].Trim('"', "'") }
    }

    if ($ApiKey -and -not $CheckOnly) {
        $McpUrl = if ($env:HUB_MCP_URL) { $env:HUB_MCP_URL } else { $MCP_URL_DEFAULT }
        Write-Info "Configuring MCP in ~/.claude.json..."

        # Pure PowerShell JSON merge — no Python needed
        function Set-McpConfig {
            param([string]$Path, [string]$RootKey, [string]$Label, [string]$Kind = "mcp-remote")
            $dir = Split-Path $Path -Parent
            if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

            # Build MCP entry as ordered dict (PS 5.1 compatible)
            if ($Kind -eq "http") {
                # Claude Code's own form: type http with url and headers
                $mcpEntry = [ordered]@{
                    type = "http"
                    url = $McpUrl
                    headers = [ordered]@{ Authorization = "Bearer $ApiKey" }
                }
            } else {
                $mcpEntry = [ordered]@{
                    command = "npx"
                    args = @("-y", "mcp-remote", $McpUrl, "--header", "Authorization:`${AUTH_HEADER}")
                    env = [ordered]@{ AUTH_HEADER = "Bearer $ApiKey" }
                }
            }

            if (Test-Path $Path) {
                try {
                    $json = Get-Content $Path -Raw | ConvertFrom-Json
                    # Add or update the root key
                    if (-not ($json | Get-Member -Name $RootKey -ErrorAction SilentlyContinue)) {
                        $json | Add-Member -NotePropertyName $RootKey -NotePropertyValue (New-Object PSObject)
                    }
                    $servers = $json.$RootKey
                    if ($servers | Get-Member -Name "cortex-hub" -ErrorAction SilentlyContinue) {
                        $servers."cortex-hub" = New-Object PSObject -Property $mcpEntry
                    } else {
                        $servers | Add-Member -NotePropertyName "cortex-hub" -NotePropertyValue (New-Object PSObject -Property $mcpEntry)
                    }
                    $json | ConvertTo-Json -Depth 5 | Out-File -FilePath $Path -Encoding utf8
                } catch {
                    # File corrupt or empty — create fresh
                    $fresh = [ordered]@{ $RootKey = [ordered]@{ "cortex-hub" = $mcpEntry } }
                    New-Object PSObject -Property $fresh | ConvertTo-Json -Depth 5 | Out-File -FilePath $Path -Encoding utf8
                }
            } else {
                $fresh = [ordered]@{ $RootKey = [ordered]@{ "cortex-hub" = $mcpEntry } }
                New-Object PSObject -Property $fresh | ConvertTo-Json -Depth 5 | Out-File -FilePath $Path -Encoding utf8
            }
            Write-Ok ("MCP: configured " + $Label)
        }

        Set-McpConfig -Path $ClaudeJson -RootKey "mcpServers" -Label "Claude Code" -Kind "http"
        $McpConfigured = $true

        if (Test-IDESelected "cursor") {
            Set-McpConfig -Path (Join-Path $env:USERPROFILE ".cursor\mcp.json") -RootKey "mcpServers" -Label "Cursor"
        }
        if (Test-IDESelected "windsurf") {
            Set-McpConfig -Path (Join-Path $env:USERPROFILE ".codeium\windsurf\mcp_config.json") -RootKey "mcpServers" -Label "Windsurf"
        }
        if (Test-IDESelected "gemini") {
            Set-McpConfig -Path (Join-Path $env:USERPROFILE ".gemini\antigravity\mcp_config.json") -RootKey "mcpServers" -Label "Gemini"
        }
        if (Test-IDESelected "vscode") {
            Set-McpConfig -Path ".vscode\mcp.json" -RootKey "servers" -Label "VS Code"
        }
        if (Test-IDESelected "codex") {
            $codexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
            $codexDir = Split-Path $codexConfig -Parent
            if (-not (Test-Path $codexDir)) { New-Item -ItemType Directory -Path $codexDir -Force | Out-Null }
            if (-not (Test-Path $codexConfig) -or -not (Select-String -Path $codexConfig -Pattern "cortex-hub" -Quiet)) {
                $tomlBlock = "`n[mcp_servers.cortex-hub]`ncommand = `"npx`"`nargs = [`"-y`", `"mcp-remote`", `"$McpUrl`", `"--header`", `"Authorization:Bearer $ApiKey`"]"
                Add-Content -Path $codexConfig -Value $tomlBlock
                Write-Ok "MCP: configured Codex"
            }
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
    Write-Host "  Hooks version:  $InstalledVersion (latest: $LATEST_VERSION)"
    Write-Host "  Profile:        $(if (Test-Path '.cortex\project-profile.json') { 'yes' } else { 'no' })"
    Write-Host "  Claude hooks:   $(if (Test-Path '.claude\hooks\enforce-session.sh') { 'yes' } else { 'no' })"
    Write-Host "  Lefthook:       $(if (Test-Path 'lefthook.yml') { 'yes' } else { 'no' })"
    if ($InstalledVersion -ne $LATEST_VERSION) { Write-Warn ("Update available: " + $InstalledVersion + " -> " + $LATEST_VERSION + ". Run /install --force") }
    exit 0
}

$NeedsUpdate = $false
if ($Force) {
    $NeedsUpdate = $true
    Write-Info "Force mode: regenerating all files"
} elseif ($InstalledVersion -ne $LATEST_VERSION) {
    $NeedsUpdate = $true
    Write-Info ("Updating hooks v" + $InstalledVersion + " -> v" + $LATEST_VERSION)
} elseif (-not (Test-Path ".claude\hooks\enforce-session.sh")) {
    $NeedsUpdate = $true
    Write-Info "Missing files detected, regenerating..."
} else {
    Write-Ok ("Hooks: up to date (v" + $LATEST_VERSION + ")")
}

# ══════════════════════════════════════════════
# Phase 3: Detect Project Stack
# ══════════════════════════════════════════════
if (-not (Test-Path ".cortex\project-profile.json") -or $Force) {
    Write-Info "Detecting project stacks..."
    $PkgManager = "unknown"
    $DetectedStacks = @()
    $PreCommitCmds = @()
    $FullCmds = @()

    # Node.js
    if (Test-Path "package.json") {
        if (Test-Path "pnpm-lock.yaml") { $PkgManager = "pnpm" }
        elseif (Test-Path "yarn.lock") { $PkgManager = "yarn" }
        else { $PkgManager = "npm" }
        $DetectedStacks += "node:$PkgManager"

        $scripts = try { ((Get-Content "package.json" -Raw | ConvertFrom-Json).scripts | Get-Member -MemberType NoteProperty).Name -join " " } catch { "" }
        foreach ($s in @("build", "typecheck", "lint")) {
            if ($scripts -match "\b$s\b") {
                $PreCommitCmds += "`"$PkgManager $s`""
                $FullCmds += "`"$PkgManager $s`""
            }
        }
        if ($scripts -match "\btest\b") { $FullCmds += "`"$PkgManager test`"" }
        # A repo with its own `verify` script has already said what "fully checked" means.
        # An exact name: "\bverify\b" would take `verify:ci` for it.
        if (($scripts -split ' ') -contains "verify") {
            $FullCmds = @(if ($PkgManager -eq "npm") { "`"npm run verify`"" } else { "`"$PkgManager verify`"" })
        }
    }
    # Go
    if (Test-Path "go.mod") {
        $PkgManager = "go"; $DetectedStacks += "go"
    }
    # Rust
    if (Test-Path "Cargo.toml") {
        $PkgManager = "cargo"; $DetectedStacks += "rust"
    }
    # Python (with manifest)
    if ((Test-Path "requirements.txt") -or (Test-Path "pyproject.toml") -or (Test-Path "setup.py") -or (Test-Path "Pipfile")) {
        $DetectedStacks += "python"
        if ($PkgManager -eq "unknown") { $PkgManager = "pip" }
    }
    # .NET (root)
    if ((Get-ChildItem -Filter "*.csproj" -ErrorAction SilentlyContinue) -or (Get-ChildItem -Filter "*.sln" -ErrorAction SilentlyContinue)) {
        $DetectedStacks += "dotnet:root"
        if ($PkgManager -eq "unknown") { $PkgManager = "dotnet" }
    }
    # .NET (subdirectory)
    elseif (Get-ChildItem -Recurse -Depth 2 -Filter "*.sln" -ErrorAction SilentlyContinue) {
        $slnFile = (Get-ChildItem -Recurse -Depth 2 -Filter "*.sln" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
        $slnRelative = $slnFile.Substring($ProjectDir.Length + 1) -replace '\\', '/'
        $DetectedStacks += "dotnet:$slnRelative"
        if ($PkgManager -eq "unknown") { $PkgManager = "dotnet-mixed" }
    }
    # Godot
    $godotFile = Get-ChildItem -Recurse -Depth 3 -Filter "project.godot" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($godotFile) {
        $godotDir = $godotFile.DirectoryName.Substring($ProjectDir.Length + 1) -replace '\\', '/'
        $DetectedStacks += "godot:$godotDir"
    }
    # Python scripts (no manifest)
    if (-not ($DetectedStacks -match "python") -and (Get-ChildItem -Recurse -Depth 2 -Filter "*.py" -ErrorAction SilentlyContinue)) {
        $DetectedStacks += "python-scripts"
    }

    if ($DetectedStacks.Count -eq 0) {
        Write-Warn "Stack: no recognized project types found"
    } elseif ($DetectedStacks.Count -eq 1) {
        Write-Ok ("Stack: " + $DetectedStacks[0])
    } else {
        Write-Ok ("Stack: mixed project - " + ($DetectedStacks -join ", "))
    }

    $projectName = Split-Path $ProjectDir -Leaf
    $detectedAt = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'
    $preCommitArr = if ($PreCommitCmds.Count -gt 0) { @($PreCommitCmds | ForEach-Object { $_.Trim('"') }) } else { @() }
    $fullArr = if ($FullCmds.Count -gt 0) { @($FullCmds | ForEach-Object { $_.Trim('"') }) } else { @() }

    $profile = New-Object PSObject -Property ([ordered]@{
        schema_version = "2.0"
        project_name   = $projectName
        fingerprint    = New-Object PSObject -Property ([ordered]@{
            package_manager = $PkgManager
            stacks          = @($DetectedStacks)
            detected_at     = $detectedAt
        })
        verify = New-Object PSObject -Property ([ordered]@{
            pre_commit = $preCommitArr
            full       = $fullArr
            auto_fix   = $true
            max_retries = 2
        })
    })
    $profile | ConvertTo-Json -Depth 4 | Out-File -FilePath ".cortex\project-profile.json" -Encoding utf8
    $stackLabel = $DetectedStacks -join ", "
    Write-Ok ("Profile: .cortex\project-profile.json created (" + $stackLabel + ")")
} else {
    Write-Ok "Profile: already exists"
}

# ══════════════════════════════════════════════
# Phase 4: Install Hooks (if needed)
# ══════════════════════════════════════════════
if ($NeedsUpdate) {
    # ── Claude Code hooks (bash .sh files) ──
    # Claude Code uses /usr/bin/bash for hooks on ALL platforms (confirmed from error logs).
    # Generate .sh scripts identical to what install.sh creates on macOS/Linux.
    if (Test-IDESelected "claude") {
        $hooksDir = ".claude\hooks"
        if (-not (Test-Path $hooksDir)) { New-Item -ItemType Directory -Path $hooksDir -Force | Out-Null }
        if (-not (Test-Path ".cortex\.session-state")) { New-Item -ItemType Directory -Path ".cortex\.session-state" -Force | Out-Null }

        # Helper: write .sh file with Unix line endings (LF only)
        function Write-ShHook { param([string]$Name, [string]$Content)
            [System.IO.File]::WriteAllText(
                (Join-Path $hooksDir "$Name.sh"),
                $Content.Replace("`r`n", "`n"),
                [System.Text.UTF8Encoding]::new($false)
            )
        }

        # session-init.sh
        Write-ShHook "session-init" @'
#!/bin/bash
# Cortex Session Init (v7.4) — arms the gates; keeps discovery state across compaction.
#
# SessionStart fires on four different things: startup, resume, clear and compact.
# Wiping the discovery markers on all four is why a long task suddenly finds Grep and
# Edit blocked again halfway through itself — the context was compacted, the work was
# not restarted. Only a genuinely new session clears the gates.
#
# v7.0 also touched `session-started` here, which made the whole session gate vacuous: the
# marker existed before cortex_session_start had ever been called, so the "no session yet"
# branch of enforce-session.sh was dead code and enforce-commit.sh's session check always
# passed. Only the tracker writes that marker now, from a real cortex_session_start call.
#
# v7.2 prints this conversation's id for /cs to pass as clientSessionId. Everything else the
# hub matches a session on is the same for two conversations in one checkout, so without it
# they shared one session, and the first to finish closed it under the other.
#
# v7.4 stops printing it. A line that differs in every conversation, this early in the
# context, kept the prompt cache from reusing anything after it. session-id.sh now puts the
# id straight into the cortex_session_start call.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat 2>/dev/null || true)
SOURCE=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("source",""))' 2>/dev/null || true)
  fi
fi

case "$SOURCE" in
  compact|resume)
    echo "Cortex: same session (${SOURCE}) — discovery state kept, gates stay as they were."
    exit 0 ;;
esac

# A new session: everything from the last one is stale, including the markers that
# were never reset before and so stayed satisfied for months.
rm -f "$STATE_DIR/session-started" \
      "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/quality-reported" \
      "$STATE_DIR/session-ended" "$STATE_DIR/discovery-used" \
      "$STATE_DIR/knowledge-recalled" "$STATE_DIR/memory-recalled" \
      "$STATE_DIR/changes-checked" "$STATE_DIR/tasks-checked" \
      "$STATE_DIR/gate-off" "$STATE_DIR/session-id" 2>/dev/null
rm -rf "$STATE_DIR/agents" 2>/dev/null
# Other conversations' sessions stay theirs to close; only records a week old are dropped,
# left by a conversation that ended without the exit hook getting through.
[ -d "$STATE_DIR/conversations" ] && find "$STATE_DIR/conversations" -type f -mtime +7 -exec rm -f {} + 2>/dev/null
# The lookup nudge keeps a counter per conversation and agent; a day-old one is done with.
[ -d "$STATE_DIR/nudge" ] && find "$STATE_DIR/nudge" -type f -mtime +1 -exec rm -f {} + 2>/dev/null
# File notes are shown once per conversation and agent; the record of which were is a day's.
[ -d "$STATE_DIR/notes" ] && find "$STATE_DIR/notes" -type f -name 'shown-*' -mtime +1 -exec rm -f {} + 2>/dev/null
echo "Run /cs first: cortex_session_start, then knowledge+memory recall. Until then edits are BLOCKED, and Grep/Glob stay blocked until a cortex discovery tool has run."
exit 0
'@

        # enforce-session.sh
        Write-ShHook "enforce-session" @'
#!/bin/bash
# Cortex Session Enforcement (v6.3) — hold tools back until the cortex workflow is followed.
#
# What this can and cannot do: the hook shares a filesystem with the agent it gates, so
# it cannot stop an agent that decides to forge a marker. What it can do is make the
# correct path the easy one, and make the wrong path visible. That is why markers must
# now carry evidence of a real tool call instead of merely existing, and why the way out
# is an explicit, named file rather than a silent trick.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

INPUT=$(cat)
TOOL_NAME=""
COMMAND=""
AGENT_ID=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  # Without this fallback the whole gate silently became a no-op on any machine without jq.
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'AGENT_ID={repr(str(d.get(\"agent_id\",\"\")))}')
" 2>/dev/null || true)"
fi
# A subagent's calls carry its agent_id; the tracker files its recall under the same name.
SAFE_ID=$(printf '%s' "$AGENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
# An id with nothing usable left in it is still a subagent's, never the parent's.
[ -n "$AGENT_ID" ] && [ -z "$SAFE_ID" ] && SAFE_ID=unnamed
AGENT_ID="$SAFE_ID"

[ -z "$TOOL_NAME" ] && { echo "BLOCKED: Cannot parse hook input (install jq or python3)." >&2; exit 2; }

# An escape hatch that has to be asked for out loud. When the hub is unreachable the
# tools this gate points at cannot run, and a gate with no path through it just stops
# the work — so there is a way out, it is one line, and it leaves a trace.
if [ -s "$STATE_DIR/gate-off" ]; then
  exit 0
fi

# A marker counts only if a tool wrote evidence into it. An empty file is a touch.
marker_ok() {
  [ -s "$STATE_DIR/$1" ] && grep -q '^tool=' "$STATE_DIR/$1" 2>/dev/null
}

# A search command counts as codebase search when it *starts* a command: `cd apps && grep -r x`
# is the search this gate is about. `pnpm build | grep error` filters output of something
# else and has nothing to do with finding code, so it stays allowed.
is_codebase_search() {
  # Everything after a heredoc marker is data being written, not commands being run —
  # a file whose text happens to contain the word grep is not a search.
  local cmd="${1%%<<*}"
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*|\([[:space:]]*)[[:space:]]*(sudo[[:space:]]+)?(grep|egrep|fgrep|rg|ag|ack|find|fd)[[:space:]]' && return 0
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*)[[:space:]]*git[[:space:]]+grep[[:space:]]' && return 0
  return 1
}

# Writing the escape hatch itself can never be blocked by the gate it opens, or the only
# way out of a gate armed against an unreachable hub is a trick.
is_gate_off_write() {
  printf '%s' "$1" | grep -Eq '>[[:space:]]*"?[^"[:space:]]*\.cortex/\.session-state/gate-off"?[[:space:]]*$'
}

# Editing through Bash is still editing. Gating Edit/Write while leaving `cat > file`,
# `sed -i` and `tee` open meant the recall gate only ever applied to agents that used
# the dedicated tools.
is_file_write() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  # Drop the redirects that write nowhere — `2>/dev/null` and `>&2` are not file edits —
  # then anything left pointing at a name is one.
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  return 1
}

HOW_OUT="If the Cortex hub is unreachable (MCP reports CONNECTION_CLOSED), say so and write the reason: echo 'hub unreachable' > .cortex/.session-state/gate-off"

# ── Session started: enforce discovery-first + knowledge/memory recall ──
if [ -f "$STATE_DIR/session-started" ]; then
  if ! marker_ok discovery-used; then
    if [ "$TOOL_NAME" = "Grep" ] || [ "$TOOL_NAME" = "Glob" ]; then
      echo "BLOCKED: use cortex_code_search first — it is AST-aware and returns the target file inside the top 10 far more reliably than a pattern guess. $HOW_OUT" >&2
      exit 2
    fi
    if [ "$TOOL_NAME" = "Bash" ] && is_codebase_search "$COMMAND"; then
      echo "BLOCKED: use cortex_code_search first. find/grep/rg unlock once a cortex discovery tool has run — and stay the right choice for an exact literal (env var, config key, error string), not for a question about behaviour. $HOW_OUT" >&2
      exit 2
    fi
  fi

  # Recall is a precondition for writing, not a consolation prize for not having
  # searched. This block used to live inside the `! marker_ok discovery-used`
  # branch above, so a single cortex_code_search call retired the requirement for
  # the rest of the session — while CLAUDE.md said editing without both recalls is
  # refused, full stop.
  WRITES_A_FILE=0
  case "$TOOL_NAME" in
    Edit|Write|NotebookEdit) WRITES_A_FILE=1 ;;
    Bash) is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" && WRITES_A_FILE=1 ;;
  esac
  if [ "$WRITES_A_FILE" = "1" ]; then
    # A subagent starts with none of the parent's recall in its context, so the parent's
    # markers do not open the gate for it: it recalls for its own task, under its own id.
    if [ -n "$AGENT_ID" ]; then
      if ! marker_ok "agents/$AGENT_ID/knowledge-recalled" || ! marker_ok "agents/$AGENT_ID/memory-recalled"; then
        echo "BLOCKED: you are a subagent, and the parent's recall is not in your context. Run cortex_knowledge_search and cortex_memory_search on your own task before editing. $HOW_OUT" >&2
        exit 2
      fi
      exit 0
    fi
    if ! marker_ok knowledge-recalled || ! marker_ok memory-recalled; then
      echo "BLOCKED: run cortex_knowledge_search and cortex_memory_search before editing, with the words of the task in hand (the feature, the error) — they restore what previous sessions already decided and already fixed. Run /cs to do every step at once. $HOW_OUT" >&2
      exit 2
    fi
  fi
  exit 0
fi

# ── Session NOT started: block writes and codebase search, allow plain reads ──
# Until v7.1 of session-init this branch never ran: the init hook created the session-started
# marker itself, so every session looked started before cortex_session_start was ever called.
#
# Searching is reading, and what this gate wants before it is a cortex lookup, not a session.
# Until v6.3 a search stayed blocked here after cortex_code_search had run, under a message
# saying that very call unlocks it: an agent asked a quick question looked the code up, was
# refused grep twice, and read whole files instead — 25k characters where one grep would do.
SEARCH_HINT="BLOCKED: look it up with cortex_code_search (a behaviour) or cortex_code_context (a symbol name) first. One call unlocks find/grep/rg and Grep/Glob for the rest of the session. $HOW_OUT"
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit)
    echo "BLOCKED: call cortex_session_start first (or run /cs). No edits without a session." >&2
    exit 2 ;;
  Grep|Glob)
    marker_ok discovery-used && exit 0
    echo "$SEARCH_HINT" >&2
    exit 2 ;;
  Bash)
    if is_codebase_search "$COMMAND" && ! marker_ok discovery-used; then
      echo "$SEARCH_HINT" >&2
      exit 2
    fi
    # The write check goes before the read allowlist, or `cat > file` passes as a read.
    if is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND"; then
      echo "BLOCKED: call cortex_session_start first (or run /cs). No file modifications without a session." >&2
      exit 2
    fi
    # Where a command starts, and before the read allowlist: unanchored, `cp ` matched the end of
    # `hub-mcp ` and refused a read-only grep over that directory, while `ls; rm x` passed as a read.
    MODIFIES='(^|[;&|(])[[:space:]]*(git[[:space:]]+(add|commit|push|reset)|rm|mv|cp|mkdir|touch|chmod)[[:space:]]'
    [[ "$COMMAND" =~ $MODIFIES ]] && {
      echo "BLOCKED: call cortex_session_start first (or run /cs). No file modifications without a session." >&2
      exit 2
    }
    [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ (status|log|diff|branch|remote|show)|pnpm\ |npm\ |yarn\ |cargo\ |go\ |python|curl|dotnet\ |node\ ) ]] && exit 0
    exit 0 ;;
esac
exit 0
'@

        # enforce-commit.sh
        Write-ShHook "enforce-commit" @'
#!/bin/bash
# Cortex Commit Enforcement (v5.1) — a commit needs the workflow behind it.
#
# v4 accepted `quality-gates-passed`, which the tracker used to write the moment
# cortex_quality_report was called — so reporting a failure unlocked the commit just as
# well as passing. The marker now comes only from build/typecheck/lint actually running
# green, and the report is a separate, softer expectation.
# v5.1 refuses to skip the repo's own git hooks (--no-verify, `commit -n`, LEFTHOOK=0).
# install.sh leaves a repo that runs its checks from git hooks to those hooks, so skipping
# them skips the checks. The rule lives here and not in the repo: cortex writes this file,
# and a rule the repo added to it would be overwritten by the next install.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi

# Prints why a command skips the repo's git hooks; prints nothing when it does not.
skips_hooks() {
  local cmd q="'"
  local b='(^|[;&|(`[:space:]])' seg='[^;&|)]' end='([;&|)[:space:]]|$)'
  # A heredoc body is text (a commit message), not flags: drop it and keep the line that
  # opens it. Then join `\` continuations and make every line a `;`-separated command.
  cmd=$(printf '%s\n' "$1" | awk '
    tag != "" { t = $0; sub(/^\t+/, "", t); if (t == tag) tag = ""; next }
    { print
      if (match($0, /(^|[^<])<<-?[ \t]*["\047]?[A-Za-z_][A-Za-z0-9_]*/)) {
        tag = substr($0, RSTART, RLENGTH); sub(/^[^<]?<<-?[ \t]*["\047]?/, "", tag)
      } }' | awk '/\\$/ { sub(/\\$/, ""); printf "%s ", $0; next } { print }' | tr '\n' ';')
  # Quoted arguments are messages and bodies; a flag named inside one is not a flag.
  # `LEFTHOOK="0"` keeps its quotes: they follow `=`, not a space.
  cmd=$(printf '%s' "$cmd" | sed -E "s/(^|[[:space:]])'[^']*'/\1/g; s/(^|[[:space:]])\"[^\"]*\"/\1/g; s/(--[a-z-]+=)'[^']*'/\1/g; s/(--[a-z-]+=)\"[^\"]*\"/\1/g")
  local re="${b}(export[[:space:]]+)?LEFTHOOK=[\"$q]?(0|false)([\"$q;&|)[:space:]]|\$)"
  if [[ "$cmd" =~ $re ]]; then echo "LEFTHOOK=0 turns lefthook off"; return; fi
  # git takes any unambiguous prefix of a long option, so --no-veri is --no-verify.
  re="${b}git[[:space:]]${seg}*[[:space:]]--no-veri[a-z]*(=|${end})"
  if [[ "$cmd" =~ $re ]]; then echo "--no-verify skips the hooks"; return; fi
  # `git commit -n` is --no-verify. Only flags that take no value may come before the n:
  # `-mnew` is `-m new`. `git push -n` is --dry-run and stays allowed.
  local opt='[[:space:]]+-[^[:space:];&|)]*([[:space:]]+[^-[:space:];&|)][^[:space:];&|)]*)?'
  re="${b}git(${opt})*[[:space:]]+commit([[:space:]]${seg}*)?[[:space:]]-[apseioqvz]*n[a-zA-Z]*${end}"
  if [[ "$cmd" =~ $re ]]; then echo "git commit -n is --no-verify"; return; fi
}
# Checked before the `^git` match below, so `cd x && git commit --no-verify` is caught too.
SKIP_REASON=$(skips_hooks "$COMMAND")
if [ -n "$SKIP_REASON" ]; then
  echo "BLOCKED: this skips the repo's git hooks ($SKIP_REASON)." >&2
  echo "Those hooks are the repo's own checks. Run the command without the skip and fix what they report;" >&2
  echo "if a hook itself is broken, ask the user to run the command." >&2
  exit 2
fi

[[ ! "$COMMAND" =~ ^git\ (commit|push) ]] && exit 0

if [[ "$COMMAND" =~ ^git\ commit ]]; then
  MISSING=""
  [ ! -f "$STATE_DIR/session-started" ] && MISSING="${MISSING}\n  - cortex_session_start (not called)"
  [ ! -s "$STATE_DIR/discovery-used" ] && MISSING="${MISSING}\n  - cortex_code_search / code_context / knowledge_search (no discovery recorded — search before you edit)"
  [ ! -s "$STATE_DIR/quality-gates-passed" ] && MISSING="${MISSING}\n  - Quality gates: run build, typecheck and lint and let them pass (calling cortex_quality_report no longer counts)"
  if [ -n "$MISSING" ]; then
    echo "BLOCKED: cannot commit — missing Cortex workflow steps:${MISSING}" >&2
    echo "" >&2
    echo "See the 'Finding code fast' and 'Quality Gates' sections of CLAUDE.md." >&2
    exit 2
  fi
  [ ! -s "$STATE_DIR/quality-reported" ] && echo "REMINDER: call cortex_quality_report with the gate results so the dashboard sees this session." >&2
fi

if [[ "$COMMAND" =~ ^git\ push ]]; then
  echo "REMINDER: after push, call cortex_code_reindex so code intelligence matches what you pushed." >&2
fi
exit 0
'@

        # track-quality.sh
        Write-ShHook "track-quality" @'
#!/bin/bash
# Cortex Quality Tracker (v4.3) — records what actually happened, as evidence.
#
# Two things changed from v3, both of them bugs found by reading a real hook payload:
#   1. The field is `tool_response`, not `tool_output`. v3 read `tool_output`, so the
#      session id was never captured and the auto-close on exit never had anything to
#      close — on this repo `.cortex/.session-state/session-id` had never once been written.
#   2. Markers were empty files, so a `touch` was indistinguishable from a tool call and
#      the gates could be satisfied without doing any of the work. They now carry the tool
#      name and a timestamp, and the enforcement hook requires that content.
#
# Note on exit codes: PostToolUse does not fire at all when a Bash command exits non-zero,
# so a failing `pnpm build` cannot mark its gate. What it can still do is hide the failure
# behind `|| true` or a pipe, which is why the output is scanned for failure signatures.
#
# v4.2 also files the hub session under the conversation that opened it, in
# conversations/<IDE session id>: the rest of this directory is shared by every conversation
# in the checkout, so the exit hook had no way to tell whose session `session-id` was.
#
# v4.3 files a subagent's recall under agents/<agent_id> as well: the recall gate asks a
# subagent for its own, since none of the parent's is in its context.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat)
COMMAND=""
TOOL_NAME=""
OUTPUT=""
CLIENT_ID=""
AGENT_ID=""

if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
  CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('tool_response', d.get('tool_output',''))
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(r, ensure_ascii=False) if not isinstance(r,str) else r)}')
print(f'CLIENT_ID={repr(str(d.get(\"session_id\",\"\")))}')
print(f'AGENT_ID={repr(str(d.get(\"agent_id\",\"\")))}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# The IDE's id for this conversation, made safe to use as a file name.
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
SAFE_ID=$(printf '%s' "$AGENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
# An id with nothing usable left in it is still a subagent's, never the parent's.
[ -n "$AGENT_ID" ] && [ -z "$SAFE_ID" ] && SAFE_ID=unnamed
AGENT_ID="$SAFE_ID"

# Evidence, not existence: the enforcement hook only accepts a marker that says who wrote it.
record() {
  printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"
}

# The same evidence, filed under the subagent that made the call.
record_agent() {
  [ -n "$AGENT_ID" ] || return 0
  mkdir -p "$STATE_DIR/agents/$AGENT_ID"
  record "agents/$AGENT_ID/$1"
}

# A command that reports success while the build failed — `pnpm build || true`, or a pipe
# that swallows the status. If the output says it failed, the gate does not open.
# ESLint prints "✖ N problems (0 errors, N warnings)" for warnings alone, so a bare ✖
# is not a failure; only an error count above zero is.
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖ [0-9]+ problems? \([1-9]|FAIL |Exit status [1-9]'
}

# 1 = this command is not one of the quality gates. mark_gate flips it, and the
# invalidation block at the bottom reads it, so `pnpm build | tee build.log` does not
# revoke the very marker it just armed.
GATE_COMMAND=1
mark_gate() {
  GATE_COMMAND=0
  looks_failed && return 0
  record "$1" "$COMMAND"
}

[[ "$COMMAND" =~ (pnpm|npm|yarn)\ build ]]    && mark_gate gate-build
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ typecheck ]] && mark_gate gate-typecheck
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ lint ]]      && mark_gate gate-lint
[[ "$COMMAND" =~ cargo\ build ]]               && mark_gate gate-build
[[ "$COMMAND" =~ cargo\ clippy ]]              && mark_gate gate-lint
[[ "$COMMAND" =~ go\ build ]]                  && mark_gate gate-build
[[ "$COMMAND" =~ go\ vet ]]                    && mark_gate gate-lint
[[ "$COMMAND" =~ dotnet\ build ]]              && mark_gate gate-build

# Quality gates pass when the commands passed — not when a tool was called to say so.
if [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-typecheck" ] && [ -s "$STATE_DIR/gate-lint" ]; then
  record quality-gates-passed "build+typecheck+lint"
elif [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-lint" ] && [ ! -s "$STATE_DIR/gate-typecheck" ]; then
  # Languages without a separate typecheck step (Go, Rust): build + lint is the full set.
  if [ -f "$PROJECT_DIR/.cortex/project-profile.json" ] \
     && ! grep -q '"typecheck"' "$PROJECT_DIR/.cortex/project-profile.json" 2>/dev/null; then
    record quality-gates-passed "build+lint (no typecheck in project-profile)"
  fi
fi

# ── Cortex tool calls ──
case "$TOOL_NAME" in
  *cortex_session_start*)
    record session-started
    # The id arrives inside an MCP text block, so the JSON is escaped one level deep —
    # dropping the backslashes first is what makes one pattern work for both shapes.
    # Only a hub id: every hook payload opens with the IDE's own "session_id" (a conversation
    # uuid), and `head -1` used to take that one, so the exit hook tried to close a session
    # the hub had never heard of. The hub mints nothing but sess_… ids.
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"sess_[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    if [ -n "$SESSION_ID" ] && [ -n "$CLIENT_ID" ]; then
      mkdir -p "$STATE_DIR/conversations"
      printf '%s\n' "$SESSION_ID" > "$STATE_DIR/conversations/$CLIENT_ID"
    fi
    # A new hub session is open, so an earlier one's "ended" no longer applies — left in
    # place it made the exit hook skip this session too.
    rm -f "$STATE_DIR/session-ended"
    ;;
  *cortex_session_end*)
    record session-ended
    # This conversation closed its own session; the exit hook has nothing left to do for it.
    [ -n "$CLIENT_ID" ] && rm -f "$STATE_DIR/conversations/$CLIENT_ID"
    ;;
  *cortex_quality_report*) record quality-reported ;;
  *cortex_code_search*|*cortex_code_context*|*cortex_code_impact*|*cortex_cypher*)
    record discovery-used ;;
  # Recall is not discovery: knowledge and memory answer "why" and "has this broken before",
  # not "where is the code". Arming discovery-used here would let /cs alone open Grep and Glob.
  *cortex_knowledge_search*) record knowledge-recalled; record_agent knowledge-recalled ;;
  *cortex_memory_search*)    record memory-recalled; record_agent memory-recalled ;;
  *cortex_task_pickup*)    record tasks-checked ;;
  *cortex_detect_changes*|*cortex_changes*) record changes-checked ;;
esac

# ── A passing build certifies a tree, not a session ──
#
# The gate markers used to survive any edit made after them, so
# "pnpm build && typecheck && lint" → edit one file → `git commit` passed the commit
# gate with code that had never been checked. Reproduced in a sandbox: arming the
# three gates, then feeding an Edit, left quality-gates-passed armed and the commit
# gate returned 0. A write invalidates the certificate — the gates have to run again
# on the tree that is actually being committed.
writes_a_file() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(cp|mv|rm|mkdir|touch|patch|git[[:space:]]+apply)[[:space:]]' && return 0
  return 1
}
INVALIDATES=0
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) INVALIDATES=1 ;;
  Bash)
    # Editing through a shell is still editing. But a gate command that pipes its own
    # output to a file must not revoke the marker it just armed one screen above.
    if [ "$GATE_COMMAND" = "1" ] && writes_a_file "$COMMAND"; then
      INVALIDATES=1
    fi
    ;;
esac
if [ "$INVALIDATES" = "1" ]; then
  rm -f "$STATE_DIR/quality-gates-passed" "$STATE_DIR/gate-build" \
        "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint"
fi
exit 0
'@

        # session-end-check.sh
        Write-ShHook "session-end-check" @'
#!/bin/bash
# Cortex Session End Check (v7.1) — closes the cortex session when the session really ends.
#
# v6 posted to ${CORTEX_HUB_API_URL:-http://localhost:4000}. Nothing sets that variable, so on
# every machine but the hub itself the close went to a port nobody listens on; curl's failure
# was swallowed and `session-ended` was written anyway. Sessions were never closed, and the
# hook said they were. v7 goes where the agent's own cortex calls go — the hub's MCP endpoint,
# with the key from the IDE's MCP config — and only records a close the hub confirmed.
#
# The close is sent with auto:true: the hub records it as 'abandoned', keeps it out of memory
# and /cs recall, and leaves a session that /ce already completed alone.
#
# Claude Code gives a SessionEnd hook 1.5s unless it declares a timeout; settings.json gives
# this one 15s, and the requests below stop well inside that.
#
# v7.1: every conversation in a checkout shares this state directory, so `session-id` is
# whichever one ran /cs last — one conversation's exit closed another's session, and one that
# never ran /cs closed somebody else's. The tracker now files each session under the IDE's id
# for the conversation that opened it, and this hook closes that one and nothing else. With no
# such record (an older tracker, an IDE that sends no id) it falls back to `session-id`.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

say() { echo "$1"; }

INPUT=$(cat 2>/dev/null || true)
CLIENT_ID=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    CLIENT_ID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)
  fi
fi
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)

SESSION_ID=""
OWN=""
if [ -n "$CLIENT_ID" ] && [ -d "$STATE_DIR/conversations" ]; then
  # Nothing filed under this conversation: it never opened a session, or /ce closed it.
  OWN="$STATE_DIR/conversations/$CLIENT_ID"
  [ -s "$OWN" ] || exit 0
  SESSION_ID=$(head -1 "$OWN" 2>/dev/null || true)
else
  [ -f "$STATE_DIR/session-started" ] || exit 0
  [ -f "$STATE_DIR/session-ended" ] && exit 0
  [ -s "$STATE_DIR/session-id" ] && SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)
fi

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  say "WARNING: cortex session not closed — no session id was recorded. Run /ce next time."
  exit 0
fi

ACTIONS=""
[ -s "$STATE_DIR/knowledge-recalled" ]   && ACTIONS="${ACTIONS} knowledge-searched"
[ -s "$STATE_DIR/memory-recalled" ]      && ACTIONS="${ACTIONS} memory-searched"
[ -s "$STATE_DIR/discovery-used" ]       && ACTIONS="${ACTIONS} code-searched"
[ -s "$STATE_DIR/changes-checked" ]      && ACTIONS="${ACTIONS} changes-checked"
[ -s "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
[ -s "$STATE_DIR/quality-reported" ]     && ACTIONS="${ACTIONS} quality-reported"
[ -s "$STATE_DIR/tasks-checked" ]        && ACTIONS="${ACTIONS} tasks-checked"
[ -s "$STATE_DIR/gate-off" ]             && ACTIONS="${ACTIONS} gate-off($(head -c 80 "$STATE_DIR/gate-off" | tr -d '"\\\n'))"

SUMMARY="Session auto-closed (no /ce)."
[ -n "$ACTIONS" ] && SUMMARY="Session auto-closed. Activity:${ACTIONS}."

if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  say "WARNING: cortex session $SESSION_ID not closed — needs python3 and curl. Run /ce next time."
  exit 0
fi

# The hub's MCP endpoint and Authorization header, one per line, from the environment or the
# cortex-hub entry of whichever MCP config this machine has. Both shapes the installer writes
# are read: {url, headers} and the mcp-remote bridge {args: [url, --header, ...], env}.
hub_endpoint() {
  python3 - "$PROJECT_DIR" <<'PY' 2>/dev/null
import json, os, re, sys
project, home = sys.argv[1], os.path.expanduser('~')

def emit(url, auth):
    if url and auth:
        print(url)
        print(auth if auth.lower().startswith('bearer ') else 'Bearer ' + auth)
        sys.exit(0)

emit(os.environ.get('CORTEX_MCP_URL') or os.environ.get('HUB_MCP_URL'), os.environ.get('HUB_API_KEY'))

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

def servers(doc):
    out = {}
    for key in ('mcpServers', 'servers'):
        if isinstance(doc.get(key), dict):
            out.update(doc[key])
    return out

def entry(found):
    if 'cortex-hub' in found:
        return found['cortex-hub']
    return next((v for k, v in found.items() if 'cortex' in k.lower()), None)

def expand(value, env):
    return re.sub(r'\$\{(\w+)\}', lambda m: env.get(m.group(1)) or os.environ.get(m.group(1), ''), value)

def resolve(e):
    if not isinstance(e, dict):
        return
    env = e.get('env') if isinstance(e.get('env'), dict) else {}
    headers = e.get('headers') if isinstance(e.get('headers'), dict) else {}
    args = [a for a in e.get('args') or [] if isinstance(a, str)]
    url = e.get('url') or e.get('httpUrl') or e.get('serverUrl') or next((a for a in args if a.startswith('http')), None)
    auth = headers.get('Authorization') or headers.get('authorization')
    for i, a in enumerate(args[:-1]):
        if a == '--header' and args[i + 1].lower().startswith('authorization:'):
            auth = auth or args[i + 1].split(':', 1)[1]
    emit(url, expand(auth or '', env).strip())

claude = load(os.path.join(home, '.claude.json'))
for found in (
    servers(load(os.path.join(project, '.mcp.json'))),
    servers((claude.get('projects') or {}).get(project) or {}),
    servers(claude),
    servers(load(os.path.join(project, '.gemini', 'settings.json'))),
    servers(load(os.path.join(home, '.gemini', 'settings.json'))),
    servers(load(os.path.join(home, '.gemini', 'antigravity', 'mcp_config.json'))),
    servers(load(os.path.join(home, '.cursor', 'mcp.json'))),
    servers(load(os.path.join(home, '.codeium', 'windsurf', 'mcp_config.json'))),
    servers(load(os.path.join(project, '.vscode', 'mcp.json'))),
):
    resolve(entry(found))
PY
}

# A JSON body for the close. $1 = "mcp" for a tools/call, anything else for the REST route.
close_body() {
  python3 - "$1" "$SESSION_ID" "$SUMMARY" <<'PY'
import json, sys
kind, sid, summary = sys.argv[1:4]
args = {'sessionId': sid, 'summary': summary, 'auto': True}
if kind == 'mcp':
    print(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                      'params': {'name': 'cortex_session_end', 'arguments': args}}))
else:
    print(json.dumps({'summary': summary, 'auto': True}))
PY
}

# Did the tools/call succeed? The reply is JSON, or the same JSON as SSE `data:` lines.
mcp_ok() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
lines = [l[5:].strip() for l in raw.splitlines() if l.startswith("data:")] or [raw]
for line in lines:
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if isinstance(msg, dict) and isinstance(msg.get("result"), dict) and not msg["result"].get("isError"):
        sys.exit(0)
sys.exit(1)'
}

CLOSED=1
WHY=""
if [ -n "${CORTEX_HUB_API_URL:-}" ]; then
  # An explicit API URL (a self-hosted hub on this machine) keeps the direct route.
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 4 -m 10 \
    -X POST "${CORTEX_HUB_API_URL%/}/api/sessions/${SESSION_ID}/end" \
    -H 'Content-Type: application/json' -d "$(close_body rest)" 2>/dev/null)
  case "$CODE" in 2??) CLOSED=0 ;; *) WHY="${CORTEX_HUB_API_URL} answered ${CODE:-nothing}" ;; esac
else
  ENDPOINT=$(hub_endpoint)
  MCP_URL=$(printf '%s\n' "$ENDPOINT" | sed -n 1p)
  MCP_AUTH=$(printf '%s\n' "$ENDPOINT" | sed -n 2p)
  if [ -z "$MCP_URL" ] || [ -z "$MCP_AUTH" ]; then
    WHY="no cortex-hub MCP server with an Authorization header in this machine's MCP config"
  else
    # The key goes in on stdin, never on the command line, where `ps` would show it.
    if printf 'Authorization: %s\n' "$MCP_AUTH" \
        | curl -sf --connect-timeout 4 -m 10 -X POST "$MCP_URL" -H @- \
            -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
            -d "$(close_body mcp)" 2>/dev/null | mcp_ok; then
      CLOSED=0
    else
      WHY="the hub at ${MCP_URL%%\?*} did not confirm it"
    fi
  fi
fi

if [ "$CLOSED" = "0" ]; then
  [ -n "$OWN" ] && rm -f "$OWN"
  # session-ended speaks for the checkout's current session, so only that one may write it.
  if [ -z "$OWN" ] || [ "$SESSION_ID" = "$(cat "$STATE_DIR/session-id" 2>/dev/null)" ]; then
    printf 'tool=session-end-check at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_DIR/session-ended"
  fi
  say "INFO: cortex session $SESSION_ID closed as abandoned.${ACTIONS:+ Activity:${ACTIONS}}"
else
  say "WARNING: cortex session $SESSION_ID not closed — ${WHY}. Run /ce next time."
fi
exit 0
'@

        # nudge-lookup.sh
        Write-ShHook "nudge-lookup" @'
#!/bin/bash
# Cortex Lookup Nudge (v1) — a reminder, never a block, when a grep is a cortex question.
#
# The session gate only makes an agent call cortex once: after the first discovery call it
# greps freely, and measured over real sessions (mods/cortex-bar/scripts/lookup-audit.mjs)
# cortex answered 3–9% of the searches it could have answered, least of all in subagents.
# This hook reads what a search looks for. A repo-wide search for a symbol or a word gets
# one line of context naming the cortex call that answers it; the search itself still runs,
# since a refused call costs the agent a whole request to recover from.
#
# It stays quiet for literals (env vars, config keys, error strings), for searches in known
# files or outside the repo, and for file-name searches: grep and find are right for those.
# It also stays quiet right after a cortex lookup, when the grep is the agent checking what
# cortex did not answer, and nudges each agent at most once every NUDGE_EVERY searches.
#
# CORTEX_NUDGE=off turns it off; so does gate-off, since the hub it points at is down. It is
# JavaScript in a shell file so the installers can ship it like every other hook; without
# node it does nothing.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ "${CORTEX_NUDGE:-}" = "off" ] && exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# read, not $(cat << …): bash 3.2, macOS's own, misparses quotes in a heredoc inside $( ).
IFS= read -r -d '' NUDGE_JS << 'NUDGEJS' || true
const fs = require('fs')
const path = require('path')

/** Searches between two nudges to one agent. */
const NUDGE_EVERY = 5
/** A search this many calls after a cortex lookup is checking its answer: no nudge. */
const AFTER_LOOKUP = 3
const LOOKUP = /cortex_(code_search|code_context|code_impact|cypher)$/

const SEARCH_TOOLS = ['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack']
const FIND_TOOLS = ['find', 'fd', 'fdfind', 'locate']
const PREFIXES = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']
const WRAPPERS = ['command', 'builtin', 'exec', 'env', 'time', 'nice', 'noglob', 'sudo']
const TAKES_ARG = ['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-d', '-D', '-j', '-M',
  '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--max-depth',
  '--max-columns', '--threads', '--sort', '--sortr', '--include', '--exclude', '--exclude-dir',
  '--context', '--after-context', '--before-context']
const NON_CODE = /^-$|^\/tmp\/|^\/private\/|^\/var\/|scratchpad|\.claude\/projects|node_modules|\.(log|jsonl|csv|output)$/
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const FILE_NAME = /.\.[A-Za-z0-9]+$/

// The simple commands in a shell line, each with whether a pipe feeds it: quotes and
// backslashes read as the shell reads them, redirections and heredoc bodies dropped.
// The same reading as mods/cortex-bar/hooks/lookups.js, which the audit counts with.
function shellCommands(s) {
  const out = []
  let argv = []
  let piped = false
  let word = null
  let dropNext = false
  let delimiterNext = null
  let heredocs = []
  const flushWord = () => {
    if (word === null) return
    if (delimiterNext !== null) heredocs.push({ delimiter: word, tabs: delimiterNext })
    else if (!dropNext) argv.push(word)
    delimiterNext = null
    dropNext = false
    word = null
  }
  const endCommand = (separator) => {
    flushWord()
    if (argv.length > 0) out.push({ argv, piped })
    argv = []
    piped = separator === '|' || separator === '|&'
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    const next = s[i + 1] || ''
    if (c === "'") {
      const close = s.indexOf("'", i + 1)
      if (close === -1) return []
      word = (word || '') + s.slice(i + 1, close)
      i = close + 1
    } else if (c === '"') {
      let j = i + 1
      let text = ''
      while (j < s.length && s[j] !== '"') {
        const after = s[j + 1] || ''
        if (s[j] === '\\' && after !== '' && '"\\$`\n'.includes(after)) {
          if (after !== '\n') text += after
          j += 2
        } else {
          text += s[j]
          j += 1
        }
      }
      if (j >= s.length) return []
      word = (word || '') + text
      i = j + 1
    } else if (c === '\\') {
      if (next !== '\n' && next !== '') word = (word || '') + next
      i += 2
    } else if (c === ' ' || c === '\t') {
      flushWord()
      i += 1
    } else if (c === '#' && word === null) {
      while (i < s.length && s[i] !== '\n') i += 1
    } else if (c === '\n') {
      endCommand('\n')
      i += 1
      for (const { delimiter, tabs } of heredocs) {
        for (;;) {
          if (i >= s.length) return out
          const end = s.indexOf('\n', i)
          const line = s.slice(i, end === -1 ? s.length : end)
          i = end === -1 ? s.length : end + 1
          if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break
        }
      }
      heredocs = []
    } else if ((c === '<' || c === '>' || c === '$') && next === '(') {
      endCommand('(')
      i += 2
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      if (word !== null && /^\d+$/.test(word)) word = null
      flushWord()
      if (c === '&') i += 1
      const op = (/^(<<<|<<-|<<|>>|>\||<>|<&|>&|<|>)/.exec(s.slice(i)) || [c])[0]
      i += op.length
      if (op === '<<' || op === '<<-') {
        delimiterNext = op === '<<-'
      } else if (op === '<&' || op === '>&') {
        const fd = /^[0-9-]+/.exec(s.slice(i))
        if (fd) i += fd[0].length
        else dropNext = true
      } else {
        dropNext = true
      }
    } else if ('|&;()'.includes(c)) {
      const op = ['||', '|&', '&&', ';;'].find((two) => s.startsWith(two, i)) || c
      endCommand(op)
      i += op.length
    } else {
      word = (word || '') + c
      i += 1
    }
  }
  endCommand(';')
  return out
}

function withoutPrefix(argv) {
  let i = 0
  for (;;) {
    const arg = argv[i]
    if (arg === undefined) return []
    if (PREFIXES.includes(arg) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      i += 1
    } else if (WRAPPERS.includes(arg)) {
      i += 1
      while (argv[i] && argv[i].startsWith('-')) i += 1
    } else {
      return argv.slice(i)
    }
  }
}

function patternAndTargets(args) {
  const patterns = []
  const positional = []
  let options = true
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (options && arg === '--') {
      options = false
    } else if (options && TAKES_ARG.includes(arg)) {
      if (arg === '-e' || arg === '--regexp') patterns.push(args[i + 1] || '')
      i += 1
    } else if (options && arg.startsWith('--regexp=')) {
      patterns.push(arg.slice('--regexp='.length))
    } else if (!(options && arg.startsWith('-') && arg !== '-')) {
      positional.push(arg)
    }
  }
  if (patterns.length > 0) return { pattern: patterns.join('|'), targets: positional }
  return { pattern: positional[0] || '', targets: positional.slice(1) }
}

function outsideRepo(target, root) {
  if (NON_CODE.test(target) || target === '..' || target.startsWith('../')) return true
  if (!target.startsWith('/') || root === '') return false
  return target !== root && !target.startsWith(root + '/')
}

function isFile(target) {
  if (/[*?[{$]/.test(target)) return false
  return FILE_NAME.test(target.slice(target.lastIndexOf('/') + 1))
}

// A symbol: every alternative an identifier, one of them shaped like code. A literal: an
// UPPER_SNAKE name or text with a space, quote, `:`, `=` or `/`. Anything else is a word.
function alternativesOf(pattern) {
  const bare = pattern.replace(/\\[b<>]/g, '').replace(/[()]/g, '')
  return bare.split(/\\\||\|/).filter((part) => part !== '')
}
const shaped = (name) => /[a-z][A-Z]|[a-z]_[a-z]|^[A-Z][a-z]+[A-Z]/.test(name) || /^[A-Z].*[a-z]/.test(name)

function patternKind(pattern) {
  if (pattern === '') return 'literal'
  const alternatives = alternativesOf(pattern)
  if (alternatives.length > 0 && alternatives.every((part) => IDENTIFIER.test(part)) && alternatives.some(shaped)) {
    return 'symbol'
  }
  if (/[A-Z][A-Z0-9]*_[A-Z0-9_]+/.test(pattern) || /[\s"':=/]/.test(pattern)) return 'literal'
  return 'word'
}

function contentKind(pattern, targets, root) {
  if (targets.length > 0 && targets.every((target) => outsideRepo(target, root))) return 'non-code'
  if (targets.length > 0 && targets.every(isFile)) return 'in-file'
  return patternKind(pattern)
}

function commandSearch(argv, root) {
  const [program = '', ...rest] = argv
  let name = program.slice(program.lastIndexOf('/') + 1)
  let args = rest
  if (name === 'git') {
    let i = 0
    while (args[i] && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
    if (args[i] === 'ls-files') return { kind: 'find-file', pattern: '' }
    if (args[i] !== 'grep') return null
    name = 'grep'
    args = args.slice(i + 1)
  }
  if (FIND_TOOLS.includes(name)) return { kind: 'find-file', pattern: '' }
  if (!SEARCH_TOOLS.includes(name)) return null
  if (args.includes('--files')) return { kind: 'find-file', pattern: '' }
  const { pattern, targets } = patternAndTargets(args)
  return { kind: contentKind(pattern, targets, root), pattern }
}

function searchOf(tool, input, root) {
  if (tool === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const targets = typeof input.path === 'string' && input.path !== '' ? [input.path] : []
    return { kind: contentKind(pattern, targets, root), pattern }
  }
  if (tool !== 'Bash' || typeof input.command !== 'string') return null
  for (const { argv, piped } of shellCommands(input.command)) {
    if (piped) continue
    const search = commandSearch(withoutPrefix(argv), root)
    if (search !== null) return search
  }
  return null
}

function nudgeFor({ kind, pattern }) {
  const quoted = JSON.stringify(pattern.length > 80 ? pattern.slice(0, 80) : pattern)
  if (kind === 'symbol') {
    const name = alternativesOf(pattern).find(shaped) || pattern
    return `Cortex: this search is for the symbol ${name}. cortex_code_context(name: ${JSON.stringify(name)}) ` +
      'answers where it is defined, who calls it and what it calls in one call, without reading ' +
      'grep hits. Grep stays right for an exact literal. This search runs either way.'
  }
  return `Cortex: a search for ${quoted} across the repo is a question about the code. ` +
    `cortex_code_search(query: ${quoted}, limit: 10) ranks the files that answer it; read all ten ` +
    'before choosing. Grep stays right for an exact literal. This search runs either way.'
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { raw += chunk })
process.stdin.on('end', () => {
  let event
  try { event = JSON.parse(raw) } catch { return }
  const tool = String(event.tool_name || '')
  const agent = [event.session_id, event.agent_id || 'main'].filter(Boolean).join('-')
    .replace(/[^A-Za-z0-9_-]/g, '').slice(0, 160) || 'main'
  const dir = path.join(process.env.STATE_DIR, 'nudge')
  const file = path.join(dir, agent)
  let state = { sinceLookup: null, sinceNudge: null }
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch {}
  const save = () => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(state))
    } catch {}
  }

  if (LOOKUP.test(tool)) {
    state.sinceLookup = 0
    return save()
  }
  if (state.sinceLookup !== null) state.sinceLookup += 1
  let search = null
  try { search = searchOf(tool, event.tool_input || {}, process.env.PROJECT_DIR || '') } catch {}
  const addressable = search !== null && (search.kind === 'symbol' || search.kind === 'word')
  if (!addressable) return save()
  if (state.sinceNudge !== null) state.sinceNudge += 1
  const checking = state.sinceLookup !== null && state.sinceLookup <= AFTER_LOOKUP
  const recent = state.sinceNudge !== null && state.sinceNudge < NUDGE_EVERY
  if (checking || recent) return save()
  state.sinceNudge = 0
  save()
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: nudgeFor(search) },
  }))
})
NUDGEJS
STATE_DIR="$STATE_DIR" PROJECT_DIR="$PROJECT_DIR" node -e "$NUDGE_JS" 2>/dev/null
exit 0
'@

        # recall-notes.sh
        Write-ShHook "recall-notes" @'
#!/bin/bash
# Cortex File Notes (v1) — what past work learned about a file, shown before the agent opens it.
#
# Risks, lessons and fixes stored with cortex_knowledge_store(files: [...]), and the risks a
# conductor task reported when it completed, are linked to repo files on the hub. An agent
# about to read or edit one of those files gets them as context here, once per conversation
# and agent, instead of having to know that a search would have found them. Never a block.
#
# The hub is asked once for every linked path of the project (cortex_file_notes), kept in
# .cortex/.session-state/notes/index.json for NOTES_TTL, so a read costs no request at all.
# A hub that does not answer is asked again after FAILED_TTL; meanwhile the hook says nothing.
#
# CORTEX_NOTES=off turns it off; so does gate-off, since the hub is down. It is JavaScript in
# a shell file so the installers can ship it like every other hook; without node it does nothing.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ "${CORTEX_NOTES:-}" = "off" ] && exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# read, not $(cat << …): bash 3.2, macOS's own, misparses quotes in a heredoc inside $( ).
IFS= read -r -d '' NOTES_JS << 'NOTESJS' || true
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const NOTES_TTL = 10 * 60_000
const FAILED_TTL = 2 * 60_000
/** Another hook already asking the hub: its answer is waited for no longer than this. */
const LOCK_STALE = 15_000
const PER_FILE = 3

const project = process.env.PROJECT_DIR
const dir = path.join(process.env.STATE_DIR, 'notes')

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

// The hub this machine's agents talk to, found where session-end-check.sh finds it: the env,
// then the MCP configs of each IDE. The key never leaves this process.
function hubEndpoint() {
  const bearer = (auth) => (/^bearer /i.test(auth) ? auth : `Bearer ${auth}`)
  const envUrl = process.env.CORTEX_MCP_URL || process.env.HUB_MCP_URL
  if (envUrl && process.env.HUB_API_KEY) return { url: envUrl, auth: bearer(process.env.HUB_API_KEY) }
  const home = os.homedir()
  const servers = (doc) => ({ ...(doc.mcpServers || {}), ...(doc.servers || {}) })
  const claude = load(path.join(home, '.claude.json'))
  const configs = [
    servers(load(path.join(project, '.mcp.json'))),
    servers((claude.projects || {})[project] || {}),
    servers(claude),
    servers(load(path.join(project, '.gemini', 'settings.json'))),
    servers(load(path.join(home, '.gemini', 'settings.json'))),
    servers(load(path.join(home, '.gemini', 'antigravity', 'mcp_config.json'))),
    servers(load(path.join(home, '.cursor', 'mcp.json'))),
    servers(load(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'))),
    servers(load(path.join(project, '.vscode', 'mcp.json'))),
  ]
  for (const found of configs) {
    const e = found['cortex-hub'] || Object.entries(found).find(([k]) => k.toLowerCase().includes('cortex'))?.[1]
    if (!e || typeof e !== 'object') continue
    const env = e.env && typeof e.env === 'object' ? e.env : {}
    const args = (e.args || []).filter((a) => typeof a === 'string')
    const url = e.url || e.httpUrl || e.serverUrl || args.find((a) => a.startsWith('http'))
    let auth = (e.headers || {}).Authorization || (e.headers || {}).authorization
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--header' && /^authorization:/i.test(args[i + 1])) auth = auth || args[i + 1].split(':').slice(1).join(':')
    }
    auth = String(auth || '').replace(/\$\{(\w+)\}/g, (_, v) => env[v] || process.env[v] || '').trim()
    if (url && auth) return { url, auth: bearer(auth) }
  }
  return null
}

function remoteUrl() {
  try {
    return execFileSync('git', ['-C', project, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 2000 }).trim() || undefined
  } catch { return undefined }
}

/** An MCP answer, plain JSON or one server-sent event. */
function rpcResult(text) {
  const data = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('')
  const msg = JSON.parse(data)
  if (msg.error || msg.result?.isError) throw new Error('hub refused')
  return JSON.parse(msg.result.content[0].text)
}

async function askHub() {
  const hub = hubEndpoint()
  if (!hub) return null
  const res = await fetch(hub.url, {
    method: 'POST',
    headers: { Authorization: hub.auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'cortex_file_notes', arguments: { repo: remoteUrl() } },
    }),
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = rpcResult(await res.text())
  return body.notes && typeof body.notes === 'object' ? body.notes : {}
}

/** Every linked path of the project and its notes: the cached index, else the hub's. */
async function index() {
  const file = path.join(dir, 'index.json')
  const cached = load(file)
  const age = Date.now() - (cached.at || 0)
  if (age < (cached.ok ? NOTES_TTL : FAILED_TTL)) return cached.notes || {}
  const lock = path.join(dir, 'lock')
  try {
    fs.mkdirSync(lock)
  } catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_STALE) return cached.notes || {} } catch {}
    fs.rmSync(lock, { recursive: true, force: true })
    try { fs.mkdirSync(lock) } catch { return cached.notes || {} }
  }
  try {
    const notes = await askHub().catch(() => null)
    // A hub that did not answer keeps what was known: stale notes beat none.
    const next = notes === null ? { at: Date.now(), ok: false, notes: cached.notes || {} } : { at: Date.now(), ok: true, notes }
    fs.writeFileSync(file, JSON.stringify(next))
    return next.notes
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

/** The file as the hub links it, relative to the repo; null outside it. Symlinked checkouts (/tmp) match either way. */
function repoPath(target) {
  const inside = (root, file) => {
    const rel = path.relative(root, file).split(path.sep).join('/')
    return rel === '' || rel.startsWith('../') || path.isAbsolute(rel) ? null : rel
  }
  const file = path.resolve(project, target)
  let real = file
  try { real = path.join(fs.realpathSync(path.dirname(file)), path.basename(file)) } catch {}
  let root = project
  try { root = fs.realpathSync(project) } catch {}
  return inside(project, file) ?? inside(root, real)
}

async function main() {
  let event = {}
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return }
  const input = event.tool_input || {}
  const target = input.file_path || input.notebook_path
  if (typeof target !== 'string' || target === '') return
  const rel = repoPath(target)
  if (rel === null) return

  fs.mkdirSync(dir, { recursive: true })
  const agent = [event.session_id, event.agent_id || 'main'].filter(Boolean).join('-').replace(/[^\w.-]/g, '_')
  const shownFile = path.join(dir, `shown-${agent}`)
  let shown = []
  try { shown = fs.readFileSync(shownFile, 'utf8').split('\n') } catch {}
  if (shown.includes(rel)) return

  const notes = await index()
  const found = []
  for (const [linked, list] of Object.entries(notes)) {
    if (linked !== rel && !(linked.endsWith('/') && rel.startsWith(linked))) continue
    for (const n of Array.isArray(list) ? list : []) if (!found.some((f) => f.id === n.id)) found.push(n)
  }
  fs.appendFileSync(shownFile, `${rel}\n`)
  if (found.length === 0) return
  found.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const lines = found.slice(0, PER_FILE).map((n) => `- [${n.kind}] ${n.title}${n.note && n.note !== n.title ? ` — ${n.note}` : ''}`)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `📌 Cortex notes on ${rel}, from earlier work on it:\n${lines.join('\n')}`,
    },
  }))
}

main().catch(() => {})
NOTESJS
STATE_DIR="$STATE_DIR" PROJECT_DIR="$PROJECT_DIR" node -e "$NOTES_JS" 2>/dev/null
exit 0
'@

        # subagent-start.sh
        Write-ShHook "subagent-start" @'
#!/bin/bash
# Cortex Subagent Start (v1.0) — tells a subagent what the session it joins expects.
#
# A subagent begins with the prompt its parent wrote and none of the recall /cs did. The
# recall gate holds its edits until it recalls for itself, and this is where it learns that
# before running into the gate.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

cat >/dev/null 2>&1 || true

# No cortex session in this checkout, or the gates declared off: nothing to follow.
[ -f "$STATE_DIR/session-started" ] || exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0

CONTEXT="Cortex: you are a subagent in a Cortex session, and the parent's recall is not in your context. \
Before editing any file, run cortex_knowledge_search and cortex_memory_search on your own task: \
edits stay blocked until you do. \
Find code with cortex_code_context for a known symbol or cortex_code_search for a behaviour (read all ten hits); \
grep is for exact literals. \
When something fails, search knowledge for the error before fixing it."

printf '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"%s"}}\n' "$CONTEXT"
exit 0
'@

        # session-id.sh
        Write-ShHook "session-id" @'
#!/bin/bash
# Cortex Session Id (v1.1) — fills in clientSessionId and the agent identity on cortex_session_start.
#
# The hub keeps two conversations in one checkout on separate sessions by this id. Until
# session-init v7.4 the agent copied it from a line that hook printed, but that line differs
# in every conversation and sits ahead of CLAUDE.md and the rest of the opening context, so
# the prompt cache could never reuse anything after it: ~6k tokens written anew per
# conversation, most of what made a hub lookup cost more than a plain grep. The hook payload
# already carries the id, so it goes straight into the call and the context stays the same.
#
# v1.1: the identity too. CLAUDE.md told the agent to read .cortex/agent-identity.json and the
# git branch before its first call, two more turns in every conversation for values a script
# can look up. What the agent passes itself still wins; only the id is always this hook's.
INPUT=$(cat 2>/dev/null || true)
[ -z "$INPUT" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
IDENTITY_FILE="$PROJECT_DIR/.cortex/agent-identity.json"
BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true)
case "${CLAUDE_CODE_ENTRYPOINT:-}" in
  *vscode*) IDE=claude-code-vscode ;;
  *) IDE=claude-code-cli ;;
esac

# The same id, with the same characters kept, that the tracker and the exit hook file this
# conversation's session under. Whatever the agent passed is replaced: this one is current.
if command -v jq >/dev/null 2>&1; then
  IDENTITY=$(jq -c 'if type == "object" then . else {} end' "$IDENTITY_FILE" 2>/dev/null || true)
  [ -z "$IDENTITY" ] && IDENTITY='{}'
  printf '%s' "$INPUT" | jq -c --argjson who "$IDENTITY" --arg branch "$BRANCH" --arg ide "$IDE" '
    (.session_id // "" | gsub("[^A-Za-z0-9_-]"; "") | .[0:128]) as $id
    | select($id != "")
    | ($who.environment | if type == "object" then . else {} end) as $env
    # A value of the wrong type fails the schema of the tool, and with it the whole call, so a
    # hand-edited file only contributes what it got right.
    | (({hostname: $env.hostname, os: $env.os, role: $who.role, branch: $branch, ide: $ide}
        | with_entries(select(.value | type == "string" and . != "")))
       + ($who.capabilities | if type == "array" and length > 0 and all(type == "string")
           then {capabilities: .} else {} end)) as $found
    | {hookSpecificOutput: {hookEventName: "PreToolUse",
        updatedInput: ($found + (.tool_input // {}) + {clientSessionId: $id})}}' 2>/dev/null
elif command -v python3 >/dev/null 2>&1; then
  printf '%s' "$INPUT" | IDENTITY_FILE="$IDENTITY_FILE" BRANCH="$BRANCH" IDE="$IDE" python3 -c '
import json, os, re, sys
d = json.load(sys.stdin)
cid = re.sub(r"[^A-Za-z0-9_-]", "", str(d.get("session_id") or ""))[:128]
if cid:
    try:
        who = json.load(open(os.environ["IDENTITY_FILE"], encoding="utf-8-sig"))
        who = who if isinstance(who, dict) else {}
    except Exception:
        who = {}
    env = who.get("environment") if isinstance(who.get("environment"), dict) else {}
    found = {"hostname": env.get("hostname"), "os": env.get("os"), "role": who.get("role"),
             "branch": os.environ.get("BRANCH"), "ide": os.environ.get("IDE")}
    args = {k: v for k, v in found.items() if isinstance(v, str) and v}
    caps = who.get("capabilities")
    if isinstance(caps, list) and caps and all(isinstance(c, str) for c in caps):
        args["capabilities"] = caps
    args.update(d.get("tool_input") or {})
    args["clientSessionId"] = cid
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": args}}))
' 2>/dev/null
fi
exit 0
'@

        # settings.json — bash .sh hooks (Claude Code uses bash on all platforms)
        $settingsContent = @'
{
  "hooks": {
    "SessionStart": [
      {"matcher": "", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/session-init.sh\""}]}
    ],
    "SubagentStart": [
      {"matcher": "", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/subagent-start.sh\""}]}
    ],
    "PreToolUse": [
      {"matcher": "Edit|Write|NotebookEdit|Bash|Grep|Glob", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/enforce-session.sh\""}]},
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/enforce-commit.sh\""}]},
      {"matcher": "Bash|Grep|Glob|mcp__.*cortex_(code_search|code_context|code_impact|cypher)", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/nudge-lookup.sh\""}]},
      {"matcher": "mcp__.*cortex_session_start", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/session-id.sh\""}]},
      {"matcher": "Read|Edit|Write|MultiEdit|NotebookEdit", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/recall-notes.sh\""}]}
    ],
    "PostToolUse": [
      {"matcher": "", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/track-quality.sh\""}]}
    ],
    "SessionEnd": [
      {"matcher": "", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/session-end-check.sh\"", "timeout": 15}]}
    ]
  }
}
'@
        [System.IO.File]::WriteAllText((Join-Path $ProjectDir ".claude/settings.json"), $settingsContent)

        Write-Ok ("Claude: bash hooks + settings.json installed (v" + $LATEST_VERSION + ")")

        # ── Clean user-level hooks (prevent duplicate/stale hooks) ──
        $userSettings = Join-Path $env:USERPROFILE ".claude\settings.json"
        if (Test-Path $userSettings) {
            try {
                $userJson = Get-Content $userSettings -Raw | ConvertFrom-Json
                if ($userJson.hooks) {
                    $userJson.PSObject.Properties.Remove('hooks')
                    $userJson | ConvertTo-Json -Depth 10 | Set-Content $userSettings -Encoding UTF8
                    Write-Ok "Removed stale hooks from user-level settings (~/.claude/settings.json)"
                }
            } catch {
                Write-Warn "Could not clean user-level settings: $_"
            }
        }

        # ── Slash commands (/cs, /ce) ──
        $cmdDir = Join-Path $ProjectDir ".claude\commands"
        if (-not (Test-Path $cmdDir)) { New-Item -ItemType Directory -Path $cmdDir -Force | Out-Null }

        @'
# /cs — Cortex Start v0.9.4

> Version: 0.9.4 | Updated: 2026-10-22
> Changelog: v0.9.4 — recall with the task's own words; the generic session query is already in session_start's answer
> Changelog: v0.9.3 — the hook fills in the IDE, branch and identity too; no step for a field the hub never returned
> Changelog: v0.9.2 — clientSessionId is filled in by a hook, so the opening context is the same every time and stays cached
> Changelog: v0.9.1 — passes clientSessionId, so parallel conversations in one checkout get a session each
> Changelog: v0.9.0 — cortex_plan_quality is actually registered; it scores 0-10 and takes the request too
> Changelog: v0.8.0 — search-once/read-all-ten ordering from measured retrieval; recall no longer counts as discovery
> Changelog: v0.7.0 — unified versioning, removed STATE.md, streamlined tool guidance, auto-memory safety net
> Changelog: v2.1 — added plan quality gate before implementation
> Changelog: v2.0 — added task pickup, detect changes, recipe health, workflow recipes, versioning

Run ALL steps IN ORDER. Do NOT proceed to user work until Step 7 completes.

## Step 1: Session Start
Call `cortex_session_start`:
```
repo: "__GIT_REPO__"
mode: "development"
agentId: "claude-code"
```
Nothing else: the `session-id.sh` hook adds this conversation's id (so two conversations in one
checkout get a session each), the git branch, the IDE and `.cortex/agent-identity.json`.
Save `session_id`, `projectId` and `project.orgId` from the response. `orgId` is the boundary of a cross-repo search.

## Step 2: Recall Context (parallel)
`session_start` already answered "what happened last session" (`mission_brief`, `relevant_knowledge`).
Do not repeat that with a generic phrase: it returns the same documents every time.
Once you know the task, call BOTH in parallel with the task's own words (the feature, the error, the file):
- `cortex_knowledge_search(query: "<the task in a few words>")`
- `cortex_memory_search(query: "<the task in a few words>", agentId: "claude-code")`

If the user has not given a task yet, skip this step and run it when they do. It is required before
the first edit either way.

## Step 3: Conflict Check
`cortex_changes(agentId: "claude-code", projectId: "<from step 1>")`

## Step 4: Task Pickup (Optional)
If `cortex_task_pickup` tool is available:
`cortex_task_pickup()` — check for Conductor tasks assigned to you.
If tasks exist → list them. Ask user which to work on, or continue with their request.
If the tool is not available (e.g. in solo dev mode), skip this step.

## Step 5: Working State Check
Run `git status`. If uncommitted changes:
- `cortex_detect_changes(diff: "<output of git diff HEAD>")` — analyze risk level. The hub cannot see your working tree, so pass the diff
- Report affected symbols and blast radius

## Step 6: Situational Summary
Print a concise report:

```
## Session Init Complete
- **Last session**: <what was done, from memory/knowledge recall>
- **Pending tasks**: <N tasks> or none
- **Unseen changes**: <from other agents> or clean
- **Working state**: clean / <N uncommitted files, risk level>
- **Key context**: <relevant decisions or lessons>
- Ready to start work.
```

## Step 7: Activate Workflow Intelligence
For the REST of this session, use cortex tools naturally:

### Before implementing a plan:
1. Draft plan with steps + files to change
2. `cortex_plan_quality(plan: "<your plan>", request: "<what the user asked>")` → scorecard, 0-10
3. 8.0 or more → execute. Below that → address the listed improvements and resubmit with `iteration: 2` (max 3), then escalate to the user.

### Finding the code to change:
**Start from what you know, not from a fixed ladder:**

| You already know | Start with |
|---|---|
| A symbol name | `cortex_code_context(name)` — exact graph lookup, plus callers/callees/imports in one call |
| Only the behaviour | `cortex_code_search(query, limit: 10)` — ranked hybrid search, one call |
| An exact literal (env var, config key, error string) | `rg` / `grep` — this is not a ranking problem |
| A relationship across files | `cortex_cypher` |

**Search once, read all ten.** Measured on cortex-hub's own index (`benchmarks/retrieval_bench.ts`,
n=15): the target file is in the top 10 for 15/15 queries but at rank 1 for only 8/15. So scan
the whole result set, and never re-run a reworded version of the same query — recall@10 is
already 1.000, so it returns the same set. Ask a different question or switch tool instead.

**Knowledge and memory are for errors and decisions, not for locating code.** Recall them once
at session start, then when something breaks — not before every lookup.

`cortex_code_impact` before editing something exported or shared; `cortex_changes` before
touching a file another agent may hold.

### Cross-project lookup:
Projects are isolated per organization; related repos (client, server, tools) share one.
```
cortex_code_search(query: "...")                      # every repo in this organization
cortex_code_search(query: "...", repo: "my-backend")  # one repo
cortex_code_context(name: "...", repo: "my-backend")
cortex_list_repos()                                   # the repos "every repo" covers
```
Running sessions in two organizations with one API key at once? Pass `org: "<orgId>"`.

### When hitting an error:
1. `cortex_knowledge_search` → check if known
2. `cortex_memory_search` → check if seen before
3. Fix the error
4. If non-obvious → `cortex_knowledge_store` to save for others

### Before committing:
1. `cortex_detect_changes(diff: "<output of git diff --staged>")` — verify blast radius. `risk_level: "unknown"` means a lookup failed: it is not a pass
2. Commit
3. After push → `cortex_code_reindex(repo: "...", branch: "<branch>")`

### Working on a Conductor task:
1. `cortex_task_accept(taskId)` at start
2. `cortex_task_update(taskId, status: "in_progress")` during work
3. `cortex_task_update(taskId, status: "completed", result: {...})` when done

---
All cortex gates satisfied. Proceed with user tasks.
'@ | Out-File -FilePath (Join-Path $cmdDir "cs.md") -Encoding utf8
        $cmdPath = Join-Path $cmdDir "cs.md"
        (Get-Content $cmdPath -Raw).Replace("__GIT_REPO__", $GitRepo) | Set-Content $cmdPath -Encoding utf8

        @'
# /ce — Cortex End v0.9.0

> Version: 0.9.0 | Updated: 2026-09-28
> Changelog: v0.9.0 — version synced with the v0.9.0 release
> Changelog: v0.8.0 — search-once/read-all-ten ordering from measured retrieval; recall no longer counts as discovery
> Changelog: v0.7.0 — unified versioning, session_end auto-saves memory, removed STATE.md, streamlined steps
> Changelog: v2.0 — added detect_changes, tool stats, task completion, recipe capture check

Run ALL steps IN ORDER before ending the session.

## Step 1: Pre-commit Check
If uncommitted changes exist:
- `cortex_detect_changes(diff: "<output of git diff HEAD>")` — verify blast radius
- If HIGH risk → warn user before proceeding

## Step 2: Quality Gates
```bash
pnpm build && pnpm typecheck && pnpm lint
```
Record pass/fail for each.

## Step 3: Quality Report
```
cortex_quality_report(
  gate_name: "Session Quality",
  passed: <true if all gates pass>,
  score: <0-100>,
  details: "<build/typecheck/lint results>"
)
```

## Step 4: Complete Conductor Tasks (Optional)
If `cortex_task_list` and `cortex_task_update` tools are available:
`cortex_task_list(status: "in_progress")` — find tasks worked on this session.
For each: `cortex_task_update(taskId, status: "completed", result: { summary: "..." })`
If the tools are not available, skip this step.

## Step 5: Store Knowledge (if applicable)
If this session involved any of these, call `cortex_knowledge_store`:
- Bug fix with non-obvious root cause
- Architecture decision or tradeoff
- Workflow pattern that worked well
- Error + solution that others might encounter

## Step 6: Store Memory
`cortex_memory_store` with:
- What was done this session
- Key decisions made
- Context for resuming next session
- Any user preferences discovered

## Step 7: End Session
```
cortex_session_end(
  sessionId: "<from session_start>",
  summary: "<concise: what was done, what's next>"
)
```
> The backend automatically saves this summary as searchable memory — a safety net even if Step 6 was skipped.

## Step 8: Final Report
```
## Session Complete
- **Work done**: <brief summary>
- **Quality gates**: build pass/fail | typecheck pass/fail | lint pass/fail
- **Knowledge stored**: <N docs> or none
- **Tasks completed**: <list> or none
- **Next steps**: <what should be done next session>
```
'@ | Out-File -FilePath (Join-Path $cmdDir "ce.md") -Encoding utf8
        $cmdPath = Join-Path $cmdDir "ce.md"
        (Get-Content $cmdPath -Raw).Replace("__GIT_REPO__", $GitRepo) | Set-Content $cmdPath -Encoding utf8

        Write-Ok "Commands: /cs and /ce slash commands installed"
    }

    # ── Gemini / Antigravity hooks ──
    if (Test-IDESelected "gemini") {
        $geminiHooksDir = ".gemini\hooks"
        if (-not (Test-Path $geminiHooksDir)) { New-Item -ItemType Directory -Path $geminiHooksDir -Force | Out-Null }

        @'
#!/bin/bash
# Cortex Session Init (v7.2) — Gemini variant.
#
# v3 wiped the gate markers on every SessionStart. Where the host distinguishes a resumed or
# compacted session from a fresh one, re-arming the discovery gate mid-task is a bug: the agent
# already did the recall, and it cannot prove it any more. v3 also never cleared changes-checked
# or tasks-checked, so those markers survived for months and the checks silently stopped running.
#
# And it cleared session-started on every start, which is right — but the claude variant used to
# create it here instead, making its whole session gate vacuous. Only the tracker writes it, from
# a real cortex_session_start call.
# v7.2 names this conversation's id for cortex_session_start's clientSessionId, so two
# conversations in one checkout get a hub session each instead of sharing one.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat 2>/dev/null || true)
SOURCE=""
CLIENT_ID=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null || true)
    CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("source",""))' 2>/dev/null || true)
    CLIENT_ID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)
  fi
fi
SOURCE=$(printf '%s' "$SOURCE" | tr -cd 'A-Za-z0-9_-')
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
CONVERSATION=""
[ -n "$CLIENT_ID" ] && CONVERSATION=" This conversation's clientSessionId is ${CLIENT_ID} — pass it to cortex_session_start."

case "$SOURCE" in
  compact|resume)
    echo '{"systemMessage":"Cortex: same session ('"$SOURCE"') — discovery state kept.'"$CONVERSATION"'"}'
    exit 0 ;;
esac

rm -f "$STATE_DIR/session-started" "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/quality-reported" "$STATE_DIR/session-ended" \
      "$STATE_DIR/discovery-used" "$STATE_DIR/knowledge-recalled" \
      "$STATE_DIR/memory-recalled" "$STATE_DIR/changes-checked" \
      "$STATE_DIR/tasks-checked" "$STATE_DIR/gate-off" "$STATE_DIR/session-id" 2>/dev/null
# Other conversations' sessions stay theirs to close; only week-old records are dropped.
[ -d "$STATE_DIR/conversations" ] && find "$STATE_DIR/conversations" -type f -mtime +7 -exec rm -f {} + 2>/dev/null
echo '{"systemMessage":"MANDATORY: call cortex_session_start, then cortex_knowledge_search + cortex_memory_search, before any edit. search_file_content and glob stay blocked until a cortex discovery tool has run.'"$CONVERSATION"'"}'
exit 0
'@ | Out-File -FilePath "$geminiHooksDir\session-init.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
# Cortex Session Enforcement (v6.2) — Gemini variant.
#
# v3 only checked that a session existed: once cortex_session_start had run, every tool was
# allowed. So the discovery-first rule was documentation, not enforcement. This mirrors the
# Claude hook — gate grep/glob until a cortex discovery tool has run, and gate writes until
# knowledge and memory have been recalled — in Gemini's JSON decision protocol.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

allow() { echo '{"decision":"allow"}'; exit 0; }
deny()  { printf '{"decision":"deny","reason":%s}\n' "$(printf '%s' "$1" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"BLOCKED: cortex workflow step missing."')"; exit 0; }

INPUT=$(cat)
TOOL_NAME=""
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  # v3 read the command with jq only, so on a machine without jq the commit and write gates
  # quietly passed everything.
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
" 2>/dev/null || true)"
fi
[ -z "$TOOL_NAME" ] && allow

# Declared escape hatch: when the hub is unreachable the tools this gate points at cannot run.
[ -s "$STATE_DIR/gate-off" ] && allow

marker_ok() { [ -s "$STATE_DIR/$1" ] && grep -q '^tool=' "$STATE_DIR/$1" 2>/dev/null; }

is_codebase_search() {
  local cmd="${1%%<<*}"   # heredoc bodies are data being written, not commands being run
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*|\([[:space:]]*)[[:space:]]*(sudo[[:space:]]+)?(grep|egrep|fgrep|rg|ag|ack|find|fd)[[:space:]]' && return 0
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*)[[:space:]]*git[[:space:]]+grep[[:space:]]' && return 0
  return 1
}
is_gate_off_write() {
  printf '%s' "$1" | grep -Eq '>[[:space:]]*"?[^"[:space:]]*\.cortex/\.session-state/gate-off"?[[:space:]]*$'
}
is_file_write() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  return 1
}

HOW_OUT="If the Cortex hub is unreachable, say so and write the reason: echo 'hub unreachable' > .cortex/.session-state/gate-off"

if [ -f "$STATE_DIR/session-started" ]; then
  if ! marker_ok discovery-used; then
    case "$TOOL_NAME" in
      search_file_content|glob)
        deny "BLOCKED: use cortex_code_search first — it is AST-aware and returns the target file inside the top 10 far more reliably than a pattern guess. $HOW_OUT" ;;
      run_shell_command|shell)
        is_codebase_search "$COMMAND" && deny "BLOCKED: use cortex_code_search first. find/grep/rg unlock once a cortex discovery tool has run — and stay the right choice for an exact literal (env var, config key, error string), not for a question about behaviour. $HOW_OUT" ;;
    esac
  fi

  # Recall is a precondition for writing, not a consolation prize for not having
  # searched — see the same fix in .claude/hooks/enforce-session.sh.
  WRITES_A_FILE=0
  case "$TOOL_NAME" in
    write_file|replace|edit_file|create_file|insert_text) WRITES_A_FILE=1 ;;
    run_shell_command|shell) is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" && WRITES_A_FILE=1 ;;
  esac
  if [ "$WRITES_A_FILE" = "1" ]; then
    if ! marker_ok knowledge-recalled || ! marker_ok memory-recalled; then
      deny "BLOCKED: run cortex_knowledge_search and cortex_memory_search before editing, with the words of the task in hand (the feature, the error) — they restore what previous sessions already decided and already fixed. $HOW_OUT"
    fi
  fi
  allow
fi

# Session not started: block writes and codebase search, allow plain reads. Searching is
# reading, so a cortex lookup unlocks it here as it does in a session — see the Claude hook.
SEARCH_HINT="BLOCKED: look it up with cortex_code_search (a behaviour) or cortex_code_context (a symbol name) first. One call unlocks find/grep/rg, glob and search_file_content for the rest of the session. $HOW_OUT"
case "$TOOL_NAME" in
  write_file|replace|edit_file|create_file|insert_text)
    deny "BLOCKED: call cortex_session_start first. No edits without a session." ;;
  glob|search_file_content)
    marker_ok discovery-used || deny "$SEARCH_HINT" ;;
  run_shell_command|shell)
    is_codebase_search "$COMMAND" && ! marker_ok discovery-used && deny "$SEARCH_HINT"
    is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" \
      && deny "BLOCKED: call cortex_session_start first. No file modifications without a session."
    printf '%s' "$COMMAND" | grep -Eq '(git[[:space:]]+(add|commit|push|reset)|^rm[[:space:]]|^mv[[:space:]]|^cp[[:space:]]|^mkdir[[:space:]])' \
      && deny "BLOCKED: call cortex_session_start first. No file modifications without a session." ;;
esac
allow
'@ | Out-File -FilePath "$geminiHooksDir\enforce-session.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
# Cortex Commit Enforcement (v5.1) — Gemini variant.
#
# v3 accepted quality-gates-passed, which the tracker wrote the moment cortex_quality_report was
# called — so reporting a failure unlocked the commit just as well as passing. The marker now
# comes only from build/typecheck/lint actually running green.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
# v5.1 refuses to skip the repo's own git hooks (--no-verify, `commit -n`, LEFTHOOK=0): cortex
# writes this file, so the rule has to live here rather than be added by the repo.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi

# Prints why a command skips the repo's git hooks; prints nothing when it does not.
skips_hooks() {
  local cmd q="'"
  local b='(^|[;&|(`[:space:]])' seg='[^;&|)]' end='([;&|)[:space:]]|$)'
  # A heredoc body is text (a commit message), not flags: drop it and keep the line that
  # opens it. Then join `\` continuations and make every line a `;`-separated command.
  cmd=$(printf '%s\n' "$1" | awk '
    tag != "" { t = $0; sub(/^\t+/, "", t); if (t == tag) tag = ""; next }
    { print
      if (match($0, /(^|[^<])<<-?[ \t]*["\047]?[A-Za-z_][A-Za-z0-9_]*/)) {
        tag = substr($0, RSTART, RLENGTH); sub(/^[^<]?<<-?[ \t]*["\047]?/, "", tag)
      } }' | awk '/\\$/ { sub(/\\$/, ""); printf "%s ", $0; next } { print }' | tr '\n' ';')
  # Quoted arguments are messages and bodies; a flag named inside one is not a flag.
  # `LEFTHOOK="0"` keeps its quotes: they follow `=`, not a space.
  cmd=$(printf '%s' "$cmd" | sed -E "s/(^|[[:space:]])'[^']*'/\1/g; s/(^|[[:space:]])\"[^\"]*\"/\1/g; s/(--[a-z-]+=)'[^']*'/\1/g; s/(--[a-z-]+=)\"[^\"]*\"/\1/g")
  local re="${b}(export[[:space:]]+)?LEFTHOOK=[\"$q]?(0|false)([\"$q;&|)[:space:]]|\$)"
  if [[ "$cmd" =~ $re ]]; then echo "LEFTHOOK=0 turns lefthook off"; return; fi
  # git takes any unambiguous prefix of a long option, so --no-veri is --no-verify.
  re="${b}git[[:space:]]${seg}*[[:space:]]--no-veri[a-z]*(=|${end})"
  if [[ "$cmd" =~ $re ]]; then echo "--no-verify skips the hooks"; return; fi
  # `git commit -n` is --no-verify. Only flags that take no value may come before the n:
  # `-mnew` is `-m new`. `git push -n` is --dry-run and stays allowed.
  local opt='[[:space:]]+-[^[:space:];&|)]*([[:space:]]+[^-[:space:];&|)][^[:space:];&|)]*)?'
  re="${b}git(${opt})*[[:space:]]+commit([[:space:]]${seg}*)?[[:space:]]-[apseioqvz]*n[a-zA-Z]*${end}"
  if [[ "$cmd" =~ $re ]]; then echo "git commit -n is --no-verify"; return; fi
}
# Checked before the `^git commit` match below, so `cd x && git push --no-verify` is caught too.
SKIP_REASON=$(skips_hooks "$COMMAND")
if [ -n "$SKIP_REASON" ]; then
  printf '{"decision":"deny","reason":"BLOCKED: this skips the git hooks of the repo (%s). Those hooks are its own checks: run the command without the skip and fix what they report; if a hook itself is broken, ask the user to run the command."}\n' "$SKIP_REASON"
  exit 0
fi

[[ ! "$COMMAND" =~ ^git\ commit ]] && { echo '{"decision":"allow"}'; exit 0; }

MISSING=""
[ ! -f "$STATE_DIR/session-started" ]      && MISSING="${MISSING} cortex_session_start;"
[ ! -s "$STATE_DIR/discovery-used" ]       && MISSING="${MISSING} discovery (cortex_code_search / code_context / knowledge_search);"
[ ! -s "$STATE_DIR/quality-gates-passed" ] && MISSING="${MISSING} quality gates green (build, typecheck, lint — calling cortex_quality_report does not count);"
if [ -n "$MISSING" ]; then
  printf '{"decision":"deny","reason":"BLOCKED: cannot commit — missing Cortex workflow steps:%s"}\n' "$MISSING"
  exit 0
fi
echo '{"decision":"allow"}'
'@ | Out-File -FilePath "$geminiHooksDir\enforce-commit.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
# Cortex Quality Tracker (v4.2) — Gemini variant.
#
# Two bugs from v3: cortex_quality_report touched quality-gates-passed, so reporting a failure
# counted as passing; and every marker was an empty `touch`, which the enforcement hook could not
# tell apart from a forged one. Markers now carry the tool and time that produced them, a gate is
# only marked when the command output does not look like a failure, and the cortex session id is
# captured so the session can actually be closed.
# v4.2 files that session under the conversation that opened it (conversations/<session_id>),
# so the exit hook closes this conversation's session and not another's in the same checkout.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
INPUT=$(cat)

TOOL_NAME=""; COMMAND=""; OUTPUT=""; CLIENT_ID=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
  CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(d.get(\"tool_response\", d.get(\"tool_output\",\"\")), ensure_ascii=False))}')
print(f'CLIENT_ID={repr(str(d.get(\"session_id\",\"\")))}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
record() { printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"; }
# ESLint prints "✖ N problems (0 errors, N warnings)" for warnings alone, so a bare ✖
# is not a failure; only an error count above zero is.
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖ [0-9]+ problems? \([1-9]|FAIL |Exit status [1-9]'
}
# 1 = this command is not one of the quality gates. mark_gate flips it, and the
# invalidation block at the bottom reads it, so `pnpm build | tee build.log` does not
# revoke the very marker it just armed.
GATE_COMMAND=1
mark_gate() { GATE_COMMAND=0; looks_failed && return 0; record "$1" "$COMMAND"; }

[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*build ]]     && mark_gate gate-build
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*typecheck ]] && mark_gate gate-typecheck
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*lint ]]      && mark_gate gate-lint
if [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-typecheck" ] && [ -s "$STATE_DIR/gate-lint" ]; then
  record quality-gates-passed "build+typecheck+lint"
fi

case "$TOOL_NAME" in
  *cortex_session_start*)
    record session-started
    # Only a hub id: every hook payload opens with the IDE's own "session_id" (a conversation
    # uuid), and `head -1` used to take that one, so the exit hook tried to close a session
    # the hub had never heard of. The hub mints nothing but sess_… ids.
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"sess_[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    if [ -n "$SESSION_ID" ] && [ -n "$CLIENT_ID" ]; then
      mkdir -p "$STATE_DIR/conversations"
      printf '%s\n' "$SESSION_ID" > "$STATE_DIR/conversations/$CLIENT_ID"
    fi
    # A new hub session is open, so an earlier one's "ended" no longer applies — left in
    # place it made the exit hook skip this session too.
    rm -f "$STATE_DIR/session-ended"
    ;;
  *cortex_session_end*)
    record session-ended
    [ -n "$CLIENT_ID" ] && rm -f "$STATE_DIR/conversations/$CLIENT_ID"
    ;;
  *cortex_quality_report*) record quality-reported ;;
  *cortex_code_search*|*cortex_code_context*|*cortex_code_impact*|*cortex_cypher*)
    record discovery-used ;;
  # Recall is not discovery: it answers "why" and "has this broken before", not "where is the
  # code". Arming discovery-used here would let /cs alone open glob and search_file_content.
  *cortex_knowledge_search*) record knowledge-recalled ;;
  *cortex_memory_search*)    record memory-recalled ;;
  *cortex_task_pickup*)      record tasks-checked ;;
  *cortex_detect_changes*|*cortex_changes*) record changes-checked ;;
esac

# ── A passing build certifies a tree, not a session ──
#
# The gate markers used to survive any edit made after them, so
# "pnpm build && typecheck && lint" → edit one file → `git commit` passed the commit
# gate with code that had never been checked. Reproduced in a sandbox: arming the
# three gates, then feeding an a write_file, left quality-gates-passed armed and the commit
# gate returned 0. A write invalidates the certificate — the gates have to run again
# on the tree that is actually being committed.
writes_a_file() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(cp|mv|rm|mkdir|touch|patch|git[[:space:]]+apply)[[:space:]]' && return 0
  return 1
}
INVALIDATES=0
case "$TOOL_NAME" in
  write_file|replace|edit_file|create_file|insert_text) INVALIDATES=1 ;;
  run_shell_command|shell)
    # Editing through a shell is still editing. But a gate command that pipes its own
    # output to a file must not revoke the marker it just armed one screen above.
    if [ "$GATE_COMMAND" = "1" ] && writes_a_file "$COMMAND"; then
      INVALIDATES=1
    fi
    ;;
esac
if [ "$INVALIDATES" = "1" ]; then
  rm -f "$STATE_DIR/quality-gates-passed" "$STATE_DIR/gate-build" \
        "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint"
fi
echo '{"decision":"allow"}'
'@ | Out-File -FilePath "$geminiHooksDir\track-quality.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
# Cortex Session End Check (v7.1) — Gemini variant.
#
# v6 posted to ${CORTEX_HUB_API_URL:-http://localhost:4000}. Nothing sets that variable, so on
# every machine but the hub itself the close went to a port nobody listens on; curl's failure
# was swallowed and `session-ended` was written anyway. Sessions were never closed, and the
# hook said they were. v7 goes where the agent's own cortex calls go — the hub's MCP endpoint,
# with the key from the IDE's MCP config — and only records a close the hub confirmed.
#
# The close is sent with auto:true: the hub records it as 'abandoned', keeps it out of memory
# and /cs recall, and leaves a session that /ce already completed alone.
#
# v7.1: every conversation in a checkout shares this state directory, so `session-id` is
# whichever one ran cortex_session_start last. The tracker files each session under the
# conversation that opened it, and this hook closes that one and nothing else; with no such
# record it falls back to `session-id`.
#
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

# Gemini shows a hook's systemMessage; plain stdout is not read.
say() { printf '{"systemMessage":"%s"}\n' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

INPUT=$(cat 2>/dev/null || true)
CLIENT_ID=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    CLIENT_ID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)
  fi
fi
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)

SESSION_ID=""
OWN=""
if [ -n "$CLIENT_ID" ] && [ -d "$STATE_DIR/conversations" ]; then
  # Nothing filed under this conversation: it never opened a session, or closed it itself.
  OWN="$STATE_DIR/conversations/$CLIENT_ID"
  [ -s "$OWN" ] || exit 0
  SESSION_ID=$(head -1 "$OWN" 2>/dev/null || true)
else
  [ -f "$STATE_DIR/session-started" ] || exit 0
  [ -f "$STATE_DIR/session-ended" ] && exit 0
  [ -s "$STATE_DIR/session-id" ] && SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)
fi

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  say "WARNING: cortex session not closed — no session id was recorded. Call cortex_session_end next time."
  exit 0
fi

ACTIONS=""
[ -s "$STATE_DIR/knowledge-recalled" ]   && ACTIONS="${ACTIONS} knowledge-searched"
[ -s "$STATE_DIR/memory-recalled" ]      && ACTIONS="${ACTIONS} memory-searched"
[ -s "$STATE_DIR/discovery-used" ]       && ACTIONS="${ACTIONS} code-searched"
[ -s "$STATE_DIR/changes-checked" ]      && ACTIONS="${ACTIONS} changes-checked"
[ -s "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
[ -s "$STATE_DIR/quality-reported" ]     && ACTIONS="${ACTIONS} quality-reported"
[ -s "$STATE_DIR/tasks-checked" ]        && ACTIONS="${ACTIONS} tasks-checked"
[ -s "$STATE_DIR/gate-off" ]             && ACTIONS="${ACTIONS} gate-off($(head -c 80 "$STATE_DIR/gate-off" | tr -d '"\\\n'))"

SUMMARY="Session auto-closed (gemini, no cortex_session_end)."
[ -n "$ACTIONS" ] && SUMMARY="Session auto-closed (gemini). Activity:${ACTIONS}."

if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  say "WARNING: cortex session $SESSION_ID not closed — needs python3 and curl. Call cortex_session_end next time."
  exit 0
fi

# The hub's MCP endpoint and Authorization header, one per line, from the environment or the
# cortex-hub entry of whichever MCP config this machine has. Both shapes the installer writes
# are read: {url, headers} and the mcp-remote bridge {args: [url, --header, ...], env}.
hub_endpoint() {
  python3 - "$PROJECT_DIR" <<'PY' 2>/dev/null
import json, os, re, sys
project, home = sys.argv[1], os.path.expanduser('~')

def emit(url, auth):
    if url and auth:
        print(url)
        print(auth if auth.lower().startswith('bearer ') else 'Bearer ' + auth)
        sys.exit(0)

emit(os.environ.get('CORTEX_MCP_URL') or os.environ.get('HUB_MCP_URL'), os.environ.get('HUB_API_KEY'))

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

def servers(doc):
    out = {}
    for key in ('mcpServers', 'servers'):
        if isinstance(doc.get(key), dict):
            out.update(doc[key])
    return out

def entry(found):
    if 'cortex-hub' in found:
        return found['cortex-hub']
    return next((v for k, v in found.items() if 'cortex' in k.lower()), None)

def expand(value, env):
    return re.sub(r'\$\{(\w+)\}', lambda m: env.get(m.group(1)) or os.environ.get(m.group(1), ''), value)

def resolve(e):
    if not isinstance(e, dict):
        return
    env = e.get('env') if isinstance(e.get('env'), dict) else {}
    headers = e.get('headers') if isinstance(e.get('headers'), dict) else {}
    args = [a for a in e.get('args') or [] if isinstance(a, str)]
    url = e.get('url') or e.get('httpUrl') or e.get('serverUrl') or next((a for a in args if a.startswith('http')), None)
    auth = headers.get('Authorization') or headers.get('authorization')
    for i, a in enumerate(args[:-1]):
        if a == '--header' and args[i + 1].lower().startswith('authorization:'):
            auth = auth or args[i + 1].split(':', 1)[1]
    emit(url, expand(auth or '', env).strip())

claude = load(os.path.join(home, '.claude.json'))
for found in (
    servers(load(os.path.join(project, '.mcp.json'))),
    servers((claude.get('projects') or {}).get(project) or {}),
    servers(claude),
    servers(load(os.path.join(project, '.gemini', 'settings.json'))),
    servers(load(os.path.join(home, '.gemini', 'settings.json'))),
    servers(load(os.path.join(home, '.gemini', 'antigravity', 'mcp_config.json'))),
    servers(load(os.path.join(home, '.cursor', 'mcp.json'))),
    servers(load(os.path.join(home, '.codeium', 'windsurf', 'mcp_config.json'))),
    servers(load(os.path.join(project, '.vscode', 'mcp.json'))),
):
    resolve(entry(found))
PY
}

# A JSON body for the close. $1 = "mcp" for a tools/call, anything else for the REST route.
close_body() {
  python3 - "$1" "$SESSION_ID" "$SUMMARY" <<'PY'
import json, sys
kind, sid, summary = sys.argv[1:4]
args = {'sessionId': sid, 'summary': summary, 'auto': True}
if kind == 'mcp':
    print(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                      'params': {'name': 'cortex_session_end', 'arguments': args}}))
else:
    print(json.dumps({'summary': summary, 'auto': True}))
PY
}

# Did the tools/call succeed? The reply is JSON, or the same JSON as SSE `data:` lines.
mcp_ok() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
lines = [l[5:].strip() for l in raw.splitlines() if l.startswith("data:")] or [raw]
for line in lines:
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if isinstance(msg, dict) and isinstance(msg.get("result"), dict) and not msg["result"].get("isError"):
        sys.exit(0)
sys.exit(1)'
}

CLOSED=1
WHY=""
if [ -n "${CORTEX_HUB_API_URL:-}" ]; then
  # An explicit API URL (a self-hosted hub on this machine) keeps the direct route.
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 4 -m 10 \
    -X POST "${CORTEX_HUB_API_URL%/}/api/sessions/${SESSION_ID}/end" \
    -H 'Content-Type: application/json' -d "$(close_body rest)" 2>/dev/null)
  case "$CODE" in 2??) CLOSED=0 ;; *) WHY="${CORTEX_HUB_API_URL} answered ${CODE:-nothing}" ;; esac
else
  ENDPOINT=$(hub_endpoint)
  MCP_URL=$(printf '%s\n' "$ENDPOINT" | sed -n 1p)
  MCP_AUTH=$(printf '%s\n' "$ENDPOINT" | sed -n 2p)
  if [ -z "$MCP_URL" ] || [ -z "$MCP_AUTH" ]; then
    WHY="no cortex-hub MCP server with an Authorization header in this machine's MCP config"
  else
    # The key goes in on stdin, never on the command line, where `ps` would show it.
    if printf 'Authorization: %s\n' "$MCP_AUTH" \
        | curl -sf --connect-timeout 4 -m 10 -X POST "$MCP_URL" -H @- \
            -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
            -d "$(close_body mcp)" 2>/dev/null | mcp_ok; then
      CLOSED=0
    else
      WHY="the hub at ${MCP_URL%%\?*} did not confirm it"
    fi
  fi
fi

if [ "$CLOSED" = "0" ]; then
  [ -n "$OWN" ] && rm -f "$OWN"
  # session-ended speaks for the checkout's current session, so only that one may write it.
  if [ -z "$OWN" ] || [ "$SESSION_ID" = "$(cat "$STATE_DIR/session-id" 2>/dev/null)" ]; then
    printf 'tool=session-end-check at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_DIR/session-ended"
  fi
  say "INFO: cortex session $SESSION_ID closed as abandoned.${ACTIONS:+ Activity:${ACTIONS}}"
else
  say "WARNING: cortex session $SESSION_ID not closed — ${WHY}. Call cortex_session_end next time."
fi
exit 0
'@ | Out-File -FilePath "$geminiHooksDir\session-end-check.sh" -Encoding utf8 -NoNewline

        # Gemini settings.json
        @'
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {"type": "command", "command": ".gemini/hooks/session-init.sh", "name": "cortex_session_init"}
        ]
      }
    ],
    "BeforeTool": [
      {
        "matcher": "write_file|replace|edit_file|create_file|insert_text|glob|search_file_content|run_shell_command|shell",
        "hooks": [
          {"type": "command", "command": ".gemini/hooks/enforce-session.sh", "name": "cortex_enforce_session"}
        ]
      },
      {
        "matcher": "run_shell_command|shell",
        "hooks": [
          {"type": "command", "command": ".gemini/hooks/enforce-commit.sh", "name": "cortex_enforce_commit"}
        ]
      }
    ],
    "AfterTool": [
      {
        "matcher": ".*",
        "hooks": [
          {"type": "command", "command": ".gemini/hooks/track-quality.sh", "name": "cortex_track_quality"}
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {"type": "command", "command": ".gemini/hooks/session-end-check.sh", "name": "cortex_session_end_check"}
        ]
      }
    ]
  }
}
'@ | Out-File -FilePath ".gemini\settings.json" -Encoding utf8

        Write-Ok ("Gemini: hooks + settings.json installed (v" + $LATEST_VERSION + ")")
    }

    # ── Instruction files for other IDEs ──
    $instructionContent = @'
<!-- cortex-hub:auto-mcp -->
## Cortex Hub — Auto MCP (MANDATORY)

At the START of every conversation:
1. Call `cortex_session_start` with repo: "__GIT_REPO__", agentId: "__AGENT_ID__", mode: "development"
2. `cortex_knowledge_search` + `cortex_memory_search` once — recall what the last session decided

### Finding code — start from what you know, not from a fixed ladder
| You already know | Start with |
|---|---|
| A symbol name | `cortex_code_context(name)` — exact graph lookup, plus callers/callees/imports in one call |
| Only the behaviour | `cortex_code_search(query, limit: 10)` — ranked hybrid search, one call |
| An exact literal (env var, config key, error string) | `rg` / `grep` — this is not a ranking problem |
| A relationship across files | `cortex_cypher` |

**Search once, read all ten.** On the cortex-hub index the target file is in the top 10 for
15/15 queries but at rank 1 for only 8/15 — so scan the whole result set, and never re-run a
reworded version of the same query. Ask a different question or switch tool instead.

`cortex_code_impact` before editing something exported or shared. Knowledge and memory are
for errors and decisions, not for locating code.

**Across repos:** omit `repo:` to search every repo in the organization of this project
(the client + server + tools of one product). Projects are isolated per organization, so it never reaches
another one. Running sessions in two organizations with one API key? Pass `org:`.

### Error Protocol
1. `cortex_knowledge_search` first — someone may have solved this
2. `cortex_memory_search` — you may have seen it before
3. Fix the error
4. Non-obvious fixes: `cortex_knowledge_store`

### Quality Gates
Run verify commands from `.cortex/project-profile.json`, then `cortex_quality_report`.
After a push: `cortex_code_reindex`. End session: `cortex_session_end` with sessionId and summary.
<!-- cortex-hub:auto-mcp -->
'@

    if (Test-IDESelected "cursor") {
        (($instructionContent -replace "__AGENT_ID__", "cursor") -replace "__GIT_REPO__", $GitRepo) | Out-File -FilePath ".cursorrules" -Encoding utf8
        Write-Ok "Created .cursorrules (cursor)"
    }
    if (Test-IDESelected "windsurf") {
        (($instructionContent -replace "__AGENT_ID__", "windsurf") -replace "__GIT_REPO__", $GitRepo) | Out-File -FilePath ".windsurfrules" -Encoding utf8
        Write-Ok "Created .windsurfrules (windsurf)"
    }
    if (Test-IDESelected "vscode") {
        if (-not (Test-Path ".vscode")) { New-Item -ItemType Directory -Path ".vscode" -Force | Out-Null }
        (($instructionContent -replace "__AGENT_ID__", "vscode-copilot") -replace "__GIT_REPO__", $GitRepo) | Out-File -FilePath ".vscode\copilot-instructions.md" -Encoding utf8
        Write-Ok "Created .vscode\copilot-instructions.md (vscode-copilot)"
    }
    if (Test-IDESelected "codex") {
        if (-not (Test-Path ".codex")) { New-Item -ItemType Directory -Path ".codex" -Force | Out-Null }
        (($instructionContent -replace "__AGENT_ID__", "codex") -replace "__GIT_REPO__", $GitRepo) | Out-File -FilePath ".codex\instructions.md" -Encoding utf8
        Write-Ok "Created .codex\instructions.md (codex)"
    }

    # Write version marker
    $LATEST_VERSION | Out-File -FilePath ".cortex\.hooks-version" -Encoding utf8 -NoNewline
    Write-Ok ("Version: v" + $LATEST_VERSION + " marked")
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
$claudeMdBody = @'
## Cortex Hub — MANDATORY (enforced by hooks — violations are BLOCKED)

**Call `cortex_session_start` in the first turn of every conversation.** Without it, every
Edit, Write and file-modifying Bash command is refused by a hook (exit code 2). It does not
depend on anything else, so send it in the same message as your first lookup, not a turn of
its own.

```
cortex_session_start(repo: "__GIT_REPO__", mode: "development", agentId: "claude-code")
```

Pass nothing else: a hook adds the id of this conversation, the git branch, the IDE and the
fields of `.cortex/agent-identity.json`, so the dashboard can tell your machines and IDEs apart.

### Finding code fast (MANDATORY — and a fixed ladder is the slow way)

Start from what you already know. Until one cortex discovery call has run in this session,
a hook refuses Grep, Glob and a Bash command that starts with `grep`, `rg` or `find`, even
for a literal: make the cortex call first, then grep freely.

| You already know | Start with | Why |
|---|---|---|
| A symbol name | `cortex_code_context(name)` | Exact graph lookup — no ranking to get wrong — and it answers callers, callees and imports in one call |
| Only the behaviour | `cortex_code_search(query, limit: 10)` | Ranked hybrid search over the index. One call, then read the list |
| An exact literal (env var, config key, error string) | `rg` / `grep` | Not a ranking problem. Lexical search alone ranks *worse* than vector on questions, but it is right for a string that either appears or does not |
| A relationship across files | `cortex_cypher` | One graph query instead of N searches |

**Search once, then read the whole set.** Measured on the cortex-hub index (n=15): the target
file is in the top 10 for 15/15 queries, top 3 for 11/15, rank 1 for only 8/15. So scan all ten
hits before choosing, and do not re-run a reworded version of the same query — recall@10 is
already 1.000, so it returns the same set. Ask a different question or switch tool instead.

**Read the lines a hit names, not the file.** Each hit carries its line range (`L120-168`):
Read with that offset and limit, or `rg -n` inside the file. A whole file is often ten times
the chunk you came for.

`cortex_code_impact` before editing something exported or shared — not as a ritual on every file.

**Across repos:** omit `repo:` to search every repo in the organization of this project —
related repos (the client, server and tools of one product) belong to one, and a cross-repo
search never leaves it. `cortex_list_repos()` shows exactly which repos that covers. Running sessions in two
organizations with one API key at once? Pass `org:` — the `project.orgId` returned by `cortex_session_start`.

**Knowledge and memory are for errors and decisions, not for locating code.** Recall them once
at session start, then whenever something breaks.

### Before editing shared files

Call `cortex_changes` to check if another agent modified the same files.

### When encountering an error or bug

1. **FIRST** search `cortex_knowledge_search` — someone may have solved this already
2. **THEN** `cortex_memory_search` — you may have seen this before
3. Fix the error
4. Non-obvious fixes: **YOU MUST** call `cortex_knowledge_store` to record the solution

### After pushing code

Call `cortex_code_reindex` to update code intelligence:
```
repo: "__GIT_REPO__"
branch: "<current branch>"
```

### Quality gates (enforced — commit blocked without these)

Every session must end with verification commands from `.cortex/project-profile.json`.
Call `cortex_quality_report` with results. Call `cortex_session_end` to close the session.
**Commits are BLOCKED by hooks until quality gates pass.**

### Compliance Enforcement (Automated)

Your tool usage is **automatically tracked and scored**:

1. **Session Compliance Score** — `cortex_session_end` returns a grade (A/B/C/D) based on 5-category tool coverage.
2. **MCP Response Hints** — Every tool response includes adaptive hints about what to use next.
'@
$claudeMdBody = $claudeMdBody -replace "__GIT_REPO__", $GitRepo
$claudeMdContent = "$cortexMarker`n$claudeMdBody`n$cortexMarker"

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
} elseif (Select-String -Path "CLAUDE.md" -Pattern "cortex_session_start" -Quiet) {
    # A hand-written cortex section with no marker. Appending would leave two MANDATORY
    # sections giving different orders — worse than not touching the file at all.
    Write-Warn "CLAUDE.md: already has cortex instructions but no marker - left untouched."
} else {
    Add-Content -Path "CLAUDE.md" -Value "`n$claudeMdContent"
    Write-Ok "CLAUDE.md: cortex section appended"
}

# ══════════════════════════════════════════════
# Phase 6.5: Ensure .gitignore excludes generated files
# ══════════════════════════════════════════════

$gitignoreEntries = @(
    ".claude/"
    ".cortex/.session-state/"
    ".codex/"
    ".windsurfrules"
    ".cursorrules"
)

# A generated file is only safe to ignore while git is not already tracking it.
# In cortex-hub itself .claude/, .codex/ and .cursorrules ARE the committed source
# of truth. An ignore line for a tracked path does not untrack it, so nothing
# breaks today - it breaks silently for whoever removes and re-adds the file.
function Test-TrackedByGit($path) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
    # Windows PowerShell 5.1 turns a redirected native stderr line into an error record,
    # and under the script's "Stop" that ends the install. "did not match any file(s)"
    # is git's normal answer for an untracked path, so this function runs under Continue.
    $ErrorActionPreference = "Continue"
    git ls-files --error-unmatch -- $path 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

$gitignoreEntries = @($gitignoreEntries | Where-Object { -not (Test-TrackedByGit $_) })

if (Test-Path ".gitignore") {
    $content = Get-Content ".gitignore" -Raw -ErrorAction SilentlyContinue
    $added = 0
    $needsHeader = $content -notmatch "Cortex Hub"

    foreach ($entry in $gitignoreEntries) {
        if ($content -notmatch [regex]::Escape($entry)) {
            if ($added -eq 0 -and $needsHeader) {
                Add-Content -Path ".gitignore" -Value "`n# Cortex Hub (generated by /install - do not commit)"
            }
            Add-Content -Path ".gitignore" -Value $entry
            $added++
        }
    }
    if ($added -gt 0) { Write-Ok ".gitignore: added $added entries" }
    else { Write-Ok ".gitignore: already configured" }
} else {
    "# Cortex Hub (generated by /install - do not commit)" | Out-File -FilePath ".gitignore" -Encoding utf8
    $gitignoreEntries | Add-Content -Path ".gitignore"
    Write-Ok ".gitignore: created with cortex entries"
}

# ══════════════════════════════════════════════
# Phase 7: Summary
# ══════════════════════════════════════════════
Write-Host ""
Write-Host ("  Cortex Hub setup complete (v" + $LATEST_VERSION + ")") -ForegroundColor Green
Write-Host ""
Write-Host "  Project:   $(Split-Path $ProjectDir -Leaf)"
Write-Host "  MCP:       $(if ($McpConfigured) { 'configured' } else { 'needs API key' })"
Write-Host "  IDEs:      $($SelectedIDEs -join ', ')"
Write-Host ("  Hooks:     v" + $LATEST_VERSION)
Write-Host ""
if (-not $McpConfigured) { Write-Warn "Set HUB_API_KEY and re-run to configure MCP" }
Write-Host "  Restart your IDE to pick up changes" -ForegroundColor Cyan
Write-Host ""
