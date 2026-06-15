# Cortex Worker Daemon — Background task executor (PowerShell)
# Polls for assigned tasks and executes them with claude -p
#
# Usage:
#   .\scripts\cortex-worker.ps1                        # Default agent name from hostname
#   .\scripts\cortex-worker.ps1 -Name "extractor"      # Custom agent name
#   .\scripts\cortex-worker.ps1 -Engine codex           # Use codex instead of claude
#   .\scripts\cortex-worker.ps1 -Interval 60            # Poll every 60s
#   .\scripts\cortex-worker.ps1 -Once                   # Run once then exit
#
# Requires: HUB_API_KEY env var or .env file, claude CLI or codex CLI
# Compatible with PowerShell 5.1+

[CmdletBinding()]
param(
    [string]$Name = $env:COMPUTERNAME,
    [ValidateSet("claude", "codex")]
    [string]$Engine = "claude",
    [int]$Interval = 30,
    [switch]$Once
)

$ErrorActionPreference = "Stop"

# ── Constants ───────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$McpUrl = if ($env:HUB_MCP_URL) { $env:HUB_MCP_URL } else { "http://localhost:8318/mcp" }

# ── Logging helpers ─────────────────────────────────────────────────────────
function Write-Log   { param([string]$Msg) Write-Host "[worker $(Get-Date -Format 'HH:mm:ss')] $Msg" }
function Write-Ok    { param([string]$Msg) Write-Host "[worker $(Get-Date -Format 'HH:mm:ss')] $Msg" -ForegroundColor Green }
function Write-Err   { param([string]$Msg) Write-Host "[worker $(Get-Date -Format 'HH:mm:ss')] $Msg" -ForegroundColor Red }

# ── Resolve API key ────────────────────────────────────────────────────────
$ApiKey = $env:HUB_API_KEY
if (-not $ApiKey) {
    $envFile = Join-Path $ProjectRoot ".env"
    if (Test-Path $envFile) {
        $match = Select-String -Path $envFile -Pattern '^HUB_API_KEY=(.+)$' | Select-Object -First 1
        if ($match) {
            $ApiKey = $match.Matches[0].Groups[1].Value.Trim('"', "'")
        }
    }
}
if (-not $ApiKey) {
    Write-Err "HUB_API_KEY not set and no .env found. Export it or add to $ProjectRoot\.env"
    exit 1
}

# ── Validate engine CLI ────────────────────────────────────────────────────
$enginePath = Get-Command $Engine -ErrorAction SilentlyContinue
if (-not $enginePath) {
    Write-Err "$Engine CLI not found in PATH. Install it first."
    exit 1
}

# ── MCP JSON-RPC helper ────────────────────────────────────────────────────
function Invoke-McpCall {
    param(
        [string]$Tool,
        [hashtable]$Arguments
    )

    $body = @{
        jsonrpc = "2.0"
        id      = 1
        method  = "tools/call"
        params  = @{
            name      = $Tool
            arguments = $Arguments
        }
    } | ConvertTo-Json -Depth 10

    $headers = @{
        "Content-Type"  = "application/json"
        "Accept"        = "application/json, text/event-stream"
        "Authorization" = "Bearer $ApiKey"
    }

    try {
        $response = Invoke-RestMethod -Uri $McpUrl -Method Post -Headers $headers -Body $body -TimeoutSec 30
        return $response
    }
    catch {
        return @{ error = $_.Exception.Message }
    }
}

# ── Extract text from MCP response ─────────────────────────────────────────
function Get-McpText {
    param($Response)
    try {
        if ($Response.result -and $Response.result.content -and $Response.result.content.Count -gt 0) {
            return $Response.result.content[0].text
        }
    }
    catch {}
    return ""
}

# ── Execute a task ──────────────────────────────────────────────────────────
function Invoke-Task {
    param([string]$TaskText)

    Write-Log "Executing task with $Engine..."

    try {
        if ($Engine -eq "claude") {
            $output = & claude -p $TaskText --allowedTools "Bash,Read,Write,Edit" --max-turns 20 --output-format json 2>&1
        }
        elseif ($Engine -eq "codex") {
            $output = & codex exec $TaskText 2>&1
        }
        return @{ Success = $true; Output = $output }
    }
    catch {
        return @{ Success = $false; Output = $_.Exception.Message }
    }
}

# ── Report result back ─────────────────────────────────────────────────────
function Send-TaskResult {
    param(
        [string]$TaskId,
        [string]$Status,
        [string]$Summary
    )

    if ($TaskId) {
        Invoke-McpCall -Tool "cortex_task_update" -Arguments @{
            taskId  = $TaskId
            status  = $Status
            result  = $Summary
            agentId = $Name
        } | Out-Null
    }
}

# ── Main loop ──────────────────────────────────────────────────────────────
Write-Log "Starting daemon: agent=$Name engine=$Engine interval=${Interval}s mcp=$McpUrl"

$running = $true

while ($running) {
    # Poll for a task
    $response = Invoke-McpCall -Tool "cortex_task_pickup" -Arguments @{ agentId = $Name }

    # Check for errors
    if ($response.error) {
        Write-Err "API error: $($response.error) - will retry in ${Interval}s"
        Start-Sleep -Seconds $Interval
        if ($Once) { exit 1 }
        continue
    }

    $taskText = Get-McpText -Response $response

    if (-not $taskText -or $taskText -notmatch "(?i)task") {
        Write-Log "No tasks available. Sleeping ${Interval}s..."
        if ($Once) { exit 0 }
        Start-Sleep -Seconds $Interval
        continue
    }

    Write-Ok "Task found!"

    # Try to extract task ID
    $taskId = ""
    try {
        $parsed = $taskText | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($parsed.taskId) { $taskId = $parsed.taskId }
        elseif ($parsed.id) { $taskId = $parsed.id }
    }
    catch {}

    # Execute
    $result = Invoke-Task -TaskText $taskText

    if ($result.Success) {
        Write-Ok "Task completed successfully"
        Send-TaskResult -TaskId $taskId -Status "completed" -Summary "Task executed successfully by $Name"
    }
    else {
        Write-Err "Task execution failed"
        Send-TaskResult -TaskId $taskId -Status "failed" -Summary "Execution error on $Name"
    }

    if ($Once) { exit 0 }
    Start-Sleep -Seconds 2  # brief cooldown before next poll
}

Write-Log "Daemon stopped."
