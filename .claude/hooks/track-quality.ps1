$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (git rev-parse --show-toplevel 2>$null) -replace '/', '\' }
if (-not $ProjectDir) { $ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
if (-not (Test-Path $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir | Out-Null
}

$InputData = [Console]::In.ReadToEnd()
if (-not [string]::IsNullOrWhiteSpace($InputData)) {
    try {
        $json = $InputData | ConvertFrom-Json
        $ToolName = $json.tool_name
        $Command = $json.tool_input.command

        # Track build gates
        if ($Command -match "(pnpm|npm|yarn) build")     { New-Item -ItemType File -Path (Join-Path $StateDir "gate-build") -Force | Out-Null }
        if ($Command -match "(pnpm|npm|yarn) typecheck")  { New-Item -ItemType File -Path (Join-Path $StateDir "gate-typecheck") -Force | Out-Null }
        if ($Command -match "(pnpm|npm|yarn) lint")       { New-Item -ItemType File -Path (Join-Path $StateDir "gate-lint") -Force | Out-Null }
        if ($Command -match "cargo build")                { New-Item -ItemType File -Path (Join-Path $StateDir "gate-build") -Force | Out-Null }
        if ($Command -match "cargo clippy")               { New-Item -ItemType File -Path (Join-Path $StateDir "gate-lint") -Force | Out-Null }
        if ($Command -match "go build")                   { New-Item -ItemType File -Path (Join-Path $StateDir "gate-build") -Force | Out-Null }
        if ($Command -match "go vet")                     { New-Item -ItemType File -Path (Join-Path $StateDir "gate-lint") -Force | Out-Null }
        if ($Command -match "dotnet build")               { New-Item -ItemType File -Path (Join-Path $StateDir "gate-build") -Force | Out-Null }

        # All gates passed?
        $hasBuild = Test-Path (Join-Path $StateDir "gate-build")
        $hasTypecheck = Test-Path (Join-Path $StateDir "gate-typecheck")
        $hasLint = Test-Path (Join-Path $StateDir "gate-lint")
        if ($hasBuild -and $hasTypecheck -and $hasLint) {
            New-Item -ItemType File -Path (Join-Path $StateDir "quality-gates-passed") -Force | Out-Null
        }
        # For projects without typecheck
        if ($hasBuild -and $hasLint -and -not $hasTypecheck) {
            $profilePath = Join-Path $ProjectDir ".cortex\project-profile.json"
            if (Test-Path $profilePath) {
                $hasTC = (Get-Content $profilePath -Raw) -match "typecheck"
                if (-not $hasTC) {
                    New-Item -ItemType File -Path (Join-Path $StateDir "quality-gates-passed") -Force | Out-Null
                }
            }
        }

        # Track MCP tool calls
        if ($ToolName -match "cortex_session_start") {
            New-Item -ItemType File -Path (Join-Path $StateDir "session-started") -Force | Out-Null
            # Extract session_id from tool output and save for auto-close on Stop hook
            try {
                $ToolOutput = $json.tool_output
                if ($ToolOutput) {
                    $OutputObj = $null
                    if ($ToolOutput -is [string]) {
                        $OutputObj = $ToolOutput | ConvertFrom-Json
                    } else {
                        $OutputObj = $ToolOutput
                    }
                    if ($OutputObj.session_id) {
                        Set-Content -Path (Join-Path $StateDir "session-id") -Value $OutputObj.session_id -NoNewline
                    }
                }
            } catch {}
        }
        if ($ToolName -match "cortex_session_end")    { New-Item -ItemType File -Path (Join-Path $StateDir "session-ended") -Force | Out-Null }
        if ($ToolName -match "cortex_quality_report") { New-Item -ItemType File -Path (Join-Path $StateDir "quality-gates-passed") -Force | Out-Null }

        # Track cortex discovery tool usage
        if ($ToolName -match "cortex_(code_search|knowledge_search|memory_search|code_context|code_impact|cypher)") {
            New-Item -ItemType File -Path (Join-Path $StateDir "discovery-used") -Force | Out-Null
        }
    } catch {}
}
exit 0
