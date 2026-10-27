param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$taskBase = $PSScriptRoot
$taskUtf8 = New-Object Text.UTF8Encoding($false)
$taskMeta = [IO.File]::ReadAllText((Join-Path $taskBase 'acceptance.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$taskAllowed = @(
  'bill/watch-drill.js',
  'bill/promo-plan-scheduler.js',
  'bill/login-shop.js',
  'bill/login-session-persistence.js',
  'guard/src/engine/monitor.js',
  'publisher/daily-plan-runner.cjs',
  'publisher/daily-plan-task.ps1'
)
$taskRoots = @('bill', 'guard', 'publisher')
$taskGuardConfig = $null

function Get-TaskRoot([string]$root) {
  if ($taskRoots -notcontains $root) { throw 'Unexpected deployment root.' }
  $value = [string]$taskMeta.roots.$root
  if ([string]::IsNullOrWhiteSpace($value)) { throw 'Deployment root metadata is missing.' }
  return $value
}
function Get-TaskRelative($item) {
  $rel = ([string]$item.root + '/' + [string]$item.relativePath) -replace '\\', '/'
  if ([string]::IsNullOrWhiteSpace($rel) -or $rel.IndexOf('..') -ge 0 -or [IO.Path]::IsPathRooted($rel)) { throw 'Unsafe relative path.' }
  return $rel
}
function Get-TaskLivePath($item) {
  return (Join-Path (Get-TaskRoot $item.root) $item.relativePath)
}
function Get-TaskPayloadPath($item) {
  $pl = [string]$item.payloadRelativePath
  if ([string]::IsNullOrWhiteSpace($pl) -or $pl.IndexOf('..') -ge 0 -or [IO.Path]::IsPathRooted($pl)) { throw 'Unsafe payload path.' }
  return (Join-Path $taskBase $pl)
}
function Get-TaskBytesHash([byte[]]$bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return (([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()) }
  finally { $sha.Dispose() }
}
function Get-TaskPositive([string]$value) {
  $d = 0.0
  if (-not [double]::TryParse($value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { return $null }
  if ([double]::IsNaN($d) -or [double]::IsInfinity($d) -or $d -le 0) { return $null }
  return $d
}
function Get-TaskPlans($guardShop, $independentShop) {
  $v = 0
  if ($guardShop -and $guardShop.PSObject.Properties['plansPerShopPerDay']) {
    $s = [string]$guardShop.plansPerShopPerDay
    if ([int]::TryParse($s, [ref]$v) -and $v -ge 1 -and $v -le 10) { return $v }
  }
  if ($independentShop -and $independentShop.PSObject.Properties['plansPerShopPerDay']) {
    $s = [string]$independentShop.plansPerShopPerDay
    if ([int]::TryParse($s, [ref]$v) -and $v -ge 1 -and $v -le 10) { return $v }
  }
  $g = 0
  $publishing = $taskGuardConfig.planPublishing
  if ($publishing -and $publishing.PSObject.Properties['plansPerShopPerDay']) {
    $s = [string]$publishing.plansPerShopPerDay
    if ([int]::TryParse($s, [ref]$g) -and $g -ge 1 -and $g -le 10) { return $g }
  }
  return 3
}
function Get-TaskTargetRoi($guardShop, $independentShop) {
  if ($guardShop -and $guardShop.PSObject.Properties['targetRoi']) {
    $roi = Get-TaskPositive ([string]$guardShop.targetRoi)
    if ($null -ne $roi) { return $roi }
  }
  if ($independentShop -and $independentShop.PSObject.Properties['targetRoi']) {
    $roi = Get-TaskPositive ([string]$independentShop.targetRoi)
    if ($null -ne $roi) { return $roi }
  }
  return 15
}
function Get-TaskGuardShop($shop) {
  $guardShops = @($taskGuardConfig.shops)
  $byId = @($guardShops | Where-Object { ($_.deleted -ne $true) -and $_.id -and $shop.id -and ([string]$_.id -eq [string]$shop.id) })
  if ($byId.Count -eq 1) { return $byId[0] }
  if ($byId.Count -gt 1) { return $null }
  $byName = @($guardShops | Where-Object { ($_.deleted -ne $true) -and $_.name -and $shop.name -and ([string]$_.name -eq [string]$shop.name) })
  if ($byName.Count -eq 1) { return $byName[0] }
  return $null
}
function Get-TaskXmlValues([System.Xml.XmlDocument]$doc, [string]$localName) {
  $parts = @()
  foreach ($node in $doc.SelectNodes('//*[local-name()="' + $localName + '"]')) { $parts += $node.OuterXml }
  return ($parts -join '|')
}
function Test-TaskBaseline {
  if ($taskMeta.accepted -ne $true) { throw 'Independent acceptance is not complete.' }
  if (@($taskMeta.files).Count -ne $taskAllowed.Count) { throw 'Source file count mismatch.' }
  $manifest = Join-Path (Get-TaskRoot 'bill') 'promo-watchdog-fingerprint-manifest.json'
  if ((Get-FileHash -LiteralPath $manifest).Hash.ToLowerInvariant() -ne $taskMeta.manifestBeforeSha256) { throw 'Manifest changed. Nothing applied.' }
  $seen = @{}
  foreach ($item in @($taskMeta.files)) {
    $rel = Get-TaskRelative $item
    if ($taskAllowed -notcontains $rel) { throw 'Unexpected source path.' }
    if ($seen.ContainsKey($rel)) { throw 'Duplicate source path.' }
    $seen[$rel] = $true
    if ([string]::IsNullOrWhiteSpace([string]$item.beforeSha256)) { throw 'Baseline hash missing.' }
    $payload = Get-TaskPayloadPath $item
    $live = Get-TaskLivePath $item
    if (-not (Test-Path -LiteralPath $payload)) { throw 'Candidate payload missing.' }
    if ((Get-FileHash -LiteralPath $payload).Hash.ToLowerInvariant() -ne $item.afterSha256) { throw 'Candidate changed.' }
    if (-not (Test-Path -LiteralPath $live) -or (Get-FileHash -LiteralPath $live).Hash.ToLowerInvariant() -ne $item.beforeSha256) { throw 'Live source changed.' }
  }
  if ($seen.Count -ne $taskAllowed.Count) { throw 'Source file set mismatch.' }
  $newManifest = Join-Path $taskBase 'manifest-after.json'
  if (-not (Test-Path -LiteralPath $newManifest)) { throw 'Candidate manifest missing.' }
  if ((Get-FileHash -LiteralPath $newManifest).Hash.ToLowerInvariant() -ne $taskMeta.manifestAfterSha256) { throw 'Candidate manifest changed.' }
  $next = [IO.File]::ReadAllText($newManifest, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ([int]$taskMeta.expectedFileCount -ne 44 -or [int]$next.fileCount -ne 44 -or @($next.files).Count -ne 44) { throw 'Candidate manifest count mismatch.' }
  return $manifest
}
function Get-TaskOwner {
  $owners = @(Get-NetTCPConnection -LocalPort 3443 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($owners.Count -ne 1) { throw 'Expected exactly one 3443 port owner.' }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($owners[0])"
  $lock = [IO.File]::ReadAllText((Join-Path (Get-TaskRoot 'bill') '.server.lock'), [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($proc.Name -ne 'node.exe' -or $proc.CommandLine -notmatch 'start-server\.js' -or [int]$lock.pid -ne [int]$proc.ProcessId) { throw 'Port, lock, or canonical service identity mismatch.' }
  return $proc
}
function Test-TaskPublisherIdle {
  $pubRoot = Get-TaskRoot 'publisher'
  $normalizedPubRoot = $pubRoot.Replace('/', '\').TrimEnd([char]'\') + '\'
  $busy = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and
    $_.CommandLine.Replace('/', '\').IndexOf($normalizedPubRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine.IndexOf('daily-plan-runner.cjs', [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  return ($busy.Count -eq 0)
}
function Restore-TaskRollback {
  $restoreErrors = @()
  foreach ($item in @($taskMeta.files)) {
    try {
      $backup = Join-Path (Join-Path (Join-Path $taskBackup 'sources') $item.root) $item.relativePath
      [IO.File]::Copy($backup, (Get-TaskLivePath $item), $true)
    } catch { $restoreErrors += ('source ' + $item.relativePath + ': ' + $_.Exception.Message) }
  }
  try { [IO.File]::Copy((Join-Path $taskBackup 'manifest.json'), $taskLiveManifest, $true) } catch { $restoreErrors += ('manifest: ' + $_.Exception.Message) }
  try { [IO.File]::Copy((Join-Path $taskBackup 'daily-plan-config.json'), $taskPubConfigPath, $true) } catch { $restoreErrors += ('config: ' + $_.Exception.Message) }
  try { Register-ScheduledTask -TaskName 'DailyPlanPublisher-Independent' -Xml $taskOriginalXml -Force | Out-Null } catch { $restoreErrors += ('task: ' + $_.Exception.Message) }
  try { Start-ScheduledTask -TaskName 'PromoGuardWatchdog3443' -ErrorAction Stop } catch { $restoreErrors += ('watchdog: ' + $_.Exception.Message) }
  return $restoreErrors
}

$taskLiveManifest = Test-TaskBaseline
if ($ValidateOnly) { Write-Output 'VALIDATED_ACCEPTANCE_PAYLOAD_BASELINE_AND_MANIFEST'; return }

$taskGuardConfigPath = [string]$taskMeta.guardConfigAbsolute
if ([string]::IsNullOrWhiteSpace($taskGuardConfigPath)) { throw 'Guard config path metadata is missing.' }
$taskHelper = [string]$taskMeta.runtimeHelperAbsolute
if ([string]::IsNullOrWhiteSpace($taskHelper)) { throw 'Runtime helper path metadata is missing.' }
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$taskIdentity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run in Administrator PowerShell. No process stopped and no file changed.' }
Get-ScheduledTask -TaskName 'PromoGuardWatchdog3443' -ErrorAction Stop | Out-Null
$taskPubTask = Get-ScheduledTask -TaskName 'DailyPlanPublisher-Independent' -ErrorAction Stop
if ($taskPubTask.State -eq 'Running') { throw 'DailyPlanPublisher-Independent is running.' }
$taskOriginalXml = Export-ScheduledTask -TaskName 'DailyPlanPublisher-Independent'
$taskOrigDoc = New-Object Xml.XmlDocument
$taskOrigDoc.LoadXml($taskOriginalXml)
$taskEnabledNode = $taskOrigDoc.SelectSingleNode('//*[local-name()="Settings"]/*[local-name()="Enabled"]')
if (-not $taskEnabledNode -or $taskEnabledNode.InnerText -ne 'true') { throw 'DailyPlanPublisher-Independent must be enabled.' }

$taskOwner = Get-TaskOwner
$taskRuntimeResult = Join-Path (Split-Path $taskHelper -Parent) 'runtime-patrol-admin-before.json'
$taskDeadline = [DateTime]::UtcNow.AddMinutes(12)
do {
  & node $taskHelper 'patrol-admin-before' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Existing runtime read failed.' }
  if (-not (Test-Path -LiteralPath $taskRuntimeResult)) { throw 'Runtime result is missing.' }
  $runtime = [IO.File]::ReadAllText($taskRuntimeResult, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($runtime.guard.running -ne $true -or $runtime.guard.runtimeFingerprint.allOk -ne $true -or [int]$runtime.guard.runtimeFingerprint.pid -ne [int]$taskOwner.ProcessId) { throw 'Current healthy service could not be verified.' }
  $busy = ($runtime.auto.running -eq $true) -or ($runtime.process.running -eq $true) -or ($runtime.guard.cycleRunning -eq $true) -or (-not (Test-TaskPublisherIdle))
  if (-not $busy) { break }
  if ([DateTime]::UtcNow -ge $taskDeadline) { throw 'Service stayed busy for 12 minutes. No file or process changed.' }
  Write-Host 'Waiting for the current business cycle; no process stopped.'
  Start-Sleep -Seconds 10
} while ($true)
$taskOwnerNow = Get-TaskOwner
if ([int]$taskOwnerNow.ProcessId -ne [int]$taskOwner.ProcessId -or [string]$taskOwnerNow.CreationDate -ne [string]$taskOwner.CreationDate) { throw 'Service owner changed while waiting.' }
$taskLiveManifest = Test-TaskBaseline

$taskBackup = Join-Path $taskBase ('backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff'))
New-Item -ItemType Directory -Path $taskBackup | Out-Null
[IO.File]::Copy($taskLiveManifest, (Join-Path $taskBackup 'manifest.json'))
foreach ($item in @($taskMeta.files)) {
  $backup = Join-Path (Join-Path (Join-Path $taskBackup 'sources') $item.root) $item.relativePath
  [IO.Directory]::CreateDirectory((Split-Path $backup -Parent)) | Out-Null
  [IO.File]::Copy((Get-TaskLivePath $item), $backup)
}
$taskPubConfigPath = Join-Path (Get-TaskRoot 'publisher') 'daily-plan-config.json'
[IO.File]::Copy($taskPubConfigPath, (Join-Path $taskBackup 'daily-plan-config.json'))
[IO.File]::WriteAllText((Join-Path $taskBackup 'DailyPlanPublisher-Independent.xml'), $taskOriginalXml, $taskUtf8)

try {
  foreach ($item in @($taskMeta.files)) { [IO.File]::Copy((Get-TaskPayloadPath $item), (Get-TaskLivePath $item), $true) }
  [IO.File]::Copy((Join-Path $taskBase 'manifest-after.json'), $taskLiveManifest, $true)
  foreach ($item in @($taskMeta.files)) { if ((Get-FileHash -LiteralPath (Get-TaskLivePath $item)).Hash.ToLowerInvariant() -ne $item.afterSha256) { throw 'Deployed source readback mismatch.' } }
  if ((Get-FileHash -LiteralPath $taskLiveManifest).Hash.ToLowerInvariant() -ne $taskMeta.manifestAfterSha256) { throw 'Deployed manifest readback mismatch.' }
  $taskOwnerNow = Get-TaskOwner
  if ([int]$taskOwnerNow.ProcessId -ne [int]$taskOwner.ProcessId -or [string]$taskOwnerNow.CreationDate -ne [string]$taskOwner.CreationDate) { throw 'Service owner changed before stop.' }
  Stop-Process -Id $taskOwner.ProcessId -ErrorAction Stop
} catch {
  $taskFailure = $_.Exception.Message
  $taskPreRestoreErrors = @()
  foreach ($item in @($taskMeta.files)) {
    try { [IO.File]::Copy((Join-Path (Join-Path (Join-Path $taskBackup 'sources') $item.root) $item.relativePath), (Get-TaskLivePath $item), $true) } catch { $taskPreRestoreErrors += ('source ' + $item.relativePath + ': ' + $_.Exception.Message) }
  }
  try { [IO.File]::Copy((Join-Path $taskBackup 'manifest.json'), $taskLiveManifest, $true) } catch { $taskPreRestoreErrors += ('manifest: ' + $_.Exception.Message) }
  if ($taskPreRestoreErrors.Count -gt 0) { throw ('Deployment failed before stop; rollback was partial. Original error: ' + $taskFailure + '. Rollback errors: ' + ($taskPreRestoreErrors -join '; ')) }
  throw ('Deployment failed before stop; sources and manifest were restored. ' + $taskFailure)
}

try {
  $taskGuardConfig = [IO.File]::ReadAllText($taskGuardConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $taskConfigBytes = [IO.File]::ReadAllBytes($taskPubConfigPath)
  $taskConfigHash = Get-TaskBytesHash $taskConfigBytes
  $taskConfigText = $taskUtf8.GetString($taskConfigBytes)
  if ($taskConfigText.Length -gt 0 -and $taskConfigText[0] -eq [char]0xFEFF) { $taskConfigText = $taskConfigText.Substring(1) }
  $taskIndependent = $taskConfigText | ConvertFrom-Json
  if ($taskIndependent.PSObject.Properties['time']) { $taskIndependent.PSObject.Properties.Remove('time') }
  $taskUpdated = 0
  foreach ($shop in @($taskIndependent.shops)) {
    $shopDeleted = ($shop.PSObject.Properties['deleted'] -and ($shop.deleted -eq $true))
    if (-not $shopDeleted) {
      $guardShop = Get-TaskGuardShop $shop
      if ($guardShop) {
        $roi = Get-TaskTargetRoi $guardShop $shop
        $plans = Get-TaskPlans $guardShop $shop
        $shop | Add-Member -NotePropertyName 'targetRoi' -NotePropertyValue $roi -Force
        $shop | Add-Member -NotePropertyName 'plansPerShopPerDay' -NotePropertyValue $plans -Force
        $taskUpdated++
      }
    }
    if ($shop.PSObject.Properties['time']) { $shop.PSObject.Properties.Remove('time') }
  }
  if ((Get-TaskBytesHash ([IO.File]::ReadAllBytes($taskPubConfigPath))) -ne $taskConfigHash) { throw 'Independent config changed during migration.' }
  $taskTmp = $taskPubConfigPath + '.tmp'
  [IO.File]::WriteAllText($taskTmp, ($taskIndependent | ConvertTo-Json -Depth 12), $taskUtf8)
  $taskNullValue = $null
  try { $taskNullValue = [NullString]::Value } catch { $taskNullValue = $null }
  [IO.File]::Replace($taskTmp, $taskPubConfigPath, $taskNullValue)

  $taskTriggerNode = $taskOrigDoc.SelectSingleNode('//*[local-name()="Triggers"]')
  if (-not $taskTriggerNode) { throw 'Original task XML has no Triggers node.' }
  while ($taskTriggerNode.HasChildNodes) { [void]$taskTriggerNode.RemoveChild($taskTriggerNode.FirstChild) }
  Register-ScheduledTask -TaskName 'DailyPlanPublisher-Independent' -Xml $taskOrigDoc.OuterXml -Force | Out-Null

  $taskAfter = [IO.File]::ReadAllText($taskPubConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($taskAfter.PSObject.Properties['time']) { throw 'Obsolete top-level time property remains.' }
  $taskProjection = @()
  foreach ($shop in @($taskAfter.shops)) {
    if ($shop.PSObject.Properties['time']) { throw 'Obsolete time property remains.' }
    $taskProjection += [ordered]@{ id = $shop.id; name = $shop.name; targetRoi = $shop.targetRoi; plansPerShopPerDay = $shop.plansPerShopPerDay }
  }
  foreach ($item in @($taskMeta.files)) { if ((Get-FileHash -LiteralPath (Get-TaskLivePath $item)).Hash.ToLowerInvariant() -ne $item.afterSha256) { throw 'Deployed source readback mismatch.' } }
  if ((Get-FileHash -LiteralPath $taskLiveManifest).Hash.ToLowerInvariant() -ne $taskMeta.manifestAfterSha256) { throw 'Deployed manifest readback mismatch.' }
  $taskCurDoc = New-Object Xml.XmlDocument
  $taskCurDoc.LoadXml((Export-ScheduledTask -TaskName 'DailyPlanPublisher-Independent'))
  if (@($taskCurDoc.SelectNodes('//*[local-name()="Triggers"]/*')).Count -ne 0) { throw 'Task triggers remain after migration.' }
  if ((Get-TaskXmlValues $taskCurDoc 'Principal') -cne (Get-TaskXmlValues $taskOrigDoc 'Principal')) { throw 'Task principal changed.' }
  if ((Get-TaskXmlValues $taskCurDoc 'Actions') -cne (Get-TaskXmlValues $taskOrigDoc 'Actions')) { throw 'Task actions changed.' }
  if ((Get-TaskXmlValues $taskCurDoc 'Settings') -cne (Get-TaskXmlValues $taskOrigDoc 'Settings')) { throw 'Task settings changed.' }

  Start-ScheduledTask -TaskName 'PromoGuardWatchdog3443' -ErrorAction Stop
  $taskReceipt = [ordered]@{
    at = [DateTime]::UtcNow.ToString('o')
    oldPid = [int]$taskOwner.ProcessId
    backup = $taskBackup
    files = @($taskMeta.files | ForEach-Object { [ordered]@{ root = $_.root; relativePath = $_.relativePath; afterSha256 = $_.afterSha256 } })
    targetConfigProjection = $taskProjection
    triggerCount = 0
    watchdogRequested = $true
  }
  [IO.File]::WriteAllText((Join-Path $taskBase 'applied.json'), ($taskReceipt | ConvertTo-Json -Depth 8), $taskUtf8)
} catch {
  $taskFailure = $_.Exception.Message
  $taskRestoreErrors = @(Restore-TaskRollback)
  if ($taskRestoreErrors.Count -gt 0) {
    throw ('Deployment failed after service stop; rollback was partial. Original error: ' + $taskFailure + '. Rollback errors: ' + ($taskRestoreErrors -join '; '))
  }
  throw ('Deployment failed after service stop; backups were restored and the watchdog was requested. ' + $taskFailure)
}

Write-Host ('Patrol admin deployment complete. Source files: ' + @($taskMeta.files).Count + '; manifest files: 44; publisher task triggers: 0; watchdog requested: yes. Guard-matched shops updated: ' + $taskUpdated + '. Updated source enables missing-plan checks after the service reload. Next verification pending; no QR and no Cookie write was performed.')
