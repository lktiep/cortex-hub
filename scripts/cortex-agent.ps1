# ============================================================
# cortex-agent.ps1 -- Cortex Hub WebSocket Agent Client
# Windows PowerShell equivalent of cortex-agent.sh.
# Connects to Hub conductor via WebSocket using Node.js ws
# package, receives task assignments, and spawns AI engines.
# ============================================================

param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "status", "logs", "help")]
    [string]$Command = "help",

    [switch]$Daemon,

    [Alias("d")]
    [switch]$Background,

    [int]$LogLines = 50
)

Write-Warning "cortex-agent.ps1 is deprecated; use run-agent.ps1 (TypeScript worker): irm https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1 -OutFile run-agent.ps1; .\run-agent.ps1 start --hub <url>"

$ErrorActionPreference = "Stop"

# -- Constants ------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

$DefaultHubUrl = "ws://localhost:4000/ws/conductor"
$IdentityFile = Join-Path (Join-Path $ProjectRoot ".cortex") "agent-identity.json"
$PidFile = if ($env:CORTEX_AGENT_PID_FILE) { $env:CORTEX_AGENT_PID_FILE } else { Join-Path $env:TEMP "cortex-agent.pid" }
$LogDir = if ($env:CORTEX_AGENT_LOG_DIR) { $env:CORTEX_AGENT_LOG_DIR } else { Join-Path $env:TEMP "cortex-agent-logs" }
$LogFile = Join-Path $LogDir "cortex-agent.log"
$MaxLogSize = 10MB
$MaxLogFiles = 5
$DebugMode = $env:CORTEX_AGENT_DEBUG -eq "1"

# -- Logging --------------------------------------------------
function Write-AgentLog {
    param(
        [string]$Level,
        [string]$Message
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"

    # Append to log file
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
        Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
    }
    catch { }

    # Console output with color
    switch ($Level) {
        "ERROR" { Write-Host $line -ForegroundColor Red }
        "WARN"  { Write-Host $line -ForegroundColor Yellow }
        "INFO"  { Write-Host $line -ForegroundColor Green }
        "DEBUG" { if ($DebugMode) { Write-Host $line -ForegroundColor Cyan } }
    }
}

# -- Log Rotation ---------------------------------------------
function Invoke-LogRotation {
    if (Test-Path $LogFile) {
        $size = (Get-Item $LogFile).Length
        if ($size -gt $MaxLogSize) {
            for ($i = $MaxLogFiles; $i -gt 1; $i--) {
                $prev = $i - 1
                $src = "$LogFile.$prev"
                $dst = "$LogFile.$i"
                if (Test-Path $src) { Move-Item -Path $src -Destination $dst -Force }
            }
            Move-Item -Path $LogFile -Destination "$LogFile.1" -Force
            Write-AgentLog "INFO" "Log rotated (exceeded $MaxLogSize bytes)"
        }
    }
}

# -- Dependency Check -----------------------------------------
function Test-Dependencies {
    $missing = @()

    if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
        $missing += "node"
    }

    # Check ws package availability
    $wsCheck = & node -e "try{require('ws');process.exit(0)}catch{try{require('$($ProjectRoot -replace '\\','/')/node_modules/ws');process.exit(0)}catch{process.exit(1)}}" 2>$null
    if ($LASTEXITCODE -ne 0) {
        $missing += "ws (npm package)"
    }

    if ($missing.Count -gt 0) {
        Write-AgentLog "ERROR" "Missing dependencies: $($missing -join ', ')"
        Write-AgentLog "ERROR" "Install with: npm install -g ws (or run pnpm install in project root)"
        exit 1
    }
}

# -- Identity -------------------------------------------------
$script:AgentId = ""
$script:AgentHostname = ""
$script:AgentOs = ""
$script:AgentIde = ""
$script:AgentRole = ""
$script:AgentCapabilities = '["claude"]'

function Read-AgentIdentity {
    if (Test-Path $IdentityFile) {
        try {
            $identity = Get-Content $IdentityFile -Raw | ConvertFrom-Json
            $script:AgentId = if ($identity.agentId) { $identity.agentId } elseif ($identity.id) { $identity.id } else { "unknown" }
            $script:AgentHostname = if ($identity.hostname) { $identity.hostname } else { $env:COMPUTERNAME }
            $script:AgentOs = if ($identity.os) { $identity.os } else { "Windows" }
            $script:AgentIde = if ($identity.ide) { $identity.ide } else { "cli" }
            $script:AgentRole = if ($identity.role) { $identity.role } else { "worker" }
            if ($identity.capabilities) {
                $script:AgentCapabilities = ($identity.capabilities | ConvertTo-Json -Compress)
            }
            Write-AgentLog "INFO" "Loaded identity from $IdentityFile (agentId=$($script:AgentId))"
        }
        catch {
            Write-AgentLog "WARN" "Failed to parse identity file: $_"
            Set-DefaultIdentity
        }
    }
    else {
        Set-DefaultIdentity
    }
}

function Set-DefaultIdentity {
    $script:AgentId = if ($env:CORTEX_AGENT_ID) { $env:CORTEX_AGENT_ID } else { "cortex-agent-$env:COMPUTERNAME" }
    $script:AgentHostname = $env:COMPUTERNAME
    $script:AgentOs = "Windows"
    $script:AgentIde = "cli"
    $script:AgentRole = "worker"
    $script:AgentCapabilities = '["claude"]'
    Write-AgentLog "WARN" "No identity file at $IdentityFile; using defaults (agentId=$($script:AgentId))"
}

# -- PID Management -------------------------------------------
function Write-PidFile {
    param([int]$Pid)
    Set-Content -Path $PidFile -Value $Pid
    Write-AgentLog "DEBUG" "PID $Pid written to $PidFile"
}

function Read-PidFile {
    if (Test-Path $PidFile) {
        return (Get-Content $PidFile -Raw).Trim()
    }
    return ""
}

function Test-AgentRunning {
    $pid = Read-PidFile
    if ($pid -and $pid -ne "") {
        try {
            $proc = Get-Process -Id ([int]$pid) -ErrorAction SilentlyContinue
            if ($proc -and -not $proc.HasExited) { return $true }
        }
        catch { }
    }
    return $false
}

function Remove-PidFile {
    Remove-Item -Path $PidFile -ErrorAction SilentlyContinue
}

# -- Task Execution Engines -----------------------------------
function Invoke-TaskClaude {
    param([string]$TaskId, [string]$Prompt, [string]$WorkingDir)
    Write-AgentLog "INFO" "Spawning Claude for task $TaskId"
    $outputFile = Join-Path $LogDir "task-$TaskId.log"

    if (Get-Command "claude" -ErrorAction SilentlyContinue) {
        Push-Location $WorkingDir
        try {
            & claude -p $Prompt --permission-mode accept 2>&1 | Tee-Object -FilePath $outputFile
            $exitCode = $LASTEXITCODE
        }
        finally { Pop-Location }
        Write-AgentLog "INFO" "Claude finished task $TaskId (exit=$exitCode)"
        return $exitCode
    }
    else {
        Write-AgentLog "ERROR" "Claude CLI not found"
        return 1
    }
}

function Invoke-TaskCodex {
    param([string]$TaskId, [string]$Prompt, [string]$WorkingDir)
    Write-AgentLog "INFO" "Spawning Codex for task $TaskId"
    $outputFile = Join-Path $LogDir "task-$TaskId.log"

    if (Get-Command "codex" -ErrorAction SilentlyContinue) {
        Push-Location $WorkingDir
        try {
            & codex exec $Prompt 2>&1 | Tee-Object -FilePath $outputFile
            $exitCode = $LASTEXITCODE
        }
        finally { Pop-Location }
        Write-AgentLog "INFO" "Codex finished task $TaskId (exit=$exitCode)"
        return $exitCode
    }
    else {
        Write-AgentLog "ERROR" "Codex CLI not found"
        return 1
    }
}

function Invoke-TaskGemini {
    param([string]$TaskId, [string]$Prompt, [string]$WorkingDir)
    Write-AgentLog "INFO" "Spawning Gemini for task $TaskId"
    $outputFile = Join-Path $LogDir "task-$TaskId.log"

    if (Get-Command "gemini" -ErrorAction SilentlyContinue) {
        Push-Location $WorkingDir
        try {
            $Prompt | & gemini 2>&1 | Tee-Object -FilePath $outputFile
            $exitCode = $LASTEXITCODE
        }
        finally { Pop-Location }
        Write-AgentLog "INFO" "Gemini finished task $TaskId (exit=$exitCode)"
        return $exitCode
    }
    else {
        Write-AgentLog "ERROR" "Gemini CLI not found"
        return 1
    }
}

function Invoke-Task {
    param([string]$TaskId, [string]$Engine, [string]$Prompt, [string]$WorkingDir)
    if (-not $WorkingDir) { $WorkingDir = $ProjectRoot }

    switch ($Engine) {
        "claude"  { return Invoke-TaskClaude -TaskId $TaskId -Prompt $Prompt -WorkingDir $WorkingDir }
        "codex"   { return Invoke-TaskCodex -TaskId $TaskId -Prompt $Prompt -WorkingDir $WorkingDir }
        "gemini"  { return Invoke-TaskGemini -TaskId $TaskId -Prompt $Prompt -WorkingDir $WorkingDir }
        default {
            Write-AgentLog "ERROR" "Unknown engine: $Engine (falling back to claude)"
            return Invoke-TaskClaude -TaskId $TaskId -Prompt $Prompt -WorkingDir $WorkingDir
        }
    }
}

# -- Node.js WebSocket Client Script -------------------------
function Get-WsClientScript {
    return @'
const WebSocket = require('ws');

const HUB_URL = process.env.CORTEX_HUB_WS_URL;
const AGENT_ID = process.env.CORTEX_AGENT_ID;
const AGENT_HOSTNAME = process.env.CORTEX_AGENT_HOSTNAME;
const AGENT_OS = process.env.CORTEX_AGENT_OS;
const AGENT_IDE = process.env.CORTEX_AGENT_IDE;
const AGENT_ROLE = process.env.CORTEX_AGENT_ROLE;
const AGENT_CAPABILITIES = JSON.parse(process.env.CORTEX_AGENT_CAPABILITIES || '["claude"]');

let ws = null;
let reconnectAttempt = 0;
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 120000;
let reconnectTimer = null;
let pingInterval = null;

function emit(type, data) {
  const line = JSON.stringify({ type, ...data });
  process.stdout.write(line + '\n');
}

function connect() {
  if (ws) {
    try { ws.terminate(); } catch (_) {}
  }

  emit('status', { message: `Connecting to ${HUB_URL}...` });
  ws = new WebSocket(HUB_URL);

  ws.on('open', () => {
    reconnectAttempt = 0;
    emit('status', { message: 'Connected to Hub conductor' });

    const registration = {
      type: 'agent.register',
      agentId: AGENT_ID,
      hostname: AGENT_HOSTNAME,
      os: AGENT_OS,
      ide: AGENT_IDE,
      role: AGENT_ROLE,
      capabilities: AGENT_CAPABILITIES,
      timestamp: new Date().toISOString()
    };
    ws.send(JSON.stringify(registration));
    emit('registered', { agentId: AGENT_ID });

    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      emit('message', { payload: msg });
    } catch (e) {
      emit('error', { message: `Invalid message: ${raw.toString().substring(0, 200)}` });
    }
  });

  ws.on('close', (code, reason) => {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    emit('disconnected', { code, reason: reason.toString() });
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    emit('error', { message: err.message });
  });

  ws.on('pong', () => {
    emit('pong', { timestamp: new Date().toISOString() });
  });
}

function scheduleReconnect() {
  reconnectAttempt++;
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempt - 1), RECONNECT_MAX);
  const jitter = Math.floor(Math.random() * 1000);
  emit('status', { message: `Reconnecting in ${Math.round((delay + jitter) / 1000)}s (attempt ${reconnectAttempt})...` });
  reconnectTimer = setTimeout(connect, delay + jitter);
}

function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

process.stdin.setEncoding('utf8');
let stdinBuffer = '';
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const cmd = JSON.parse(line);
      if (cmd.type === 'send') {
        sendMessage(cmd.payload);
      } else if (cmd.type === 'quit') {
        if (pingInterval) clearInterval(pingInterval);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (ws) ws.close(1000, 'Agent shutting down');
        process.exit(0);
      }
    } catch (e) {
      emit('error', { message: `Invalid stdin command: ${e.message}` });
    }
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

connect();
'@
}

# -- Main Agent Loop ------------------------------------------
function Start-AgentLoop {
    $hubUrl = if ($env:CORTEX_HUB_WS_URL) { $env:CORTEX_HUB_WS_URL } else { $DefaultHubUrl }
    $nodeResolvePaths = Join-Path $ProjectRoot "node_modules"

    Write-AgentLog "INFO" "Starting cortex-agent"
    Write-AgentLog "INFO" "Hub URL: $hubUrl"
    Write-AgentLog "INFO" "Agent ID: $($script:AgentId)"
    Write-AgentLog "INFO" "Capabilities: $($script:AgentCapabilities)"

    # Set environment for the Node.js child process
    $env:CORTEX_HUB_WS_URL = $hubUrl
    $env:CORTEX_AGENT_ID = $script:AgentId
    $env:CORTEX_AGENT_HOSTNAME = $script:AgentHostname
    $env:CORTEX_AGENT_OS = $script:AgentOs
    $env:CORTEX_AGENT_IDE = $script:AgentIde
    $env:CORTEX_AGENT_ROLE = $script:AgentRole
    $env:CORTEX_AGENT_CAPABILITIES = $script:AgentCapabilities
    $env:NODE_PATH = $nodeResolvePaths

    # Write the Node.js script to a temp file
    $wsScriptFile = Join-Path $env:TEMP "cortex-agent-ws-client.js"
    Get-WsClientScript | Set-Content -Path $wsScriptFile -Encoding UTF8

    # Start the Node.js WebSocket client process
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "node"
    $psi.Arguments = $wsScriptFile
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables["NODE_PATH"] = $nodeResolvePaths
    $psi.EnvironmentVariables["CORTEX_HUB_WS_URL"] = $hubUrl
    $psi.EnvironmentVariables["CORTEX_AGENT_ID"] = $script:AgentId
    $psi.EnvironmentVariables["CORTEX_AGENT_HOSTNAME"] = $script:AgentHostname
    $psi.EnvironmentVariables["CORTEX_AGENT_OS"] = $script:AgentOs
    $psi.EnvironmentVariables["CORTEX_AGENT_IDE"] = $script:AgentIde
    $psi.EnvironmentVariables["CORTEX_AGENT_ROLE"] = $script:AgentRole
    $psi.EnvironmentVariables["CORTEX_AGENT_CAPABILITIES"] = $script:AgentCapabilities

    $nodeProc = [System.Diagnostics.Process]::Start($psi)
    Write-PidFile -Pid $nodeProc.Id

    Write-AgentLog "INFO" "WebSocket client started (pid=$($nodeProc.Id))"

    # Handle Ctrl+C gracefully
    $null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
        try {
            $nodeProc.StandardInput.WriteLine('{"type":"quit"}')
            Start-Sleep -Seconds 1
            if (-not $nodeProc.HasExited) { $nodeProc.Kill() }
        }
        catch { }
        Remove-PidFile
    }

    try {
        # Read messages from Node.js process stdout
        while (-not $nodeProc.HasExited) {
            $line = $nodeProc.StandardOutput.ReadLine()
            if ($null -eq $line) { break }
            if ($line.Trim() -eq "") { continue }

            Write-AgentLog "DEBUG" "WS recv: $line"

            try {
                $msg = $line | ConvertFrom-Json
            }
            catch {
                Write-AgentLog "WARN" "Could not parse message: $line"
                continue
            }

            switch ($msg.type) {
                "status" {
                    Write-AgentLog "INFO" "status: $($msg.message)"
                }
                "registered" {
                    Write-AgentLog "INFO" "registered: $($msg.agentId)"
                }
                "pong" {
                    Write-AgentLog "DEBUG" "pong: $($msg.timestamp)"
                }
                "disconnected" {
                    Write-AgentLog "WARN" "Disconnected from Hub (will auto-reconnect)"
                }
                "error" {
                    Write-AgentLog "ERROR" "WS error: $($msg.message)"
                }
                "message" {
                    $payload = $msg.payload
                    $payloadType = $payload.type

                    Write-AgentLog "DEBUG" "Payload type: $payloadType"

                    switch ($payloadType) {
                        "task.assigned" {
                            $taskId = if ($payload.taskId) { $payload.taskId } elseif ($payload.task.id) { $payload.task.id } else { "" }
                            $engine = if ($payload.engine) { $payload.engine } elseif ($payload.task.engine) { $payload.task.engine } else { "claude" }
                            $prompt = if ($payload.prompt) { $payload.prompt } elseif ($payload.task.prompt) { $payload.task.prompt } elseif ($payload.task.description) { $payload.task.description } else { "" }
                            $workingDir = if ($payload.workingDir) { $payload.workingDir } elseif ($payload.task.workingDir) { $payload.task.workingDir } else { $ProjectRoot }

                            if (-not $taskId -or -not $prompt) {
                                Write-AgentLog "ERROR" "Invalid task.assigned: missing taskId or prompt"
                                continue
                            }

                            Write-AgentLog "INFO" "Task assigned: $taskId (engine=$engine)"

                            # Report task accepted
                            $acceptMsg = @{
                                type = "send"
                                payload = @{
                                    type = "task.accepted"
                                    taskId = $taskId
                                    agentId = $script:AgentId
                                    timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
                                }
                            } | ConvertTo-Json -Compress
                            $nodeProc.StandardInput.WriteLine($acceptMsg)

                            # Execute task in a background job
                            $jobParams = @{
                                TaskId     = $taskId
                                Engine     = $engine
                                Prompt     = $prompt
                                WorkingDir = $workingDir
                            }

                            Start-Job -ScriptBlock {
                                param($TaskId, $Engine, $Prompt, $WorkingDir, $ScriptPath)
                                # Re-dot-source the script is complex; inline execution
                                $exitCode = 0
                                try {
                                    switch ($Engine) {
                                        "claude" {
                                            Push-Location $WorkingDir
                                            & claude -p $Prompt --permission-mode accept 2>&1
                                            $exitCode = $LASTEXITCODE
                                            Pop-Location
                                        }
                                        "codex" {
                                            Push-Location $WorkingDir
                                            & codex exec $Prompt 2>&1
                                            $exitCode = $LASTEXITCODE
                                            Pop-Location
                                        }
                                        "gemini" {
                                            Push-Location $WorkingDir
                                            $Prompt | & gemini 2>&1
                                            $exitCode = $LASTEXITCODE
                                            Pop-Location
                                        }
                                        default {
                                            Push-Location $WorkingDir
                                            & claude -p $Prompt --permission-mode accept 2>&1
                                            $exitCode = $LASTEXITCODE
                                            Pop-Location
                                        }
                                    }
                                }
                                catch { $exitCode = 1 }
                                return @{ exitCode = $exitCode; taskId = $TaskId }
                            } -ArgumentList $jobParams.TaskId, $jobParams.Engine, $jobParams.Prompt, $jobParams.WorkingDir, $MyInvocation.MyCommand.Path | Out-Null

                            # Check completed jobs periodically and report results
                            $completedJobs = Get-Job -State Completed
                            foreach ($job in $completedJobs) {
                                $result = Receive-Job -Job $job
                                $status = if ($result.exitCode -eq 0) { "completed" } else { "failed" }

                                $completeMsg = @{
                                    type = "send"
                                    payload = @{
                                        type = "task.complete"
                                        taskId = $result.taskId
                                        agentId = $script:AgentId
                                        status = $status
                                        exitCode = $result.exitCode
                                        timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
                                    }
                                } | ConvertTo-Json -Compress
                                $nodeProc.StandardInput.WriteLine($completeMsg)

                                Write-AgentLog "INFO" "Task $($result.taskId) $status (exit=$($result.exitCode))"
                                Remove-Job -Job $job
                            }
                        }

                        "agent.registered" {
                            Write-AgentLog "INFO" "Server confirmed registration"
                        }

                        { $_ -in "heartbeat", "ping" } {
                            $pongMsg = @{
                                type = "send"
                                payload = @{
                                    type = "pong"
                                    agentId = $script:AgentId
                                    timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
                                }
                            } | ConvertTo-Json -Compress
                            $nodeProc.StandardInput.WriteLine($pongMsg)
                        }

                        default {
                            Write-AgentLog "DEBUG" "Unhandled message type: $payloadType"
                        }
                    }
                }
                default {
                    Write-AgentLog "DEBUG" "Unknown event type: $($msg.type)"
                }
            }
        }
    }
    catch {
        Write-AgentLog "ERROR" "Agent loop error: $_"
    }
    finally {
        # Cleanup
        try {
            if (-not $nodeProc.HasExited) {
                $nodeProc.StandardInput.WriteLine('{"type":"quit"}')
                Start-Sleep -Seconds 2
                if (-not $nodeProc.HasExited) { $nodeProc.Kill() }
            }
        }
        catch { }

        Remove-PidFile
        Remove-Item -Path $wsScriptFile -ErrorAction SilentlyContinue

        # Clean up background jobs
        Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue

        Write-AgentLog "INFO" "Agent stopped"
    }
}

# -- Commands -------------------------------------------------
function Start-Agent {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    Invoke-LogRotation
    Test-Dependencies
    Read-AgentIdentity

    if (Test-AgentRunning) {
        $pid = Read-PidFile
        Write-AgentLog "WARN" "Agent is already running (pid=$pid)"
        Write-Host "Agent is already running (pid=$pid). Use 'stop' first." -ForegroundColor Yellow
        exit 1
    }

    if ($Daemon -or $Background) {
        Write-AgentLog "INFO" "Starting agent in background mode..."
        $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" start"
        $proc = Start-Process powershell -ArgumentList $argList -WindowStyle Hidden -PassThru
        Write-PidFile -Pid $proc.Id
        Write-Host "Agent started in background (pid=$($proc.Id))" -ForegroundColor Green
        Write-Host "Logs: Get-Content -Wait '$LogFile'" -ForegroundColor Blue
    }
    else {
        Write-PidFile -Pid $PID
        Start-AgentLoop
    }
}

function Stop-Agent {
    if (-not (Test-AgentRunning)) {
        Write-Host "Agent is not running." -ForegroundColor Yellow
        exit 0
    }

    $pid = Read-PidFile
    Write-AgentLog "INFO" "Stopping agent (pid=$pid)..."

    try {
        $proc = Get-Process -Id ([int]$pid) -ErrorAction SilentlyContinue
        if ($proc) {
            $proc.Kill()
            $proc.WaitForExit(10000)
        }
    }
    catch { }

    Remove-PidFile
    Write-Host "Agent stopped." -ForegroundColor Green
}

function Show-AgentStatus {
    if (Test-AgentRunning) {
        $pid = Read-PidFile
        Write-Host "Agent is running (pid=$pid)" -ForegroundColor Green
        Write-Host "Log file: $LogFile" -ForegroundColor Blue
        Write-Host "PID file: $PidFile" -ForegroundColor Blue

        if (Test-Path $LogFile) {
            Write-Host ""
            Write-Host "Last 10 log lines:" -ForegroundColor Cyan
            Get-Content $LogFile -Tail 10
        }
        exit 0
    }
    else {
        Write-Host "Agent is not running." -ForegroundColor Yellow
        exit 1
    }
}

function Show-AgentLogs {
    if (Test-Path $LogFile) {
        Get-Content $LogFile -Tail $LogLines
    }
    else {
        Write-Host "No log file found at $LogFile" -ForegroundColor Yellow
    }
}

function Show-AgentHelp {
    $help = @"
cortex-agent.ps1 -- Cortex Hub WebSocket Agent Client

Usage:
  .\cortex-agent.ps1 start [-Daemon|-Background]  Start the agent
  .\cortex-agent.ps1 stop                          Stop the running agent
  .\cortex-agent.ps1 status                        Show agent status and recent logs
  .\cortex-agent.ps1 logs [-LogLines N]            Show last N log lines (default: 50)
  .\cortex-agent.ps1 help                          Show this help message

Environment Variables:
  CORTEX_HUB_WS_URL         Hub WebSocket URL (default: $DefaultHubUrl)
  CORTEX_AGENT_ID            Override agent ID
  CORTEX_AGENT_PID_FILE      Custom PID file location
  CORTEX_AGENT_LOG_DIR       Custom log directory
  CORTEX_AGENT_DEBUG         Set to 1 for debug logging

Agent Identity:
  Place a JSON file at: $IdentityFile
  Fields: agentId, hostname, os, ide, role, capabilities

Examples:
  .\cortex-agent.ps1 start                    # Interactive mode (foreground)
  .\cortex-agent.ps1 start -Daemon            # Background mode
  `$env:CORTEX_HUB_WS_URL="ws://hub:4000/ws/conductor"; .\cortex-agent.ps1 start
"@
    Write-Host $help
}

# -- Entry Point ----------------------------------------------
switch ($Command) {
    "start"  { Start-Agent }
    "stop"   { Stop-Agent }
    "status" { Show-AgentStatus }
    "logs"   { Show-AgentLogs }
    "help"   { Show-AgentHelp }
    default  { Show-AgentHelp }
}
