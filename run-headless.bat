@echo off
REM Auto-restarting headless sniper (Windows).
REM   run-headless.bat --ticker PEPE --amount 0.01 --slippage 15
REM   run-headless.bat --resume
REM
REM Restarts on crash (exit 1). Stops when the snipe completes or is cancelled
REM (exit 0) or on a setup error like wrong password / no keystore (exit 2).
REM For UNATTENDED restarts set RH_PASSWORD in .env (see .env.example — throwaway
REM wallet only). Tip: disable Windows sleep while this runs (powercfg /change standby-timeout-ac 0).

cd /d "%~dp0"

:loop
node scripts\snipe-headless.js %*
if %errorlevel%==0 (
  echo [wrapper] Snipe finished or cancelled. Not restarting.
  goto :eof
)
if %errorlevel%==2 (
  echo [wrapper] Setup error ^(usage/keystore/password^). Fix it and rerun.
  goto :eof
)
echo [wrapper] Crashed ^(exit %errorlevel%^). Restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
