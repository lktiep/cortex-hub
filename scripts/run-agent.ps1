# ============================================================
# Cortex Hub — Remote Agent Bootstrap (Windows)
# Downloads cortex-agent.sh + dependencies, then launches via Git Bash.
#
# Usage:
#   iwr -useb "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1" -OutFile $env:TEMP\run-agent.ps1; & $env:TEMP\run-agent.ps1
#   .\run-agent.ps1 launch
#   .\run-agent.ps1 start --daemon --preset fullstack
# ============================================================

param([Parameter(ValueFromRemainingArguments)]$Args)

$ErrorActionPreference = "Stop"
$RepoRaw = "https://raw.githubusercontent.com/lktiep/cortex-hub/master"
$WorkDir = if ($env:CORTEX_AGENT_HOME) { $env:CORTEX_AGENT_HOME } else { Join-Path $env:TEMP "cortex-agent-remote" }

function Write-Info  { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Blue }
function Write-Ok    { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Green }
function Write-Err   { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Red }

# ── Check prerequisites ──
$bashPath = Get-Command bash -ErrorAction SilentlyContinue
if (-not $bashPath) {
    Write-Err "bash (Git Bash) is required. Install Git for Windows: https://git-scm.com"
    exit 1
}
$nodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodePath) {
    Write-Err "node is required. Install Node.js: https://nodejs.org"
    exit 1
}

# ── Setup workspace ──
$dirs = @("$WorkDir\scripts", "$WorkDir\.cortex", "$WorkDir\node_modules")
foreach ($d in $dirs) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Write-Info "Workspace: $WorkDir"

# ── Download files ──
function Download-IfNeeded {
    param([string]$Url, [string]$Dest)
    if (Test-Path $Dest) {
        $age = (New-TimeSpan -Start (Get-Item $Dest).LastWriteTime -End (Get-Date)).TotalSeconds
        if ($age -lt 3600) { return }
    }
    try { Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -ErrorAction Stop } catch { }
}

Write-Info "Downloading agent scripts..."
Download-IfNeeded "$RepoRaw/scripts/cortex-agent.sh" "$WorkDir\scripts\cortex-agent.sh"
Download-IfNeeded "$RepoRaw/scripts/orchestrator-prompt.md" "$WorkDir\scripts\orchestrator-prompt.md"
Download-IfNeeded "$RepoRaw/.cortex/capability-templates.json" "$WorkDir\.cortex\capability-templates.json"
Download-IfNeeded "$RepoRaw/.cortex/agent-identity.json" "$WorkDir\.cortex\agent-identity.json"

# ── Install ws package if needed ──
$wsCheck = & node -e "require('ws')" 2>&1
if ($LASTEXITCODE -ne 0) {
    $wsCheck2 = & node -e "require('$($WorkDir -replace '\\','/')/node_modules/ws')" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Info "Installing ws package..."
        Push-Location $WorkDir
        & npm install --no-save ws 2>&1 | Out-Null
        Pop-Location
        Write-Ok "ws package installed"
    }
}

# ── Set NODE_PATH ──
$env:NODE_PATH = "$WorkDir\node_modules;$($env:NODE_PATH)"

Write-Ok "Ready. Launching cortex-agent..."
Write-Host ""

# ── Forward to cortex-agent.sh via bash ──
$agentScript = "$WorkDir/scripts/cortex-agent.sh" -replace '\\', '/'
$bashArgs = @($agentScript) + $Args
& bash @bashArgs
