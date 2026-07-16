@echo off
setlocal enabledelayedexpansion
title RH Chain Sniper - launcher
cd /d "%~dp0"

echo ============================================
echo   RH Chain Sniper - one-click launcher
echo ============================================
echo.

REM --- 1. Check for Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Trying to install it via winget...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo.
    echo winget is not available on this PC.
    echo Please install Node.js LTS manually from https://nodejs.org
    echo then double-click this file again.
    echo.
    pause
    exit /b 1
  )
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Node.js installed. Please CLOSE this window and double-click run-windows.bat again
  echo so the new PATH takes effect.
  echo.
  pause
  exit /b 0
)

for /f "delims=" %%v in ('node --version') do echo Using Node.js %%v
echo.

REM --- 2. Install dependencies if needed ---
if not exist "node_modules" (
  echo Installing dependencies ^(first run, ~1 min^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Copy the error above and send it to Claude.
    pause
    exit /b 1
  )
) else (
  echo Dependencies already installed.
)
echo.

REM --- 3. Quick read-only connectivity check ---
echo Checking Robinhood Chain connection...
call npm run dryrun
echo.

REM --- 4. Launch the app ---
echo Launching the app window...
call npm start

pause
