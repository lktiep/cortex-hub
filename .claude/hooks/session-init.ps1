$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { "." }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
if (-not (Test-Path $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir | Out-Null
}
$ItemsToRemove = @(
    "session-started", "quality-gates-passed", "gate-build",
    "gate-typecheck", "gate-lint", "session-ended"
)
foreach ($Item in $ItemsToRemove) {
    $FilePath = Join-Path $StateDir $Item
    if (Test-Path $FilePath) {
        Remove-Item -Path $FilePath -Force -ErrorAction SilentlyContinue
    }
}
Write-Host "MANDATORY SESSION PROTOCOL — You MUST complete these steps NOW before any other work:"
Write-Host "1. Call cortex_session_start with repo, mode: `"development`", agentId: `"claude-code`""
Write-Host "2. If recentChanges.count > 0, warn user and run git pull"
Write-Host "3. Read STATE.md for current task progress"
Write-Host "DO NOT proceed with any code changes until step 1 is complete."
exit 0
