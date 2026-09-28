# Cortex Hub — Unified Installer (v0.8.0) — Windows PowerShell
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
$HOOKS_MINOR = 5
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
            param([string]$Path, [string]$RootKey, [string]$Label)
            $dir = Split-Path $Path -Parent
            if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

            # Build MCP entry as ordered dict (PS 5.1 compatible)
            $mcpEntry = [ordered]@{
                command = "npx"
                args = @("-y", "mcp-remote", $McpUrl, "--header", "Authorization:`${AUTH_HEADER}")
                env = [ordered]@{ AUTH_HEADER = "Bearer $ApiKey" }
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

        Set-McpConfig -Path $ClaudeJson -RootKey "mcpServers" -Label "Claude Code"
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
# Cortex Session Init (v7.1) — arms the gates; keeps discovery state across compaction.
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
echo "Run /cs first: cortex_session_start, then knowledge+memory recall. Until then edits are BLOCKED, and Grep/Glob stay blocked until a cortex discovery tool has run."
'@

        # enforce-session.sh
        Write-ShHook "enforce-session" @'
#!/bin/bash
# Cortex Session Enforcement (v6.1) — hold tools back until the cortex workflow is followed.
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
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  # Without this fallback the whole gate silently became a no-op on any machine without jq.
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
" 2>/dev/null || true)"
fi

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
    if ! marker_ok knowledge-recalled || ! marker_ok memory-recalled; then
      echo "BLOCKED: run cortex_knowledge_search and cortex_memory_search before editing — they restore what previous sessions already decided and already fixed. Run /cs to do every step at once. $HOW_OUT" >&2
      exit 2
    fi
  fi
  exit 0
fi

# ── Session NOT started: block writes and codebase search, allow plain reads ──
# Until v7.1 of session-init this branch never ran: the init hook created the session-started
# marker itself, so every session looked started before cortex_session_start was ever called.
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit)
    echo "BLOCKED: call cortex_session_start first (or run /cs). No edits without a session." >&2
    exit 2 ;;
  Grep|Glob)
    echo "BLOCKED: run /cs first (cortex_session_start + knowledge/memory recall), then search with cortex_code_search. $HOW_OUT" >&2
    exit 2 ;;
  Bash)
    if is_codebase_search "$COMMAND"; then
      echo "BLOCKED: run /cs first, then search with cortex_code_search. find/grep/rg unlock once a cortex discovery tool has run. $HOW_OUT" >&2
      exit 2
    fi
    # The write check goes before the read allowlist, or `cat > file` passes as a read.
    if is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND"; then
      echo "BLOCKED: call cortex_session_start first (or run /cs). No file modifications without a session." >&2
      exit 2
    fi
    [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ (status|log|diff|branch|remote|show)|pnpm\ |npm\ |yarn\ |cargo\ |go\ |python|curl|dotnet\ |node\ ) ]] && exit 0
    [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ |touch\ |chmod\ ) ]] && {
      echo "BLOCKED: call cortex_session_start first (or run /cs). No file modifications without a session." >&2
      exit 2
    }
    exit 0 ;;
esac
exit 0
'@

        # enforce-commit.sh
        Write-ShHook "enforce-commit" @'
#!/bin/bash
# Cortex Commit Enforcement (v5.0) — a commit needs the workflow behind it.
#
# v4 accepted `quality-gates-passed`, which the tracker used to write the moment
# cortex_quality_report was called — so reporting a failure unlocked the commit just as
# well as passing. The marker now comes only from build/typecheck/lint actually running
# green, and the report is a separate, softer expectation.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
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
# Cortex Quality Tracker (v4.0) — records what actually happened, as evidence.
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

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat)
COMMAND=""
TOOL_NAME=""
OUTPUT=""

if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('tool_response', d.get('tool_output',''))
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(r) if not isinstance(r,str) else r)}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Evidence, not existence: the enforcement hook only accepts a marker that says who wrote it.
record() {
  printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"
}

# A command that reports success while the build failed — `pnpm build || true`, or a pipe
# that swallows the status. If the output says it failed, the gate does not open.
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖|FAIL |Exit status [1-9]'
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
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    ;;
  *cortex_session_end*)    record session-ended ;;
  *cortex_quality_report*) record quality-reported ;;
  *cortex_code_search*|*cortex_code_context*|*cortex_code_impact*|*cortex_cypher*)
    record discovery-used ;;
  # Recall is not discovery: knowledge and memory answer "why" and "has this broken before",
  # not "where is the code". Arming discovery-used here would let /cs alone open Grep and Glob.
  *cortex_knowledge_search*) record knowledge-recalled ;;
  *cortex_memory_search*)    record memory-recalled ;;
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
# Cortex Session End Check (v6) — closes the cortex session when the session really ends.
#
# v5 was wired to the Stop event, which fires every time the agent finishes a turn. Had the
# session id ever been captured (it was not — v3 of the tracker read the wrong JSON field),
# this would have closed the session after the first answer and left the rest of the
# conversation running outside it. It belongs on SessionEnd.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ -f "$STATE_DIR/session-started" ] || exit 0
[ -f "$STATE_DIR/session-ended" ] && exit 0

SESSION_ID=""
[ -s "$STATE_DIR/session-id" ] && SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  echo "WARNING: cortex session not closed — no session id was recorded. Run /ce next time."
  exit 0
fi

API_URL="${CORTEX_HUB_API_URL:-http://localhost:4000}"
ACTIONS=""
[ -s "$STATE_DIR/knowledge-recalled" ]   && ACTIONS="${ACTIONS} knowledge-searched"
[ -s "$STATE_DIR/memory-recalled" ]      && ACTIONS="${ACTIONS} memory-searched"
[ -s "$STATE_DIR/discovery-used" ]       && ACTIONS="${ACTIONS} code-searched"
[ -s "$STATE_DIR/changes-checked" ]      && ACTIONS="${ACTIONS} changes-checked"
[ -s "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
[ -s "$STATE_DIR/quality-reported" ]     && ACTIONS="${ACTIONS} quality-reported"
[ -s "$STATE_DIR/tasks-checked" ]        && ACTIONS="${ACTIONS} tasks-checked"
[ -s "$STATE_DIR/gate-off" ]             && ACTIONS="${ACTIONS} gate-off($(head -c 80 "$STATE_DIR/gate-off" | tr -d '"\n'))"

SUMMARY="Session auto-closed (no /ce)."
[ -n "$ACTIONS" ] && SUMMARY="Session auto-closed. Activity:${ACTIONS}."

curl -X POST "${API_URL}/api/sessions/${SESSION_ID}/end" \
  -H 'Content-Type: application/json' \
  -d "{\"summary\":\"${SUMMARY}\"}" \
  --connect-timeout 5 -s -o /dev/null || true

touch "$STATE_DIR/session-ended"
echo "INFO: cortex session $SESSION_ID auto-closed.${ACTIONS:+ Activity:${ACTIONS}}"
exit 0
'@

        # settings.json — bash .sh hooks (Claude Code uses bash on all platforms)
        $settingsContent = @'
{
  "hooks": {
    "SessionStart": [
      {"matcher": "", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/session-init.sh\""}]}
    ],
    "PreToolUse": [
      {"matcher": "Edit|Write|NotebookEdit|Bash", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/enforce-session.sh\""}]},
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/enforce-commit.sh\""}]}
    ],
    "PostToolUse": [
      {"matcher": "", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/track-quality.sh\""}]}
    ],
    "SessionEnd": [
      {"matcher": "", "hooks": [{"type": "command", "command": "bash -c \"cd \\$(git rev-parse --show-toplevel 2>/dev/null) && bash .claude/hooks/session-end-check.sh\""}]}
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
# /cs — Cortex Start v0.8.0

> Version: 0.8.0 | Updated: 2026-09-28
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
ide: "<your IDE>"
branch: "<current git branch>"
```
Save `session_id`, `projectId` and `project.orgId` from the response. `orgId` is the boundary of a cross-repo search.
If `recentChanges.count > 0` → warn user and `git pull` before any edits.

## Step 2: Recall Context (parallel)
Call BOTH in parallel:
- `cortex_knowledge_search(query: "session summary progress next session")`
- `cortex_memory_search(query: "session context decisions lessons", agentId: "claude-code")`

These return what was done last session, key decisions, and next steps.

## Step 3: Conflict Check
`cortex_changes(agentId: "claude-code", projectId: "<from step 1>")`

## Step 4: Task Pickup (Optional)
If `cortex_task_pickup` tool is available:
`cortex_task_pickup()` — check for Conductor tasks assigned to you.
If tasks exist → list them. Ask user which to work on, or continue with their request.
If the tool is not available (e.g. in solo dev mode), skip this step.

## Step 5: Working State Check
Run `git status`. If uncommitted changes:
- `cortex_detect_changes(scope: "all")` — analyze risk level
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
2. `cortex_plan_quality(plan: "<your plan>")` → score 0-100
3. If score < 60 → refine. If 60-80 → proceed with caution. If > 80 → execute.

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
1. `cortex_detect_changes(scope: "staged")` — verify blast radius
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
# /ce — Cortex End v0.8.0

> Version: 0.8.0 | Updated: 2026-09-28
> Changelog: v0.8.0 — search-once/read-all-ten ordering from measured retrieval; recall no longer counts as discovery
> Changelog: v0.7.0 — unified versioning, session_end auto-saves memory, removed STATE.md, streamlined steps
> Changelog: v2.0 — added detect_changes, tool stats, task completion, recipe capture check

Run ALL steps IN ORDER before ending the session.

## Step 1: Pre-commit Check
If uncommitted changes exist:
- `cortex_detect_changes(scope: "all")` — verify blast radius
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
# Cortex Session Init (v7.1) — Gemini variant.
#
# v3 wiped the gate markers on every SessionStart. Where the host distinguishes a resumed or
# compacted session from a fresh one, re-arming the discovery gate mid-task is a bug: the agent
# already did the recall, and it cannot prove it any more. v3 also never cleared changes-checked
# or tasks-checked, so those markers survived for months and the checks silently stopped running.
#
# And it cleared session-started on every start, which is right — but the claude variant used to
# create it here instead, making its whole session gate vacuous. Only the tracker writes it, from
# a real cortex_session_start call.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
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
    echo '{"systemMessage":"Cortex: same session ('"$SOURCE"') — discovery state kept."}'
    exit 0 ;;
esac

rm -f "$STATE_DIR/session-started" "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/quality-reported" "$STATE_DIR/session-ended" \
      "$STATE_DIR/discovery-used" "$STATE_DIR/knowledge-recalled" \
      "$STATE_DIR/memory-recalled" "$STATE_DIR/changes-checked" \
      "$STATE_DIR/tasks-checked" "$STATE_DIR/gate-off" "$STATE_DIR/session-id" 2>/dev/null
echo '{"systemMessage":"MANDATORY: call cortex_session_start, then cortex_knowledge_search + cortex_memory_search, before any edit. search_file_content and glob stay blocked until a cortex discovery tool has run."}'
'@ | Out-File -FilePath "$geminiHooksDir\session-init.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
# Cortex Session Enforcement (v6.1) — Gemini variant.
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
      deny "BLOCKED: run cortex_knowledge_search and cortex_memory_search before editing — they restore what previous sessions already decided and already fixed. $HOW_OUT"
    fi
  fi
  allow
fi

# Session not started: block writes and codebase search, allow plain reads.
case "$TOOL_NAME" in
  write_file|replace|edit_file|create_file|insert_text)
    deny "BLOCKED: call cortex_session_start first. No edits without a session." ;;
  glob|search_file_content)
    deny "BLOCKED: call cortex_session_start first, then search with cortex_code_search. $HOW_OUT" ;;
  run_shell_command|shell)
    is_codebase_search "$COMMAND" && deny "BLOCKED: call cortex_session_start first, then search with cortex_code_search. $HOW_OUT"
    is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" \
      && deny "BLOCKED: call cortex_session_start first. No file modifications without a session."
    printf '%s' "$COMMAND" | grep -Eq '(git[[:space:]]+(add|commit|push|reset)|^rm[[:space:]]|^mv[[:space:]]|^cp[[:space:]]|^mkdir[[:space:]])' \
      && deny "BLOCKED: call cortex_session_start first. No file modifications without a session." ;;
esac
allow
'@ | Out-File -FilePath "$geminiHooksDir\enforce-session.sh" -Encoding utf8 -NoNewline

        @'
#!/bin/bash
# Cortex Commit Enforcement (v5.0) — Gemini variant.
#
# v3 accepted quality-gates-passed, which the tracker wrote the moment cortex_quality_report was
# called — so reporting a failure unlocked the commit just as well as passing. The marker now
# comes only from build/typecheck/lint actually running green.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
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
# Cortex Quality Tracker (v4.0) — Gemini variant.
#
# Two bugs from v3: cortex_quality_report touched quality-gates-passed, so reporting a failure
# counted as passing; and every marker was an empty `touch`, which the enforcement hook could not
# tell apart from a forged one. Markers now carry the tool and time that produced them, a gate is
# only marked when the command output does not look like a failure, and the cortex session id is
# captured so the session can actually be closed.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
INPUT=$(cat)

TOOL_NAME=""; COMMAND=""; OUTPUT=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(d.get(\"tool_response\", d.get(\"tool_output\",\"\"))))}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
record() { printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"; }
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖|FAIL |Exit status [1-9]'
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
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    ;;
  *cortex_session_end*)    record session-ended ;;
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
# Cortex Session End Check (v6) — Gemini variant.
#
# v3 only printed a warning, which nothing reads once the session is over, so every gemini
# session stayed open forever on the hub. This closes it.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ -f "$STATE_DIR/session-started" ] || exit 0
[ -f "$STATE_DIR/session-ended" ] && exit 0

SESSION_ID=""
[ -s "$STATE_DIR/session-id" ] && SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)
if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  echo '{"systemMessage":"WARNING: cortex session not closed — no session id was recorded. Call cortex_session_end."}'
  exit 0
fi

API_URL="${CORTEX_HUB_API_URL:-http://localhost:4000}"
ACTIONS=""
[ -s "$STATE_DIR/knowledge-recalled" ]   && ACTIONS="${ACTIONS} knowledge-searched"
[ -s "$STATE_DIR/memory-recalled" ]      && ACTIONS="${ACTIONS} memory-searched"
[ -s "$STATE_DIR/discovery-used" ]       && ACTIONS="${ACTIONS} code-searched"
[ -s "$STATE_DIR/changes-checked" ]      && ACTIONS="${ACTIONS} changes-checked"
[ -s "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
[ -s "$STATE_DIR/quality-reported" ]     && ACTIONS="${ACTIONS} quality-reported"
[ -s "$STATE_DIR/tasks-checked" ]        && ACTIONS="${ACTIONS} tasks-checked"

SUMMARY="Session auto-closed (gemini, no cortex_session_end)."
[ -n "$ACTIONS" ] && SUMMARY="Session auto-closed (gemini). Activity:${ACTIONS}."
curl -X POST "${API_URL}/api/sessions/${SESSION_ID}/end" \
  -H 'Content-Type: application/json' -d "{\"summary\":\"${SUMMARY}\"}" \
  --connect-timeout 5 -s -o /dev/null || true
touch "$STATE_DIR/session-ended"
echo '{"systemMessage":"INFO: cortex session closed."}'
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
2. If `recentChanges.count > 0`, warn user and run `git pull`
3. `cortex_knowledge_search` + `cortex_memory_search` once — recall what the last session decided

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

**YOUR FIRST ACTION in every conversation MUST be calling `cortex_session_start`.
If you skip this, all Edit/Write/file-modifying Bash commands will return exit code 2 (BLOCKED).
This is not optional — it is enforced by pre-tool hooks.**

```
cortex_session_start(repo: "__GIT_REPO__", mode: "development", agentId: "claude-code")
```

Then:
- If `recentChanges.count > 0` in the response, warn the user and run `git pull`

### Agent Identity (send with session_start if available)

Read `.cortex/agent-identity.json` and pass identity fields:
```
cortex_session_start(
  repo: "__GIT_REPO__",
  mode: "development",
  agentId: "claude-code",
  hostname: "<from agent-identity.json>",
  os: "<from agent-identity.json>",
  ide: "claude-code-cli",
  branch: "<current git branch>",
  role: "<from agent-identity.json>",
  capabilities: ["<from agent-identity.json>"]
)
```
This helps Dashboard identify which agent you are across multiple IDEs/machines.

### Finding code fast (MANDATORY — and a fixed ladder is the slow way)

Start from what you already know. Grep and Glob are blocked by a hook until a cortex
discovery tool has run in this session.

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
