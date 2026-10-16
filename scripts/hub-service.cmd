@echo off
rem Keep the gateway running: start it, append to logs\service.log, and bring it
rem back if the process ever exits. Launched hidden by hub-service.vbs.
setlocal
cd /d "%~dp0.."

set "NODE_BIN=node"
where node >nul 2>nul || set "NODE_BIN=C:\Program Files\nodejs\node.exe"

if not exist "logs" mkdir "logs"

:loop
"%NODE_BIN%" dist\main.js >> "logs\service.log" 2>&1
echo [%DATE% %TIME%] gateway exited with %ERRORLEVEL%, restarting in 15s >> "logs\service.log"
timeout /t 15 /nobreak >nul
goto loop
