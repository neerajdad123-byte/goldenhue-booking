# One command for every check, so "it passes" always means the same thing.
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
$fail = 0

Write-Host "== rules"
$rules = node outputs/demo/test-engine.js | Select-Object -Last 1
Write-Host "   $rules"
if ($LASTEXITCODE -ne 0) { $fail = 1 }

Write-Host "== wiring"
$wiring = node work/check-ui.js | Select-Object -Last 1
Write-Host "   $wiring"
if ($LASTEXITCODE -ne 0) { $fail = 1 }

Write-Host "== syntax"
foreach ($f in 'data.js', 'engine.js', 'app.js') {
  node --check "outputs/demo/$f"
  if ($LASTEXITCODE -ne 0) { $fail = 1 }
}
Write-Host "   data.js engine.js app.js all parse"

$cdp = $env:GOLDENHUE_CDP
if ($cdp) {
  if (-not $env:ADMIN_PASSWORD) { $env:ADMIN_PASSWORD = 'devpassword123' }
  Write-Host "== page, in a real browser"
  node work/errors.js $cdp | Select-Object -First 1
  $flown = node work/flow.js $cdp | Select-Object -Last 1
  Write-Host "   $flown"
  if ($LASTEXITCODE -ne 0) { $fail = 1 }
} else {
  Write-Host "== browser checks skipped (set GOLDENHUE_CDP to a debug port to run them)"
}

$api = $env:GOLDENHUE_API
if ($api) {
  Write-Host "== the HTTP API"
  $apires = node work/api-test.js $api | Select-Object -Last 1
  Write-Host "   $apires"
  if ($LASTEXITCODE -ne 0) { $fail = 1 }

  if ($cdp) {
    Write-Host "== the served site, end to end"
    # Its own browser, so tabs left over from the offline run cannot starve it:
    # a browser allows only a handful of connections per host.
    $pf = $env:ProgramFiles
    $pf86 = [Environment]::GetFolderPath('ProgramFilesX86')
    $chrome = @(
      (Join-Path $pf 'Google/Chrome/Application/chrome.exe'),
      (Join-Path $pf86 'Google/Chrome/Application/chrome.exe'),
      (Join-Path $pf 'Microsoft/Edge/Application/msedge.exe'),
      (Join-Path $pf86 'Microsoft/Edge/Application/msedge.exe')
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $chrome) {
      Write-Host "   skipped: no Chrome or Edge found for an isolated run"
    } else {
      $profile = Join-Path $root 'work/chrome-live'
      $livePort = 9224
      Start-Process -FilePath $chrome -WindowStyle Hidden -ArgumentList @(
        '--headless=new', '--disable-gpu', "--remote-debugging-port=$livePort",
        "--user-data-dir=$profile", 'about:blank'
      )
      Start-Sleep -Seconds 4
      $liveres = node work/live-test.js $livePort $api/ | Select-Object -Last 1
      Write-Host "   $liveres"
      if ($LASTEXITCODE -ne 0) { $fail = 1 }
      Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object { $_.CommandLine -like "*remote-debugging-port=$livePort*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  }

  if ($cdp) {
    Write-Host "== design audit"
    $auditUrl = if ($env:GOLDENHUE_AUDIT_URL) { $env:GOLDENHUE_AUDIT_URL } else { "$api/" }
    # Keep the detail, not just the count: a failure with no findings listed is a
    # puzzle for whoever reads this next.
    node work/audit.js $cdp $auditUrl > work/audit-last.log 2>&1
    $audit = Get-Content work/audit-last.log | Select-Object -Last 1
    Write-Host "   $audit"
    if ($audit -notmatch '^0 findings') {
      $fail = 1
      Write-Host "   full report: work/audit-last.log"
      Get-Content work/audit-last.log | Where-Object { $_ -notmatch 'clean$' -and $_.Trim() -ne '' } |
        Select-Object -First 8 | ForEach-Object { Write-Host "   $_" }
    }
  }

  if ($cdp) {
    Write-Host "== the front desk"
    $admin = node work/admin-test.js $cdp $api/ | Select-Object -Last 1
    Write-Host "   $admin"
    if ($LASTEXITCODE -ne 0) { $fail = 1 }
  }

  Write-Host "== two servers, one database"
  $race = node work/race-test.js | Select-Object -Last 1
  Write-Host "   $race"
  if ($LASTEXITCODE -ne 0) { $fail = 1 }

  Write-Host "== a booking survives a restart"
  $persist = node work/persist-test.js 10002 | Select-Object -Last 1
  Write-Host "   $persist"
  if ($LASTEXITCODE -ne 0) { $fail = 1 }

  # Runs last because it installs into a scratch directory, which takes a moment.
  Write-Host "== a fresh checkout installs and boots"
  node work/deploy-test.js > work/deploy-last.log 2>&1
  $deploy = Get-Content work/deploy-last.log | Select-Object -Last 1
  Write-Host "   $deploy"
  if ($LASTEXITCODE -ne 0) {
    $fail = 1
    Write-Host "   full report: work/deploy-last.log"
    Get-Content work/deploy-last.log | Where-Object { $_ -match 'FAIL' } | Select-Object -First 6 | ForEach-Object { Write-Host "   $_" }
  }
} else {
  Write-Host "== API checks skipped (set GOLDENHUE_API, for example http://localhost:3000)"
}

Write-Host ""
if ($fail) { Write-Host "SUITE FAILED" -ForegroundColor Red } else { Write-Host "SUITE PASSED" -ForegroundColor Green }
exit $fail
