#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "=== RH Chain Sniper launcher ==="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install it from https://nodejs.org (or 'brew install node' on macOS), then run this again."
  exit 1
fi
echo "Using Node.js $(node --version)"
[ -d node_modules ] || { echo "Installing dependencies..."; npm install; }
echo "Checking connection..."; npm run dryrun || true
echo "Launching app..."; npm start
