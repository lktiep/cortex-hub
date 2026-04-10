# Cortex Session End Check (v4) — Auto-closes session on Stop if user didn't run /ce
$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (git rev-parse --show-toplevel 2>$null) -replace '/', '\' }
if (-not $ProjectDir) { $ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
$StartedFile = Join-Path $StateDir "session-started"
$EndedFile = Join-Path $StateDir "session-ended"
$SessionIdFile = Join-Path $StateDir "session-id"

if ((Test-Path $StartedFile) -and (-not (Test-Path $EndedFile))) {
    $SessionId = $null
    if (Test-Path $SessionIdFile) {
        $SessionId = (Get-Content $SessionIdFile -Raw -ErrorAction SilentlyContinue).Trim()
    }

    if ($SessionId -and $SessionId -ne "null") {
        # Determine API URL: env var > default localhost
        $ApiUrl = if ($env:CORTEX_HUB_API_URL) { $env:CORTEX_HUB_API_URL } else { "http://localhost:4000" }
        $Endpoint = "$ApiUrl/api/sessions/$SessionId/end"

        # Best-effort auto-close — don't fail the hook if API is unreachable
        try {
            $Body = '{"summary":"Session auto-closed by Stop hook (user did not run /ce)"}'
            Invoke-RestMethod -Uri $Endpoint -Method Post -ContentType 'application/json' -Body $Body -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
        } catch {}

        New-Item -ItemType File -Path $EndedFile -Force | Out-Null
        Write-Host "INFO: Session $SessionId auto-closed by Stop hook."
    } else {
        Write-Host "WARNING: cortex_session_end not called and no session ID found - session could not be auto-closed."
    }
}
exit 0
