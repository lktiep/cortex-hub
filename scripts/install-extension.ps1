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
$ExtId = 'cortex-hub.cortex-agent'
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

# Runs an editor's command line and returns its exit code and output, stdout and stderr together.
# Editors print warnings on stderr even when the call works: Antigravity IDE prints
# "extensionManagementService depends on antigravityAnalytics which is NOT registered" on every
# call. Under 'Stop', Windows PowerShell 5.1 turns a redirected stderr line into a terminating
# error, so the call runs with 'Continue' and is judged by its exit code.
function Invoke-Cli([string]$Cli, [string[]]$Argv) {
  $ErrorActionPreference = 'Continue'
  $lines = @(& $Cli @Argv 2>&1 | ForEach-Object { "$_" })
  return @{ Code = $LASTEXITCODE; Lines = $lines }
}

# The version inside the VSIX (extension/package.json), or $null when it cannot be read.
function Get-VsixVersion([string]$Path) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
      $entry = $zip.GetEntry('extension/package.json')
      if (-not $entry) { return $null }
      $reader = New-Object IO.StreamReader($entry.Open())
      try { return ($reader.ReadToEnd() | ConvertFrom-Json).version } finally { $reader.Dispose() }
    } finally { $zip.Dispose() }
  } catch { return $null }
}

# The version of cortex-agent the editor lists, or $null.
function Get-InstalledVersion([string]$Cli) {
  $hit = (Invoke-Cli $Cli @('--list-extensions', '--show-versions')).Lines | Where-Object { $_ -like "$ExtId@*" } | Select-Object -First 1
  if ($hit) { return $hit.Substring($ExtId.Length + 1) }
  return $null
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("cortex-agent-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$Downloaded = $false
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
    $Downloaded = $true
  }
  if (-not (Test-Path -LiteralPath $Vsix)) { Die "no such file: $Vsix" }
  $Vsix = (Resolve-Path -LiteralPath $Vsix).Path
  $head = [IO.File]::ReadAllBytes($Vsix) | Select-Object -First 2
  if ($head.Count -lt 2 -or $head[0] -ne 0x50 -or $head[1] -ne 0x4B) { Die "$Vsix is not a VSIX (not a zip archive)" }
  $Expected = Get-VsixVersion $Vsix

  $installed = 0; $failed = @()
  foreach ($e in $Editors) {
    if ($Ide -ne 'all' -and $Ide -ne $e.Name) { continue }
    $cli = Find-Cli $e
    if (-not $cli) {
      if ($Ide -ne 'all') { Die "$($e.App) not found (no $($e.Cmd) on PATH). Install it by hand: Extensions view, ... menu, Install from VSIX..." }
      continue
    }
    Write-Host "[cortex] $($e.App): installing $ExtId$(if ($Expected) { "@$Expected" })"
    $r = Invoke-Cli $cli @('--install-extension', $Vsix, '--force')
    $version = Get-InstalledVersion $cli
    if ($version -and (-not $Expected -or $version -eq $Expected)) {
      Write-Host "[cortex] $($e.App): $ExtId@$version"
      $installed++
    } elseif ($r.Code -eq 0 -and -not $version) {
      Write-Host "[cortex] $($e.App): installed (the editor did not list its version)"
      $installed++
    } else {
      $why = if ($version) { "it still lists $ExtId@$version" } else { "the install exited with code $($r.Code)" }
      [Console]::Error.WriteLine("[cortex] $($e.App): install failed: $why")
      # The vendor warning above is printed on success too; leave it out of the failure.
      $r.Lines | Where-Object { $_ -and $_ -notmatch 'NOT registered' } | Select-Object -Last 5 | ForEach-Object { [Console]::Error.WriteLine("  $_") }
      $failed += $e.App
    }
  }
  if ($installed -eq 0 -and $failed.Count -eq 0) { Die 'no editor found; install Antigravity IDE, VS Code, Cursor or Windsurf, or pass -Ide' }
  if ($failed.Count -gt 0) {
    $keep = $Vsix
    if ($Downloaded) {
      # The download sits in a temp folder that is removed on exit: keep a copy to pick by hand.
      $dir = Join-Path $HOME 'Downloads'
      if (-not (Test-Path -LiteralPath $dir)) { $dir = $HOME }
      $keep = Join-Path $dir $(if ($Expected) { "cortex-agent-$Expected.vsix" } else { 'cortex-agent.vsix' })
      Copy-Item -LiteralPath $Vsix -Destination $keep -Force
    }
    Write-Host "[cortex] Install it by hand in $($failed -join ', '): open the Extensions view, click the ... menu, choose Install from VSIX..., and pick $keep"
    Die "install failed in $($failed -join ', ')"
  }
  Write-Host '[cortex] done. Reload each editor window (Developer: Reload Window), then open Cortex: Open Agent Panel.'
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
}
