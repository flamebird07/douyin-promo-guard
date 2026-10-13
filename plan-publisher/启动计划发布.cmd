@echo off
chcp 65001 >nul
setlocal

rem ============================================================================
rem  一键启动：千川「商品自选」计划发布（本地确定性程序，无模型）
rem ----------------------------------------------------------------------------
rem  双击本文件即可运行。默认使用正式项目根目录；如需临时改用其它根目录，
rem  可在命令行传入：  启动计划发布.cmd "D:\其它\项目根目录"
rem
rem  本脚本不写死任何 runId / 计划名称 / 授权信息；每一份计划仍需你在浏览器
rem  弹出的本地确认页上，逐份人工点击「确认发布本计划」后才会真正发布。
rem  默认最多顺序准备 3 份计划，第 1 份人工确认并真实发布回读成功后才准备第 2 份。
rem ============================================================================

rem 正式项目根目录（包含 src\config.js 与 src\adapters\chengfang-reader.js）。
if "%~1"=="" (
  set "PROMO_PROJECT_ROOT=C:\Users\Administrator\Documents\电商助手\douyin-promo-guard"
) else (
  set "PROMO_PROJECT_ROOT=%~1"
)

rem 切换到脚本所在目录，保证以本地 flow-freeze 工作区为运行根。
cd /d "%~dp0"

echo 项目根目录 PROMO_PROJECT_ROOT = %PROMO_PROJECT_ROOT%
echo 正在启动计划发布程序（浏览器将可见打开，请勿关闭本窗口）……
echo.

node run-plans.cjs

echo.
echo 程序已结束或已停止。若上方显示 stopped / blocked，请按 README 的“异常与恢复”处理。
pause
endlocal
