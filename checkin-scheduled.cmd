@echo off
:: 计划任务实际执行的脚本（静默）：签到 + 成长中心，结果追加到 checkin.log
cd /d "%~dp0"
node checkin.mjs --growth >> checkin.log 2>&1
