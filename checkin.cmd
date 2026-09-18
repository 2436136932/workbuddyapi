@echo off
cd /d "%~dp0"
node checkin.mjs --claim %*
pause
