# Cortex Hub: installs the cortex-agent extension into Antigravity IDE, VS Code, Cursor and Windsurf.
# Downloads cortex-agent.vsix from the latest GitHub release and installs it into every editor whose
# command line it finds, replacing an older copy (same id, cortex-hub.cortex-agent).
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.ps1))) -Ide antigravity
#   .\install-extension.ps1 -Release v1.0.1          # the VSIX of one release instead of the latest
#   .\install-extension.ps1 -Vsix .\cortex-agent.vsix  # a VSIX you built (pnpm --filter cortex-agent package)
#
# Restart or reload the editor window afterwards (Developer: Reload Window).
param(
  [ValidateSet('all', 'antigravity', 'code', 'cursor', 'windsurf')][string]$Ide = 'all',
  [string]$Release = '',
  [string]$Vsix = ''
)
$ErrorActionPreference = 'Stop'
# throw, not exit: under `irm | iex` an exit would close the PowerShell window.
function Die($m) { throw "[cortex] $m" }

$Repo = 'lktiep/cortex-hub'
$Local = $env:LOCALAPPDATA; $Prog = $env:ProgramFiles

# The editor's command line: on PATH, else where its installer puts it.
$Editors = @(
  @{ Name = 'antigravity'; App = 'Antigravity IDE'; Cmd = 'antigravity-ide'; Paths = @("$Local\Programs\Antigravity IDE\bin\antigravity-ide.cmd", "$Local\Programs\Antigravity*\bin\antigravity-ide.cmd", "$Prog\Antigravity*\bin\antigravity-ide.cmd") },
  @{ Name = 'code'; App = 'Visual Studio Code'; Cmd = 'code'; Paths = @("$Local\Programs\Microsoft VS Code\bin\code.cmd", "$Prog\Microsoft VS Code\bin\code.cmd") },
  @{ Name = 'cursor'; App = 'Cursor'; Cmd = 'cursor'; Paths = @("$Local\Programs\cursor\resources\app\bin\cursor.cmd") },
  @{ Name = 'windsurf'; App = 'Windsurf'; Cmd = 'windsurf'; Paths = @("$Local\Programs\Windsurf\bin\windsurf.cmd") }
)
function Find-Cli($e) {
  $c = Get-Command "$($e.Cmd).cmd" -ErrorAction SilentlyContinue
  if (-not $c) { $c = Get-Command $e.Cmd -CommandType Application -ErrorAction SilentlyContinue }
  if ($c) { return @($c)[0].Source }
  foreach ($p in $e.Paths) {
    $hit = Get-ChildItem -Path $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("cortex-agent-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
  if (-not $Vsix) {
    if ($Release) {
      if (-not $Release.StartsWith('v')) { $Release = "v$Release" }
      $Url = "https://github.com/$Repo/releases/download/$Release/cortex-agent.vsix"
    } else {
      $Url = "https://github.com/$Repo/releases/latest/download/cortex-agent.vsix"
    }
    Write-Host "[cortex] downloading $Url"
    $Vsix = Join-Path $Tmp 'cortex-agent.vsix'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Vsix } catch { Die "download failed: $Url ($($_.Exception.Message))" }
  }
  if (-not (Test-Path -LiteralPath $Vsix)) { Die "no such file: $Vsix" }
  $Vsix = (Resolve-Path -LiteralPath $Vsix).Path
  $head = [IO.File]::ReadAllBytes($Vsix) | Select-Object -First 2
  if ($head.Count -lt 2 -or $head[0] -ne 0x50 -or $head[1] -ne 0x4B) { Die "$Vsix is not a VSIX (not a zip archive)" }

  $installed = 0
  foreach ($e in $Editors) {
    if ($Ide -ne 'all' -and $Ide -ne $e.Name) { continue }
    $cli = Find-Cli $e
    if (-not $cli) {
      if ($Ide -ne 'all') { Die "$($e.App) not found (no $($e.Cmd) on PATH)" }
      continue
    }
    Write-Host "[cortex] $($e.App): installing"
    & $cli --install-extension $Vsix --force | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $version = & $cli --list-extensions --show-versions 2>$null | Where-Object { $_ -like 'cortex-hub.cortex-agent@*' } | Select-Object -First 1
      if (-not $version) { $version = 'installed' }
      Write-Host "[cortex] $($e.App): $version"
      $installed++
    } else {
      [Console]::Error.WriteLine("[cortex] $($e.App): install failed")
    }
  }
  if ($installed -eq 0) { Die 'no editor found; install Antigravity IDE, VS Code, Cursor or Windsurf, or pass -Ide' }
  Write-Host '[cortex] done. Reload each editor window (Developer: Reload Window), then open Cortex: Open Agent Panel.'
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
}
