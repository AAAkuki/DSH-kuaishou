# 重启 DeepSeek Harness，并验证「快手」设置页这次是否真的出现在 Web 启动清单里。
# 由计划任务拉起（脱离 DSH 的 job object），所以杀掉 DSH 不会连自己一起死。
$ErrorActionPreference = 'Continue'
$LOG = 'C:\Users\wudiw\Documents\deepseek\kuaishou-ops\state\restart-refresh.log'
$EXE = 'C:\Users\wudiw\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$REPO = 'C:\Users\wudiw\Documents\deepseek\kuaishou-ops'

function W($m) { Add-Content -Path $LOG -Value "$(Get-Date -Format 'HH:mm:ss') $m" -Encoding utf8 }
Set-Content -Path $LOG -Value '' -Encoding utf8

W 'waiting 12s so the reply can be delivered'
Start-Sleep -Seconds 12

$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
W ("killing " + $procs.Count + " processes: " + (($procs | ForEach-Object { $_.Id }) -join ','))
foreach ($p in $procs) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 6
foreach ($p in @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

W "launching $EXE"
Start-Process -FilePath $EXE -WorkingDirectory (Split-Path $EXE)

# 等新端口
$port = $null
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  $pids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  if (-not $pids) { continue }
  $conns = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess -and $_.LocalAddress -eq '127.0.0.1' })
  if ($conns.Count -gt 0) { $port = ($conns | Select-Object -First 1).LocalPort; break }
}
W "new port: $port"
if (-not $port) { W 'FAILED: no listening port'; exit 1 }

# 同步桥接的 baseUrl（qq-bridge 那边依赖它）
try {
  $cfgPath = 'C:\Users\wudiw\Documents\deepseek\qq-bridge\config.json'
  if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw -Encoding utf8 | ConvertFrom-Json
    $cfg.dsh.baseUrl = "http://127.0.0.1:$port"
    ($cfg | ConvertTo-Json -Depth 30) | Set-Content -Path $cfgPath -Encoding utf8
    W "qq-bridge baseUrl -> http://127.0.0.1:$port"
  }
} catch { W "qq-bridge config update failed: $($_.Exception.Message)" }

Start-Sleep -Seconds 6
W 'checking boot manifest for kuaishou client plugin…'
$node = 'C:\Program Files\nodejs\node.exe'
$out = & $node "$REPO\test\boot-check.mjs" "http://127.0.0.1:$port" 2>&1 | Out-String
W $out.Trim()
W 'done — reopen the DeepSeek Harness window'
