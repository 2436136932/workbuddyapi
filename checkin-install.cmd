@echo off
:: 注册 Windows 计划任务：每天 09:10 自动签到（即使服务没启动也能跑）。
:: 用法：双击本文件（需要管理员权限会自动提权）。删除任务：schtasks /delete /tn "WorkBuddyAutoCheckin" /f
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo 需要管理员权限，正在提权...
  powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
where node >nul 2>&1 || (echo 未找到 node，请先安装 Node.js 20+ 并加入 PATH & pause & exit /b 1)
set TASK=WorkBuddyAutoCheckin
schtasks /query /tn "%TASK%" >nul 2>&1
if not errorlevel 1 schtasks /delete /tn "%TASK%" /f >nul
schtasks /create /tn "%TASK%" /tr "\"%CD%\checkin-scheduled.cmd\"" /sc daily /st 09:10 /f
echo.
echo 已注册计划任务 %TASK%（每天 09:10 自动签到）。
echo 改时间：schtasks /change /tn "%TASK%" /st HH:MM
echo 看结果：type checkin.log
pause
