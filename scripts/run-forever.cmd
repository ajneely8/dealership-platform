@echo off
rem Keeps the Dealer Intel server up: builds once, serves on port 5310, and restarts if it stops.
rem Create the file .data\STOP to make this loop exit (scripts\service.cmd stop does that).
cd /d "%~dp0.."
:loop
if exist ".data\STOP" (
  del ".data\STOP"
  exit /b 0
)
echo [%date% %time%] starting >> ".data\server.log"
node scripts\dev-local.mjs --prod >> ".data\server.log" 2>&1
echo [%date% %time%] stopped with code %errorlevel% >> ".data\server.log"
timeout /t 10 /nobreak > nul
goto loop
