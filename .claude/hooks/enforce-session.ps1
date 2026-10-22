$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (git rev-parse --show-toplevel 2>$null) -replace '/', '\' }
if (-not $ProjectDir) { $ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
$StartedFile = Join-Path $StateDir "session-started"
$DiscoveryFile = Join-Path $StateDir "discovery-used"

if (Test-Path $StartedFile) {
    # Session started — enforce discovery-first
    if (-not (Test-Path $DiscoveryFile)) {
        $InputData = [Console]::In.ReadToEnd()
        if (-not [string]::IsNullOrWhiteSpace($InputData)) {
            try {
                $json = $InputData | ConvertFrom-Json
                $ToolName = $json.tool_name
                $Command = $json.tool_input.command

                if ($ToolName -eq "Grep") {
                    [Console]::Error.WriteLine("BLOCKED: Use cortex_code_search or cortex_knowledge_search FIRST. Run /cs to auto-complete all steps.")
                    exit 2
                }
                if ($ToolName -eq "Bash" -and $Command -match "^(find |grep |rg |ag )") {
                    [Console]::Error.WriteLine("BLOCKED: Use cortex_code_search FIRST. Run /cs to auto-complete all steps.")
                    exit 2
                }
            } catch {}
        }
    }
    exit 0
}

# Session NOT started — block writes, allow reads
$InputData = [Console]::In.ReadToEnd()
if (-not [string]::IsNullOrWhiteSpace($InputData)) {
    try {
        $json = $InputData | ConvertFrom-Json
        $ToolName = $json.tool_name
        $Command = $json.tool_input.command

        if ($ToolName -match "^(Edit|Write|NotebookEdit)$") {
            [Console]::Error.WriteLine("BLOCKED: Call cortex_session_start first, with the task (task: '<the task in a few words>'). No edits without session.")
            exit 2
        }
        if ($ToolName -eq "Bash") {
            if ($Command -match "^(ls|cat|head|tail|pwd|which|echo|git (status|log|diff|branch|remote|show)|pnpm |npm |yarn |cargo |go |python|curl|dotnet |node )") {
                exit 0
            }
            if ($Command -match "(git (add|commit|push|reset)|rm |mv |cp |mkdir |touch |chmod |sed -i)") {
                [Console]::Error.WriteLine("BLOCKED: Call cortex_session_start first, with the task (task: '<the task in a few words>'). No file modifications without session.")
                exit 2
            }
        }
    } catch {}
}
exit 0
