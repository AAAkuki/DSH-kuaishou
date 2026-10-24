# 安全启用：把 kuaishou 的条目装回去 → 重启 DSH → 20 秒内验证是否起得来；
# 起不来就**自动回滚**（摘掉 kuaishou 条目与 bundle）再重启一次，保证不会把用户锁在外面。
$ErrorActionPreference = 'Continue'
$LOG = 'C:\Users\wudiw\Documents\deepseek\kuaishou-ops\state\safe-enable.log'
$EXE = 'C:\Users\wudiw\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$REPO = 'C:\Users\wudiw\Documents\deepseek\kuaishou-ops'
$PROFILE = "$env:USERPROFILE\.dsh\profiles\desktop"

function W($m) { Add-Content -Path $LOG -Value "$(Get-Date -Format 'HH:mm:ss') $m" -Encoding utf8 }
Set-Content -Path $LOG -Value '' -Encoding utf8

function Stop-Dsh {
  for ($i = 0; $i -lt 3; $i++) {
    $p = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($p.Count -eq 0) { return }
    foreach ($x in $p) { Stop-Process -Id $x.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }
}

function Wait-Port([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    Start-Sleep -Seconds 1
    $pids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if ($pids.Count -eq 0) { continue }
    $conn = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess -and $_.LocalAddress -eq '127.0.0.1' })
    if ($conn.Count -gt 0) { return ($conn | Select-Object -First 1).LocalPort }
  }
  return $null
}

W 'step 1: install kuaishou (patch entry + bundle)'
Push-Location $REPO
$install = & 'C:\Program Files\nodejs\node.exe' install.mjs --profile desktop 2>&1 | Out-String
Pop-Location
W $install.Trim()

W 'step 2: restart DSH'
Stop-Dsh
Start-Sleep -Seconds 3
Start-Process -FilePath $EXE -WorkingDirectory (Split-Path $EXE)
$port = Wait-Port 40
W "port after start: $port"

if ($port) {
  W 'RESULT=OK (DSH booted with kuaishou enabled)'
  Start-Sleep -Seconds 5
  $clientErr = & 'C:\Program Files\nodejs\node.exe' -e "
    const { chromium } = require('$($REPO.Replace('\','/'))/node_modules/playwright-core');
    (async () => {
      const ctx = await chromium.launchPersistentContext('$($REPO.Replace('\','/'))/.web-profile-dsh', { executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
      const p = ctx.pages()[0] ?? await ctx.newPage();
      await p.goto('http://127.0.0.1:$port', { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(3000);
      const err = await p.evaluate(() => localStorage.getItem('kuaishou-client-error'));
      console.log('client-error:', err ? err.split('\n').slice(0,6).join(' | ') : '(none)');
      await ctx.close();
    })().catch(e => console.log('probe failed:', e.message));
  " 2>&1 | Out-String
  W $clientErr.Trim()
} else {
  W 'RESULT=CRASH — rolling back kuaishou entries'
  Push-Location $REPO
  $rm = & 'C:\Program Files\nodejs\node.exe' install.mjs --profile desktop --remove 2>&1 | Out-String
  Pop-Location
  W $rm.Trim()
  Stop-Dsh
  Start-Sleep -Seconds 3
  Start-Process -FilePath $EXE -WorkingDirectory (Split-Path $EXE)
  $port2 = Wait-Port 40
  W "ROLLBACK done, port after rollback: $port2"
  W ($(if ($port2) { 'RESULT=ROLLED_BACK_OK' } else { 'RESULT=STILL_BROKEN — 需要手动处理' }))
}
W 'finished'
