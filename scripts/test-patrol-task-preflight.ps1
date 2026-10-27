param([string]$Candidate = (Join-Path $PSScriptRoot 'deploy-patrol-refill-admin.ps1'))
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($Candidate, [Text.Encoding]::UTF8)
$start = $source.IndexOf("Get-ScheduledTask -TaskName 'PromoGuardWatchdog3443'")
$finish = $source.IndexOf('$taskOwner = Get-TaskOwner', $start)
if ($start -lt 0 -or $finish -le $start) { throw 'Actual task preflight source not found.' }
$preflight = $source.Substring($start, $finish - $start)
# Only the task preflight is executed. Both task cmdlets are in-memory doubles.
$script:fixtureXml = '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings><Triggers /></Task>'
$script:fixtureState = 'Ready'
function Get-ScheduledTask {
  param($TaskName)
  if ($TaskName -notin @('PromoGuardWatchdog3443', 'DailyPlanPublisher-Independent')) { throw 'Unexpected task name.' }
  return [pscustomobject]@{ State = $script:fixtureState; Settings = [pscustomobject]@{ Enabled = ($script:fixtureState -ne 'Disabled') } }
}
function Export-ScheduledTask { param($TaskName) return $script:fixtureXml }
Invoke-Expression $preflight
if ($taskOrigDoc.SelectSingleNode('//*[local-name()="Settings"]/*[local-name()="Enabled"]')) { throw 'Fixture must omit the default Enabled element.' }
$script:fixtureState = 'Disabled'
$script:fixtureXml = $script:fixtureXml.Replace('</Settings>', '<Enabled>false</Enabled></Settings>')
Invoke-Expression $preflight
if ($taskOrigDoc.SelectSingleNode('//*[local-name()="Settings"]/*[local-name()="Enabled"]').InnerText -ne 'false') { throw 'Explicit disabled setting was lost.' }
$script:fixtureState = 'Running'
$rejected = $false
try { Invoke-Expression $preflight } catch { if ($_.Exception.Message.Contains('is running')) { $rejected = $true } else { throw } }
if (-not $rejected) { throw 'Running publisher must still be rejected.' }
Write-Output 'PASS: default-enabled omission, explicit-disabled preservation, running-task rejection; no real tasks changed.'
