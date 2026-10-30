' 独立每日计划发布：无 DOS 闪窗启动器（R4）。
' 由 daily-plan-task.ps1 注册的计划任务以 wscript //B //Nologo 调起；
' 只启动 node 一次性 --run，窗口风格 0（完全隐藏），不创建可见 cmd，
' 不调用/停止/重启 3443 值守服务或任何旧任务，也不树杀进程。
' R4：必须等待 node 真正结束（bWaitOnReturn=True），再用 WScript.Quit 传回
' 真实退出码——旧版 Run(...,0,False) 立即返回，计划任务会误报"上一次运行成功"。
Dim fso, sh, dir, node, code
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.CurrentDirectory = dir
code = sh.Run("""" & node & """ """ & dir & "\daily-plan-runner.cjs"" --run", 0, True)
WScript.Quit(code)
