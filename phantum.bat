@echo off
rem phantum launcher (console version) — shows server logs in this window.
rem Double-click phantum.vbs instead for a windowless launch.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install it from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First launch: installing dependencies...
  call npm install
)

if "%PORT%"=="" set PORT=59333

start "" "http://127.0.0.1:%PORT%"
echo.
echo phantum running — press Ctrl+C to stop.
node server.js
