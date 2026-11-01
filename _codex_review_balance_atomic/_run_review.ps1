
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'
Set-Location 'C:\Users\Administrator\Documents\电商助手\douyin-promo-guard'
$out = '_codex_review_balance_atomic'
$log = Join-Path $out 'prep-log.txt'
function L($m){ Add-Content -Path $log -Value $m; Write-Output $m }

L '==== atomic symbols in WORKING monitor ===='
Select-String -Path 'src\engine\monitor.js' -Pattern '_commitShopLastData|_markShopDataRefreshing|_applyBalanceToLastData|dataRefreshing|balanceStatus|balanceReason' |
  ForEach-Object { L ($_.LineNumber.ToString() + ': ' + $_.Line.Trim()) }

L '==== early overwrite rt.lastData=_summarizeData WORKING ===='
$hits = Select-String -Path 'src\engine\monitor.js' -Pattern 'rt\.lastData\s*=\s*_summarizeData|lastData\s*=\s*_summarizeData'
if (-not $hits) { L 'NONE' } else { $hits | ForEach-Object { L ($_.LineNumber.ToString() + ': ' + $_.Line.Trim()) } }

L '==== early overwrite in HEAD ===='
$head = git show HEAD:src/engine/monitor.js
$hits2 = $head | Select-String -Pattern 'rt\.lastData\s*=\s*_summarizeData|lastData\s*=\s*_summarizeData'
if (-not $hits2) { L 'NONE in HEAD' } else { $hits2 | ForEach-Object { L $_.Line.Trim() } }

L '==== candidate/_commit/_mark in patch (first 100) ===='
Select-String -Path (Join-Path $out 'diff-monitor.js.patch') -Pattern '_commitShopLastData|_markShopDataRefreshing|_applyBalanceToLastData|balanceStatus|dataRefreshing|lastData\s*=\s*_summarize' |
  Select-Object -First 100 | ForEach-Object { L ($_.LineNumber.ToString() + ': ' + $_.Line) }

L '==== qianchuan-reader touched by Qoder claim? leave as dirty note ===='
L ('qianchuan-reader dirty: ' + (Test-Path 'src\adapters\qianchuan-reader.js'))
git diff HEAD --stat -- src/adapters/qianchuan-reader.js | ForEach-Object { L $_ }

L '==== selftest ===='
Set-Location 'C:\Users\Administrator\Documents\电商助手'
node '_balance_null_fix_20261031\selftest-atomic.js' 2>&1 | ForEach-Object { L $_ }
L ('selftest exit=' + $LASTEXITCODE)

L '==== node --check ===='
node --check 'douyin-promo-guard\src\engine\monitor.js' 2>&1 | ForEach-Object { L $_ }
L ('monitor check=' + $LASTEXITCODE)
node --check 'douyin-promo-guard\integrations\bill-manager\watch-drill.js' 2>&1 | ForEach-Object { L $_ }
L ('nested wd check=' + $LASTEXITCODE)
node --check 'bill-manager\watch-drill.js' 2>&1 | ForEach-Object { L $_ }
L ('parent wd check=' + $LASTEXITCODE)

L '==== nested/parent watch-drill balance fields ===='
Select-String -Path 'douyin-promo-guard\integrations\bill-manager\watch-drill.js' -Pattern 'balanceStatus|balanceReason|refreshing|balanceCents' |
  Select-Object -First 40 | ForEach-Object { L ('nested:' + $_.LineNumber + ':' + $_.Line.Trim()) }
Select-String -Path 'bill-manager\watch-drill.js' -Pattern 'balanceStatus|balanceReason|refreshing|balanceCents' |
  Select-Object -First 40 | ForEach-Object { L ('parent:' + $_.LineNumber + ':' + $_.Line.Trim()) }

L DONE
