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
if (Test-Path (Join-Path $StateDir "session-started")) {
    # Nudge: hint if Grep used before cortex discovery tools
    if (-not (Test-Path (Join-Path $StateDir "discovery-used"))) {
        try {
            $peek = [Console]::In.ReadToEnd() | ConvertFrom-Json
            if ($peek.tool_name -eq "Grep") {
                Write-Host "HINT: Use cortex_code_search BEFORE grep." -ForegroundColor Yellow
            }
        } catch {}
    }
    exit 0
}
try {
    $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ToolName = $json.tool_name
} catch {
    Write-Error "BLOCKED: Cannot parse hook input."
    exit 2
}
if ($ToolName -match "^(Edit|Write|NotebookEdit)$") {
    Write-Error "BLOCKED: Call cortex_session_start first."
    exit 2
}
if ($ToolName -eq "Bash") {
    $Command = $json.tool_input.command
    if ($Command -match "^(ls|cat|head|tail|pwd|which|echo|git |pnpm |npm |yarn |cargo |go |python|curl|dotnet )") { exit 0 }
    if ($Command -match "(git (add|commit|push|reset)|rm |mv |cp |mkdir |touch |chmod |sed -i)") {
        Write-Error "BLOCKED: Call cortex_session_start first."
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
        # Windows: use PowerShell hooks (no Git Bash / jq / python dependency)
        $hooksPath = '.claude\hooks'
        $psHookCmd = "powershell.exe -ExecutionPolicy Bypass -File `${CLAUDE_PROJECT_DIR:-.}\$hooksPath"
        $settingsJson = @{
            hooks = @{
                SessionStart = @(@{ matcher = ""; hooks = @(@{ type = "command"; command = "$psHookCmd\session-init.ps1" }) })
                PreToolUse = @(
                    @{ matcher = "Edit|Write|NotebookEdit|Bash"; hooks = @(@{ type = "command"; command = "$psHookCmd\enforce-session.ps1" }) },
                    @{ matcher = "Bash"; hooks = @(@{ type = "command"; command = "$psHookCmd\enforce-commit.ps1" }) }
                )
                PostToolUse = @(@{ matcher = ""; hooks = @(@{ type = "command"; command = "$psHookCmd\track-quality.ps1" }) })
                Stop = @(@{ matcher = ""; hooks = @(@{ type = "command"; command = "$psHookCmd\session-end-check.ps1" }) })
            }
        }
        $settingsJson | ConvertTo-Json -Depth 6 | Out-File -FilePath ".claude\settings.json" -Encoding utf8

        Write-Ok ("Claude: PS1 hooks + settings.json installed (v" + $HOOKS_VERSION + ")")
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
    $instructionContent = @'
<!-- cortex-hub:auto-mcp -->
## Cortex Hub - Auto MCP (MANDATORY)

At the START of every conversation:
1. Call ``cortex_session_start`` with repo, agentId, mode: "development"
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
'@

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
$claudeMdBody = @'
## Cortex Hub — MANDATORY (enforced by hooks)

**YOUR FIRST ACTION in every conversation MUST be calling ``cortex_session_start``.**
If you skip this, all Edit/Write/file-modifying Bash commands will return exit code 2 (BLOCKED).

``cortex_session_start(repo: "__REPO__", mode: "development", agentId: "claude-code")``

Then:
- If ``recentChanges.count > 0`` - warn user and ``git pull``
- Read ``STATE.md`` if it exists

### Quality gates (enforced - commit blocked without these)
Run verify commands from ``.cortex/project-profile.json``.
Call ``cortex_quality_report`` then ``cortex_session_end``.
'@
$claudeMdBody = $claudeMdBody -replace "__REPO__", $GitRepo
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
