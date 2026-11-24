@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0" || goto failed

where node.exe >nul 2>&1
if errorlevel 1 (
    >&2 echo [Bridge] Node.js is required. Install it and add it to PATH.
    goto failed
)

node -e "require('ws'); require.resolve('serialport')" >nul 2>&1
if not errorlevel 1 goto run

where npm.cmd >nul 2>&1
if errorlevel 1 (
    >&2 echo [Bridge] npm is required to install the dependencies.
    goto failed
)
echo [Bridge] Installing dependencies...
call npm.cmd install --no-save
if errorlevel 1 goto failed

:run
node bridge.js --replace --open
if not errorlevel 1 exit /b 0

:failed
>&2 echo [Bridge] Startup failed. See the message above.
pause
exit /b 1
