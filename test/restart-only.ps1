# 只做重启 + 验证，不装东西（安装已经在跑过多次，这里减少失败面）
$ErrorActionPreference = 'Continue'
$LOG = 'C:\Users\wudiw\Documents\deepseek\kuaishou-ops\state\restart-only.log'
$EXE = 'C:\Users\wudiw\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'

function W($m) {
  "$(Get-Date -Format 'HH:mm:ss') $m" | Out-File -FilePath $LOG -Append -Encoding utf8
}
Set-Content -Path $LOG -Value '' -Encoding utf8
W "restart-only started (pid=$PID)"
Start-Sleep -Seconds 10

$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
W ("killing " + $procs.Count + " procs: " + (($procs | ForEach-Object { $_.Id }) -join ','))
foreach ($p in $procs) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 5
foreach ($p in @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
W ("left after kill: " + (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count))

W "launching exe"
Start-Process -FilePath $EXE -WorkingDirectory (Split-Path $EXE)

$port = $null
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    $pids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if (-not $pids) { continue }
    $conn = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess -and $_.LocalAddress -eq '127.0.0.1' })
    if ($conn.Count -gt 0) { $port = ($conn | Select-Object -First 1).LocalPort; break }
}
W "new port: $port"
if (-not $port) { W 'FAILED: no port'; exit 1 }

# 等插件把上传服务拉起来
$envOk = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:32801/env' -UseBasicParsing -TimeoutSec 5
        $j = $r.Content | ConvertFrom-Json
        W ('env.report.debug: ' + ($j.report.debug | ConvertTo-Json -Compress))
        $wp = @($j.report.checks | Where-Object { $_.id -eq 'webProfile' })[0]
        W ('webProfile.ok=' + $wp.ok + '  detail=' + $wp.detail)
        $envOk = $true
        break
    } catch { }
}
if (-not $envOk) { W 'env endpoint not reachable after restart (upload server 未起来?)' }

W 'done — reopen DeepSeek Harness'
