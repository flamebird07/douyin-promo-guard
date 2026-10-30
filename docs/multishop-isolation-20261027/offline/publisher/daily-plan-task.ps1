# 独立每日计划发布：Windows 计划任务注册/查看/停用入口（R4，仅源文件，本轮不运行）。
#
# 2026-10-26 patrol-plan-refill（客户要求）：补发检查改为"全天随值守巡查周期触发"
#（由推广值守 watch-drill 的 onPollComplete 桥用 wscript //B //Nologo 调
# daily-plan-hidden.vbs 隐藏启动 node daily-plan-runner.cjs --run），去掉 08:00 门槛。
# 本任务因此不再注册任何固定时间触发器（无 -Time 参数、无 -Daily/-At 触发）：
# 注册后仅作为**按需任务**存在（手动 Run、或按需显式触发仍有效），避免与值守桥
# 竞争同一补发。账本/进程锁去重由 runner 侧既有 ledger lock 保证（并发触发只有
# 一个进程真正派发）。
# 注册默认不立即执行（不传 -ExecuteNow；如需立即试跑请手动 Run 或 node --run）。
# 保留 R5：注册显式当前用户 Interactive/Limited Principal；不调用/停止/重启 3443
# 值守服务、不触碰任何旧计划任务、不树杀进程。
#
# R4 修复：PowerShell 变量名大小写不敏感，局部变量 $action/$trigger/$settings 会覆盖
# param($Action)，故全部改名 $taskAction/$taskSettings，且只在 Register 分支内构造——
# Show/Run/Disable/Enable/Unregister 不构造任何注册对象，更不会触发注册。
#
# 离线验收指引（主脑执行；不注册、不触网、不碰 3443/旧任务）：
#   1) 触发器零构造（必须 True）：
#      $raw = Get-Content -Raw .\daily-plan-task.ps1
#      $raw.IndexOf('New-ScheduledTaskTrigger') -lt 0      # 无任何触发器构造
#   2) 只读动作零构造：'New-ScheduledTaskAction' 必须只出现在 "'Register' {" 分支之后：
#      $raw.IndexOf('New-ScheduledTaskAction') -gt $raw.IndexOf("'Register' {")   # 必须 True
#   3) dry 解析（可选）：[System.Management.Automation.PSParser]::Tokenize($raw, [ref]$null) 无异常
#
# 用法示例：
#   .\daily-plan-task.ps1 Register            # 注册按需独立任务（无时间触发器，不立即执行）
#   .\daily-plan-task.ps1 Register -ExecuteNow  # 注册并立即触发一次（显式 opt-in）
#   .\daily-plan-task.ps1 Show                # 查看任务状态
#   .\daily-plan-task.ps1 Run                 # 手动触发一次
#   .\daily-plan-task.ps1 Disable             # 停用（保留任务，不再被触发）
#   .\daily-plan-task.ps1 Enable              # 重新启用
#   .\daily-plan-task.ps1 Unregister          # 删除任务
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('Register', 'Show', 'Run', 'Disable', 'Enable', 'Unregister')]
  [string]$Action = 'Show',

  [switch]$ExecuteNow,

  [string]$TaskName = 'DailyPlanPublisher-Independent'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'daily-plan-hidden.vbs'
if (-not (Test-Path $vbs)) { throw "找不到 $vbs" }

switch ($Action) {
  'Register' {
    # wscript //B //Nologo：批处理模式、无横幅；.vbs 内 Run 风格 0 隐藏 node 并等待真实退出码。
    $argument = "//B //Nologo `"$vbs`""
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $argument
    # R5：显式当前用户 Interactive/最低权限 Principal——Register-ScheduledTask 的默认
    # Principal（UserId/LogonType/RunLevel 均空）在主脑环境触发拒绝访问；不请求
    # 管理员/Highest，不创建 SYSTEM 任务，不改任何 DACL。
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    # patrol-plan-refill：无时间触发器（按需任务；值守桥/手动 Run 触发）。
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) { throw "任务 $TaskName 已存在；如需覆盖请先 Unregister。" }
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Settings $taskSettings -Principal $taskPrincipal | Out-Null
    Write-Host "已注册独立任务 $TaskName（当前用户 Interactive/Limited，无固定时间触发器；由值守巡查周期按需触发，手动 Run 仍有效，注册默认不立即执行）。"
    if ($ExecuteNow) { Start-ScheduledTask -TaskName $TaskName; Write-Host '已显式请求立即触发一次。' }
  }
  'Show' {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
      $info = $t | Get-ScheduledTaskInfo
      Write-Host ("任务: {0}`n状态: {1}`n上次运行: {2}`n下次运行: {3}" -f $TaskName, $t.State, $info.LastRunTime, $info.NextRunTime)
    } else { Write-Host "任务 $TaskName 不存在。" }
  }
  'Run' { Start-ScheduledTask -TaskName $TaskName; Write-Host "已手动触发 $TaskName 一次。" }
  'Disable' { Disable-ScheduledTask -TaskName $TaskName | Out-Null; Write-Host "已停用 $TaskName（未来派发不再发生）。" }
  'Enable' { Enable-ScheduledTask -TaskName $TaskName | Out-Null; Write-Host "已重新启用 $TaskName。" }
  'Unregister' { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "已删除 $TaskName。" }
}
