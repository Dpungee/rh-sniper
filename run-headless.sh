#!/usr/bin/env bash
# Auto-restarting headless sniper (macOS / Linux / VPS).
#   ./run-headless.sh --ticker PEPE --amount 0.01 --slippage 15
#   ./run-headless.sh --resume
#
# Restarts on crash (exit 1). Stops when the snipe completes or is cancelled
# (exit 0) or on a setup error like wrong password / no keystore (exit 2).
# For UNATTENDED restarts set RH_PASSWORD in .env (see .env.example — throwaway
# wallet only). On a VPS, run inside tmux/screen or a systemd unit so it
# survives your SSH session ending.
set -u
cd "$(dirname "$0")"

while true; do
  node scripts/snipe-headless.js "$@"
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "[wrapper] Snipe finished or cancelled. Not restarting."
    exit 0
  elif [ "$code" -eq 2 ]; then
    echo "[wrapper] Setup error (usage/keystore/password). Fix it and rerun."
    exit 2
  fi
  echo "[wrapper] Crashed (exit $code). Restarting in 5s..."
  sleep 5
done
