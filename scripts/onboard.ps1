# Cortex Hub — Windows Onboarding Script (PowerShell)
# Equivalent of onboard.sh for Windows users.
#
# Usage:
#   .\onboard.ps1                                   # Interactive (auto-detects tools)
#   .\onboard.ps1 -Tool cursor                      # Specific tool (skip detection)
#   .\onboard.ps1 -Tool bot                         # Headless bot mode
#   $env:HUB_API_KEY = "xxx"; .\onboard.ps1         # Non-interactive
#
# Requirements: PowerShell 5.1+ (ships with Windows 10+), Node.js 22+

[CmdletBinding()]
param(
    [string]$Tool = "",
    [string]$McpUrl = "",
    [string]$ApiKey = ""
)

$ErrorActionPreference = "Stop"

# ── Colors ──
function Write-Step { param([string]$msg) Write-Host ">>> $msg" -ForegroundColor Blue }
function Write-Ok   { param([string]$msg) Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$msg) Write-Host "    $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║          Cortex Hub — Windows Setup          ║" -ForegroundColor Cyan
Write-Host "║     Self-hosted AI Agent Intelligence        ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: MCP URL ──
Write-Step "Connecting to Cortex Hub..."

if ($McpUrl -eq "") {
    $defaultUrl = "https://cortex-mcp.jackle.dev/mcp"
    $input = Read-Host "Enter your Cortex Hub MCP URL [$defaultUrl]"
    $McpUrl = if ($input) { $input } else { $defaultUrl }
}
$McpUrl = $McpUrl.TrimEnd("/")

# ── Step 2: API Key ──
if ($ApiKey -eq "" -and $env:HUB_API_KEY) {
    $ApiKey = $env:HUB_API_KEY
}
if ($ApiKey -eq "") {
    $secureKey = Read-Host "Enter your Cortex Hub API Key" -AsSecureString
    $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    )
}

if (-not $ApiKey) {
    Write-Err "API Key is required. Set `$env:HUB_API_KEY or pass -ApiKey"
    exit 1
}

# ── Step 3: Test MCP Connection ──
Write-Step "Testing MCP connection..."

$headers = @{
    "Content-Type"  = "application/json"
    "Accept"        = "application/json, text/event-stream"
    "Authorization" = "Bearer $ApiKey"
}
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

try {
    $response = Invoke-WebRequest -Uri $McpUrl -Method POST -Headers $headers -Body $body -TimeoutSec 10 -UseBasicParsing
    if ($response.StatusCode -eq 200) {
        Write-Ok "MCP connection successful!"
        # Count tools
        try {
            $tools = ($response.Content | ConvertFrom-Json).result.tools
            $toolsCount = $tools.Count
            Write-Ok "Available tools: $toolsCount"
        } catch { }
    }
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 401) {
        Write-Err "Invalid API Key (401). Check your key and try again."
        exit 1
    } elseif ($null -eq $statusCode) {
        Write-Err "Cannot reach $McpUrl — check your network and URL."
        exit 1
    } else {
        Write-Warn "MCP responded with HTTP $statusCode — continuing anyway..."
    }
}

# ── Step 4: Tool Detection ──
Write-Host ""
Write-Step "Detecting installed AI tools..."

$detectedTools = @()

# Claude Code
if ((Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path "$env:USERPROFILE\.claude.json") -or (Test-Path "$env:USERPROFILE\.claude")) {
    $detectedTools += "claude"
    Write-Ok "Found: Claude Code"
}

# Cursor
if ((Test-Path "$env:USERPROFILE\.cursor") -or (Get-Command cursor -ErrorAction SilentlyContinue)) {
    $detectedTools += "cursor"
    Write-Ok "Found: Cursor"
}

# Windsurf
if ((Test-Path "$env:USERPROFILE\.codeium") -or (Get-Command windsurf -ErrorAction SilentlyContinue)) {
    $detectedTools += "windsurf"
    Write-Ok "Found: Windsurf"
}

# VS Code
if (Get-Command code -ErrorAction SilentlyContinue) {
    $detectedTools += "vscode"
    Write-Ok "Found: VS Code"
}

# Antigravity (Gemini)
if (Test-Path "$env:USERPROFILE\.gemini\antigravity") {
    $detectedTools += "antigravity"
    Write-Ok "Found: Antigravity (Gemini)"
}

if ($detectedTools.Count -eq 0) {
    Write-Warn "No AI tools auto-detected."
}

# ── Tool Selection ──
$selectedTools = @()
if ($Tool -ne "") {
    $selectedTools = $Tool -split ","
    Write-Step "Using specified tool(s): $Tool"
} else {
    Write-Host ''
    Write-Host 'Select which tools to configure:' -ForegroundColor Cyan
    $detectedStr = $detectedTools -join ', '
    Write-Host ('  1) All detected tools (' + $detectedStr + ')')
    Write-Host '  2) Claude Code'
    Write-Host '  3) Cursor'
    Write-Host '  4) Windsurf'
    Write-Host '  5) VS Code (Copilot)'
    Write-Host '  6) Antigravity (Gemini)'
    Write-Host '  7) Headless Bot'
    Write-Host '  8) All tools'
    Write-Host ''

    $choice = Read-Host "  Select option(s) [1-8, comma-separated]"
    $choices = $choice -split ","

    foreach ($c in $choices) {
        switch ($c.Trim()) {
            "1" { $selectedTools = $detectedTools }
            "2" { $selectedTools += "claude" }
            "3" { $selectedTools += "cursor" }
            "4" { $selectedTools += "windsurf" }
            "5" { $selectedTools += "vscode" }
            "6" { $selectedTools += "antigravity" }
            "7" { $selectedTools += "bot" }
            "8" { $selectedTools = @("claude", "cursor", "windsurf", "vscode", "antigravity") }
        }
    }
}

# ── Step 5: Inject MCP Config ──
function Set-McpConfig {
    param([string]$ToolKey, [string]$ConfigPath, [string]$ConfigKey, [string]$DisplayName)

    if ($ToolKey -eq "bot") {
        Write-Host ""
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
        Write-Host "  Bot / API Connection Details" -ForegroundColor Cyan
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  MCP Endpoint:  $McpUrl" -ForegroundColor Green
        Write-Host "  Auth Header:   Authorization: Bearer <API_KEY>" -ForegroundColor Green
        Write-Host ""
        return
    }

    Write-Step "Configuring $DisplayName..."

    # Ensure parent directory exists
    $dir = Split-Path -Parent $ConfigPath
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    # Create empty config if missing
    if (-not (Test-Path $ConfigPath)) {
        "{}" | Out-File -FilePath $ConfigPath -Encoding utf8
        Write-Ok "Created $ConfigPath"
    }

    # Read existing config
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

    # Ensure config key exists
    if (-not ($config.PSObject.Properties.Name -contains $ConfigKey)) {
        $config | Add-Member -NotePropertyName $ConfigKey -NotePropertyValue ([PSCustomObject]@{})
    }

    # Build MCP entry
    $mcpEntry = [PSCustomObject]@{
        command = "npx"
        args    = @("-y", "mcp-remote", $McpUrl, "--header", "Authorization: Bearer `${HUB_API_KEY}")
        env     = [PSCustomObject]@{
            HUB_API_KEY = $ApiKey
        }
    }

    # Add type for VS Code
    if ($ToolKey -eq "vscode") {
        $mcpEntry | Add-Member -NotePropertyName "type" -NotePropertyValue "stdio"
    }

    # Set the cortex-hub entry
    $config.$ConfigKey | Add-Member -NotePropertyName "cortex-hub" -NotePropertyValue $mcpEntry -Force

    # Write back
    $config | ConvertTo-Json -Depth 10 | Out-File -FilePath $ConfigPath -Encoding utf8
    Write-Ok "$DisplayName configured at $ConfigPath"
}

# Config path mapping
$configMap = @{
    claude      = @{ Path = "$env:USERPROFILE\.claude.json"; Key = "mcpServers"; Name = "Claude Code" }
    cursor      = @{ Path = "$env:USERPROFILE\.cursor\mcp.json"; Key = "mcpServers"; Name = "Cursor" }
    windsurf    = @{ Path = "$env:USERPROFILE\.codeium\windsurf\mcp_config.json"; Key = "mcpServers"; Name = "Windsurf" }
    vscode      = @{ Path = ".vscode\mcp.json"; Key = "servers"; Name = "VS Code (Copilot)" }
    antigravity = @{ Path = "$env:USERPROFILE\.gemini\antigravity\mcp_config.json"; Key = "mcpServers"; Name = "Antigravity (Gemini)" }
    bot         = @{ Path = ""; Key = ""; Name = "Headless Bot" }
}

foreach ($toolKey in $selectedTools) {
    if ($configMap.ContainsKey($toolKey)) {
        $cfg = $configMap[$toolKey]
        Set-McpConfig -ToolKey $toolKey -ConfigPath $cfg.Path -ConfigKey $cfg.Key -DisplayName $cfg.Name
    }
}

# ── Step 6: Detect Project Stack & Generate project-profile.json ──
Write-Host ""
Write-Step "Scanning project stack..."

$cortexDir = ".cortex"
$profilePath = "$cortexDir\project-profile.json"

if (-not (Test-Path $cortexDir)) {
    New-Item -ItemType Directory -Path $cortexDir -Force | Out-Null
}

if (-not (Test-Path $profilePath)) {
    $pkgManager = "unknown"
    $buildCmd = ""
    $typecheckCmd = ""
    $lintCmd = ""
    $testCmd = ""

    if (Test-Path "package.json") {
        $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
        $scripts = $pkg.scripts

        if (Test-Path "pnpm-lock.yaml") { $pkgManager = "pnpm" }
        elseif (Test-Path "yarn.lock") { $pkgManager = "yarn" }
        else { $pkgManager = "npm" }

        if ($scripts.PSObject.Properties.Name -contains "build") { $buildCmd = "$pkgManager build" }
        if ($scripts.PSObject.Properties.Name -contains "typecheck") { $typecheckCmd = "$pkgManager typecheck" }
        if ($scripts.PSObject.Properties.Name -contains "lint") { $lintCmd = "$pkgManager lint" }
        if ($scripts.PSObject.Properties.Name -contains "test") { $testCmd = "$pkgManager test" }
    }
    elseif (Test-Path "go.mod") {
        $pkgManager = "go"; $buildCmd = "go build ./..."; $lintCmd = "golangci-lint run"; $testCmd = "go test ./..."
    }
    elseif ((Get-ChildItem -Filter "*.csproj" -ErrorAction SilentlyContinue) -or (Get-ChildItem -Filter "*.sln" -ErrorAction SilentlyContinue)) {
        $pkgManager = "dotnet"; $buildCmd = "dotnet build"; $lintCmd = "dotnet format --check"; $testCmd = "dotnet test"
    }
    elseif (Test-Path "Cargo.toml") {
        $pkgManager = "cargo"; $buildCmd = "cargo build"; $lintCmd = "cargo clippy"; $testCmd = "cargo test"
    }
    elseif ((Test-Path "requirements.txt") -or (Test-Path "pyproject.toml")) {
        $pkgManager = "pip"; $lintCmd = "ruff check ."; $testCmd = "pytest"
    }

    Write-Ok "Detected: $pkgManager"

    $preCommit = @($buildCmd, $typecheckCmd, $lintCmd) | Where-Object { $_ -ne "" }
    $full = @($buildCmd, $typecheckCmd, $lintCmd, $testCmd) | Where-Object { $_ -ne "" }

    $profile = [PSCustomObject]@{
        schema_version = "1.0"
        project_name   = Split-Path -Leaf (Get-Location)
        fingerprint    = [PSCustomObject]@{
            package_manager = $pkgManager
            detected_at     = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        }
        verify         = [PSCustomObject]@{
            pre_commit  = $preCommit
            full        = $full
            auto_fix    = $true
            max_retries = 2
        }
    }
    $profile | ConvertTo-Json -Depth 5 | Out-File -FilePath $profilePath -Encoding utf8
    Write-Ok "Generated $profilePath"
} else {
    Write-Ok "Found existing $profilePath — skipping generation"
}

# ── Step 7: Generate Agent Rules ──
Write-Step "Generating agent rules..."

$agentRulesPath = ".cortex\agent-rules.md"
$gitRepoUrl = try { (git remote get-url origin 2>$null) } catch { "unknown" }

$agentRulesContent = @"
<!-- cortex-hub:agent-rules -->
## Cortex Hub — MCP Tool Usage Guidelines

### Session Protocol
1. **Start**: Call ``cortex_session_start`` with repo URL, agentId, mode
2. **During**: Use Cortex tools BEFORE grep/find (priority: memory → knowledge → code_search → code_impact)
3. **Before commit**: Run ``cortex_detect_changes`` for risk analysis
4. **End**: ``cortex_quality_report`` → ``cortex_memory_store`` → ``cortex_session_end``

### Tool Priority Order
1. ``cortex_memory_search`` → recall past decisions
2. ``cortex_knowledge_search`` → search shared knowledge
3. ``cortex_code_search`` → AST-aware code search
4. ``cortex_code_impact`` → blast radius before editing
5. ``cortex_detect_changes`` → pre-commit risk
6. ``cortex_cypher`` → graph queries
7. ``cortex_list_repos`` → find project IDs
8. ``grep_search`` / ``find_by_name`` → fallback only

### Bug Protocol (MANDATORY)
1. Search ``cortex_knowledge_search`` for the error first
2. Fix the error
3. If fix was non-obvious: ``cortex_knowledge_store`` to record it

### Available Tools: 17
| Tool | Purpose |
|------|---------|
| ``cortex_session_start`` | Start session, get context + unseen changes |
| ``cortex_session_end`` | Close session with summary |
| ``cortex_changes`` | Check for other agents' changes |
| ``cortex_code_search`` | AST-aware semantic code search |
| ``cortex_code_context`` | 360° symbol view (callers/callees/flows) |
| ``cortex_code_impact`` | Blast radius analysis |
| ``cortex_code_reindex`` | Re-index after push |
| ``cortex_list_repos`` | List indexed repos with project mapping |
| ``cortex_cypher`` | Direct Cypher graph queries |
| ``cortex_detect_changes`` | Pre-commit risk analysis |
| ``cortex_memory_search`` | Recall agent memories |
| ``cortex_memory_store`` | Store findings for next session |
| ``cortex_knowledge_search`` | Search shared knowledge base |
| ``cortex_knowledge_store`` | Contribute bug fixes & patterns |
| ``cortex_quality_report`` | Report build/typecheck/lint results |
| ``cortex_plan_quality`` | Assess plan quality before execution |
| ``cortex_health`` | Check backend service health |
<!-- cortex-hub:agent-rules -->
"@

$agentRulesContent | Out-File -FilePath $agentRulesPath -Encoding utf8
Write-Ok "Generated $agentRulesPath"

# ── Step 8: Generate IDE instruction files ──
$cortexMarker = "<!-- cortex-hub:auto-mcp -->"

function Set-InstructionFile {
    param([string]$FilePath, [string]$AgentId, [string]$Label)

    $instructions = @"

$cortexMarker
## Cortex Hub — Auto MCP (MANDATORY — every conversation)

At the START of every conversation:
1. Call ``cortex_session_start`` with repo: "$gitRepoUrl", agentId: "$AgentId", mode: "development"
2. If recentChanges.count > 0, warn user and run ``git pull``
3. Read ``STATE.md`` if it exists

### Error Protocol
1. ``cortex_knowledge_search`` first
2. Fix the error
3. Store non-obvious fixes: ``cortex_knowledge_store``

### Session End
``cortex_quality_report`` → ``cortex_memory_store`` → ``cortex_session_end``
$cortexMarker
"@

    if ((Test-Path $FilePath) -and (Get-Content $FilePath -Raw) -match [regex]::Escape($cortexMarker)) {
        Write-Ok "$Label already has Cortex instructions — skipping"
    } else {
        Add-Content -Path $FilePath -Value $instructions -Encoding utf8
        Write-Ok "$Label updated (agentId: $AgentId)"
    }
}

foreach ($toolKey in $selectedTools) {
    switch ($toolKey) {
        "claude"      { Set-InstructionFile "CLAUDE.md" "claude-code" "CLAUDE.md" }
        "cursor"      { Set-InstructionFile ".cursorrules" "cursor" ".cursorrules" }
        "windsurf"    { Set-InstructionFile ".windsurfrules" "windsurf" ".windsurfrules" }
        "vscode"      {
            if (-not (Test-Path ".vscode")) { New-Item -ItemType Directory -Path ".vscode" -Force | Out-Null }
            Set-InstructionFile ".vscode\copilot-instructions.md" "vscode-copilot" "copilot-instructions.md"
        }
        "antigravity" { Set-InstructionFile "GEMINI.md" "antigravity" "GEMINI.md" }
    }
}

# ── Step 9: Deploy Workflow Templates ──
Write-Step "Deploying workflow templates..."

$workflowDir = ".agents\workflows"
if (-not (Test-Path $workflowDir)) {
    New-Item -ItemType Directory -Path $workflowDir -Force | Out-Null
}

# Download templates from repo if available
$templatesUrl = "https://raw.githubusercontent.com/lktiep/cortex-hub/master/templates/workflows"
$workflows = @("code.md", "continue.md", "phase.md")

foreach ($wf in $workflows) {
    $wfPath = "$workflowDir\$wf"
    if (-not (Test-Path $wfPath)) {
        try {
            Invoke-WebRequest -Uri "$templatesUrl/$wf" -OutFile $wfPath -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
            Write-Ok "Downloaded $wf"
        } catch {
            Write-Warn "Could not download $wf — will be available after git pull"
        }
    } else {
        Write-Ok "$wf already exists"
    }
}

# ── Done ──
Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║         Cortex Hub Setup Complete! ✓         ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
$configuredStr = $selectedTools -join ', '
Write-Host "  Configured tools: $configuredStr" -ForegroundColor Cyan
Write-Host "  MCP endpoint:     $McpUrl" -ForegroundColor Cyan
Write-Host "  Profile:          $profilePath" -ForegroundColor Cyan
Write-Host "  Agent rules:      $agentRulesPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Yellow
Write-Host "    1. Restart your IDE to load MCP config" -ForegroundColor White
Write-Host "    2. Ask your agent: 'cortex_health' to verify" -ForegroundColor White
Write-Host "    3. Start working — Cortex will guide your agent" -ForegroundColor White
Write-Host ""
