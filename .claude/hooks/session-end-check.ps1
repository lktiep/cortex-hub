$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { "." }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
$StartedFile = Join-Path $StateDir "session-started"
$EndedFile = Join-Path $StateDir "session-ended"

if ((Test-Path $StartedFile) -and (-not (Test-Path $EndedFile))) {
    Write-Host "WARNING: cortex_session_end has not been called. Call it with sessionId and summary before ending."
}
exit 0
