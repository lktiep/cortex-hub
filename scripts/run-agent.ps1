# Cortex Hub worker bootstrap: downloads the TypeScript worker from the hub and runs it.
# Usage: irm https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1 -OutFile run-agent.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File .\run-agent.ps1 start --hub https://<your-mcp-host>
$ErrorActionPreference = 'Stop'
function Die($m) { [Console]::Error.WriteLine("[cortex] $m"); exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git not found; install git: https://git-scm.com/downloads' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'node 20+ not found; install Node.js 20 or newer: https://nodejs.org' }
& node -e 'process.exit(+process.versions.node.split(String.fromCharCode(46))[0] >= 20 ? 0 : 1)'
if ($LASTEXITCODE -ne 0) { Die 'node 20+ not found; install Node.js 20 or newer: https://nodejs.org' }
$HomeDir = if ($env:CORTEX_WORKER_HOME) { $env:CORTEX_WORKER_HOME } else { Join-Path $HOME '.cortex\worker' }
$W = Join-Path $HomeDir 'cortex-worker.mjs'; $Hub = ''; $prev = ''
foreach ($a in $args) {
  if ($a -like '--hub=*') { $Hub = $a.Substring(6) } elseif ($prev -eq '--hub') { $Hub = $a }
  $prev = $a
}
if (-not $Hub) { $Hub = $env:CORTEX_HUB_URL }
if (-not $Hub -and (Test-Path $W)) { try { $out = & node $W hub-url 2>$null; if ($LASTEXITCODE -eq 0) { $Hub = "$out".Trim() } } catch { $Hub = '' } }
if (-not $Hub) { Die 'no hub URL; pass --hub https://<your-mcp-host>' }
$Hub = ($Hub.Trim() -replace '/+$', '') -replace '/mcp$', '' -replace '/+$', ''
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
$js = 'const [url, out] = process.argv.slice(1); fetch(url, { signal: AbortSignal.timeout(60000) }).then(async (r) => { if (r.status === 404) process.exit(44); if (!r.ok) { console.error(''HTTP '' + r.status); process.exit(1); } const body = await r.text(); if (!body.startsWith(''#!/usr/bin/env node'')) { console.error(''unexpected response body''); process.exit(1); } require(''node:fs'').writeFileSync(out, body); }).catch((e) => { const c = e && e.cause; console.error(e && e.name === ''TimeoutError'' ? ''timed out'' : String(c && (c.code || (c.errors && c.errors[0] && c.errors[0].code) || c.message) || e)); process.exit(1); });'
& node -e $js "$Hub/conductor/worker.mjs" "$W.tmp.$PID"
$rc = $LASTEXITCODE
if ($rc -eq 44) { Remove-Item -Force -ErrorAction SilentlyContinue "$W.tmp.$PID"; Die 'this hub does not serve the worker yet - upgrade the hub' }
if ($rc -ne 0) {
  Remove-Item -Force -ErrorAction SilentlyContinue "$W.tmp.$PID"
  if (-not (Test-Path $W)) { Die "could not download the worker from $Hub" }
  Write-Warning 'download failed; using cached worker'
} else { Move-Item -Force "$W.tmp.$PID" $W }
# The cw command: `cw ls`, `cw logs 2 -f`, `cw restart --all` instead of `node <path> ...`.
# It is only ever a small wrapper around this worker, so a cw.cmd that is not ours stays as it is.
function Install-Cw {
  $bin = Join-Path $HOME '.local\bin'
  $cw = Join-Path $bin 'cw.cmd'
  $w = (Resolve-Path -LiteralPath $W).ProviderPath
  if ((Test-Path -LiteralPath $cw) -and -not (Select-String -LiteralPath $cw -SimpleMatch 'cortex-worker.mjs' -Quiet)) {
    [Console]::Error.WriteLine("[cortex] $cw is not the Cortex one, so it stays; run the worker with: node `"$w`""); return
  }
  # cmd reads the file in the console code page: keep it ASCII by naming the profile folder by its variable
  $target = $w -replace '%', '%%'
  $profileDir = $env:USERPROFILE.TrimEnd('\')
  if ($profileDir -and $w.StartsWith("$profileDir\", [StringComparison]::OrdinalIgnoreCase)) {
    $target = '%USERPROFILE%' + ($w.Substring($profileDir.Length) -replace '%', '%%')
  }
  $body = "@echo off`r`nrem cw: shortcut for the Cortex worker (written by run-agent.ps1)`r`nnode `"$target`" %*`r`nexit /b %errorlevel%`r`n"
  $old = if (Test-Path -LiteralPath $cw) { [IO.File]::ReadAllText($cw) } else { $null }
  if ($old -ne $body) {
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $tmp = "$cw.tmp.$PID"
    [IO.File]::WriteAllText($tmp, $body, [Text.Encoding]::ASCII)
    Move-Item -Force -LiteralPath $tmp -Destination $cw
    [Console]::Error.WriteLine("[cortex] installed the cw command ($cw); try: cw ls")
  }
  # The user PATH, raw so that entries like %USERPROFILE%\bin stay as they are
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = @($raw -split ';' | Where-Object { $_ })
    $have = @($parts | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
    if ($have -notcontains $bin.TrimEnd('\')) {
      $key.SetValue('Path', (($parts + $bin) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
      # setting any user variable tells Explorer and new terminals that PATH changed
      [Environment]::SetEnvironmentVariable('CORTEX_PATH_REFRESH', $null, 'User')
      [Console]::Error.WriteLine("[cortex] added $bin to your PATH; cw works in a new terminal")
    }
  } finally { $key.Close() }
  $found = Get-Command cw -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found -and $found.Source -and $found.Source -ne $cw) {
    [Console]::Error.WriteLine("[cortex] another cw comes first on PATH ($($found.Source)); run this one as $cw")
  }
}
if ($env:CORTEX_SKIP_CW -ne '1') {
  try { Install-Cw } catch { Write-Warning "could not install the cw command ($($_.Exception.Message)); run the worker with: node `"$W`"" }
}
& node $W @args; exit $LASTEXITCODE
