$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { "." }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"

$InputData = [Console]::In.ReadToEnd()
if (-not [string]::IsNullOrWhiteSpace($InputData)) {
    try {
        $json = $InputData | ConvertFrom-Json
        $Command = $json.tool_input.command
        
        if ($Command -notmatch "^git (commit|push)") {
            exit 0
        }
        
        if ($Command -match "^git commit") {
            $GatesPassed = Join-Path $StateDir "quality-gates-passed"
            if (-not (Test-Path $GatesPassed)) {
                [Console]::Error.WriteLine("Quality gates not passed. Run: pnpm build && pnpm typecheck && pnpm lint first, then call cortex_quality_report.")
                exit 2
            }
        }
        
        if ($Command -match "^git push") {
            [Console]::Error.WriteLine("REMINDER: After push, call cortex_code_reindex to update code intelligence.")
        }
    } catch {
    }
}
exit 0
