# ============================================================
# Cortex Hub — Remote Agent Bootstrap (Windows)
# Downloads cortex-agent.ps1 + dependencies, then launches.
# No repo clone needed.
#
# Usage:
#   iwr -useb "https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1" -OutFile $env:TEMP\run-agent.ps1; & $env:TEMP\run-agent.ps1
#   .\run-agent.ps1 start
#   .\run-agent.ps1 start -Daemon
# ============================================================

param(
    [Parameter(Position = 0)]
    [string]$Command = "",
    [switch]$Daemon,
    [switch]$Background,
    [int]$LogLines = 50
)

$ErrorActionPreference = "Stop"
$RepoRaw = "https://raw.githubusercontent.com/lktiep/cortex-hub/master"
$WorkDir = if ($env:CORTEX_AGENT_HOME) { $env:CORTEX_AGENT_HOME } else { Join-Path $env:TEMP "cortex-agent-remote" }

function Write-Info  { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Blue }
function Write-Ok    { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Green }
function Write-Err   { param([string]$msg) Write-Host "[cortex] $msg" -ForegroundColor Red }

# ── Check prerequisites ──
$nodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodePath) {
    Write-Err "node is required. Install Node.js: https://nodejs.org"
    exit 1
}
Write-Ok "Node.js found: $($nodePath.Source)"

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
Download-IfNeeded "$RepoRaw/scripts/cortex-agent.ps1" "$WorkDir\scripts\cortex-agent.ps1"
Download-IfNeeded "$RepoRaw/scripts/orchestrator-prompt.md" "$WorkDir\scripts\orchestrator-prompt.md"
Download-IfNeeded "$RepoRaw/.cortex/capability-templates.json" "$WorkDir\.cortex\capability-templates.json"
Download-IfNeeded "$RepoRaw/.cortex/agent-identity.json" "$WorkDir\.cortex\agent-identity.json"

# ── Install ws package if needed ──
$wsFound = $false
try {
    & node -e "require('ws')" 2>$null
    if ($LASTEXITCODE -eq 0) { $wsFound = $true }
} catch { }

if (-not $wsFound) {
    $wsNodeModules = "$($WorkDir -replace '\\','/')/node_modules/ws"
    try {
        & node -e "require('$wsNodeModules')" 2>$null
        if ($LASTEXITCODE -eq 0) { $wsFound = $true }
    } catch { }
}

if (-not $wsFound) {
    Write-Info "Installing ws package..."
    Push-Location $WorkDir
    try { & npm install --no-save ws 2>&1 | Out-Null } catch { }
    Pop-Location
    Write-Ok "ws package installed"
}

# ── Set NODE_PATH so ws is resolvable ──
$env:NODE_PATH = "$WorkDir\node_modules;$($env:NODE_PATH)"

Write-Ok "Ready. Launching cortex-agent..."
Write-Host ""

# ── Forward to native cortex-agent.ps1 ──
$agentScript = Join-Path (Join-Path $WorkDir "scripts") "cortex-agent.ps1"
$psArgs = @()
if ($Command) { $psArgs += $Command }
if ($Daemon) { $psArgs += "-Daemon" }
if ($Background) { $psArgs += "-Background" }
if ($LogLines -ne 50) { $psArgs += "-LogLines"; $psArgs += $LogLines }

& $agentScript @psArgs
