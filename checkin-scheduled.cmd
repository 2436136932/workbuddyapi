@echo off
:: Scheduled task entry (silent): checkin + growth center, appended to data\checkin.log
cd /d "%~dp0"
if not exist "data" mkdir "data"
node checkin.mjs --growth >> data\checkin.log 2>&1