$ProjectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { (git rev-parse --show-toplevel 2>$null) -replace '/', '\' }
if (-not $ProjectDir) { $ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$StateDir = Join-Path $ProjectDir ".cortex\.session-state"
if (-not (Test-Path $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir | Out-Null
}
New-Item -ItemType File -Path (Join-Path $StateDir "session-started") -Force | Out-Null
$ItemsToRemove = @("quality-gates-passed", "gate-build", "gate-typecheck", "gate-lint", "session-ended", "discovery-used", "session-id")
foreach ($Item in $ItemsToRemove) {
    $FilePath = Join-Path $StateDir $Item
    if (Test-Path $FilePath) { Remove-Item -Path $FilePath -Force -ErrorAction SilentlyContinue }
}
Write-Host "Run /cs to initialize Cortex session. Grep/Edit BLOCKED until cortex discovery tools used."
exit 0
