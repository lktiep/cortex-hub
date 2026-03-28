$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { "." }
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

        if ($Command -match "pnpm build") { New-Item -ItemType File -Path (Join-Path $StateDir "gate-build") -Force | Out-Null }
        if ($Command -match "pnpm typecheck") { New-Item -ItemType File -Path (Join-Path $StateDir "gate-typecheck") -Force | Out-Null }
        if ($Command -match "pnpm lint") { New-Item -ItemType File -Path (Join-Path $StateDir "gate-lint") -Force | Out-Null }

        if ((Test-Path (Join-Path $StateDir "gate-build")) -and (Test-Path (Join-Path $StateDir "gate-typecheck")) -and (Test-Path (Join-Path $StateDir "gate-lint"))) {
            New-Item -ItemType File -Path (Join-Path $StateDir "quality-gates-passed") -Force | Out-Null
        }

        if ($ToolName -match "cortex_session_start") { New-Item -ItemType File -Path (Join-Path $StateDir "session-started") -Force | Out-Null }
        if ($ToolName -match "cortex_session_end") { New-Item -ItemType File -Path (Join-Path $StateDir "session-ended") -Force | Out-Null }
    } catch {
        # ignore parse errors
    }
}
exit 0
