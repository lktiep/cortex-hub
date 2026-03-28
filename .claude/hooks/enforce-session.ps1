$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { "." }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
$StartedFile = Join-Path $StateDir "session-started"

if (Test-Path $StartedFile) {
    exit 0
}

$InputData = [Console]::In.ReadToEnd()
if (-not [string]::IsNullOrWhiteSpace($InputData)) {
    try {
        $json = $InputData | ConvertFrom-Json
        $ToolName = $json.tool_name
        
        if ($ToolName -match "^(Edit|Write|NotebookEdit)$") {
            [Console]::Error.WriteLine("BLOCKED: Call cortex_session_start before editing files. Session not started.")
            exit 2
        }
        
        if ($ToolName -eq "Bash") {
            $Command = $json.tool_input.command
            if ($Command -match "^(ls|cat|head|tail|pwd|which|echo|git (status|log|diff|branch|remote)|pnpm (build|typecheck|lint|test)|curl|python3 -m json)") {
                exit 0
            }
            if ($Command -match "(git (add|commit|push|reset)|rm |mv |cp |mkdir |touch |chmod |sed -i|> )") {
                [Console]::Error.WriteLine("BLOCKED: Call cortex_session_start before modifying files. Session not started.")
                exit 2
            }
            exit 0
        }
    } catch {
        # Formatting error, proceed
    }
}

exit 0
