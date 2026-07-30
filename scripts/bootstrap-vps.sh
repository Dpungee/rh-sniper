#!/usr/bin/env bash
# One-shot VPS bootstrap for the RH Chain sniper.
#
#   curl -fsSL https://raw.githubusercontent.com/Dpungee/rh-sniper/main/scripts/bootstrap-vps.sh | bash
# or, if the repo is already cloned:
#   ./scripts/bootstrap-vps.sh
#
# Installs Node if missing, clones/updates the repo, installs deps, and runs the
# latency benchmark so you can judge the region BEFORE configuring anything.
# It deliberately does NOT touch your private key or start trading — those steps
# are printed at the end for you to run yourself.
set -euo pipefail

REPO="https://github.com/Dpungee/rh-sniper"
DIR="${RH_DIR:-$HOME/rh-sniper}"
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

say "RH Chain sniper — VPS bootstrap"
uname -a || true

# ---- Node 22+ -------------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  say "Installing Node.js 22"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo apt-get install -y curl git ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    warn "No apt-get here — install Node 20+ and git manually, then re-run."
    exit 1
  fi
else
  say "Node $(node -v) already present"
fi

# ---- repo -----------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Updating existing checkout at $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Cloning into $DIR"
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

say "Installing dependencies (headless — Electron not needed)"
npm install --omit=dev --no-audit --no-fund

# ---- latency check FIRST ---------------------------------------------------
say "Measuring RPC latency from this box"
echo "Compare against the home baseline (p50 ~43ms). A good us-east box should be WELL under 20ms."
echo "If it isn't, this is the moment to try another region — nothing is configured yet."
npm run latency 30 || warn "latency benchmark failed (RPC unreachable?) — check networking"

# ---- config scaffolding ----------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  say "Created .env (chmod 600)"
else
  say ".env already exists — leaving it alone"
fi

cat <<'NEXT'

──────────────────────────────────────────────────────────────────────
Bootstrap complete. Remaining steps are yours to run (they touch keys):

  1. Add your RPC key + unattended password:
       nano .env
     Set ALCHEMY_KEY=...   and   RH_PASSWORD=...
     ⚠ Use a THROWAWAY wallet: this box stores the key AND its password.

  2. Import that throwaway wallet's private key:
       npm run keystore import
       chmod 600 ~/.rh-sniper/keystore.json

  3. Sanity check (read-only, no wallet needed):
       npm run dryrun

  4. Install the always-on service:
       sed -i "s|%USERNAME%|$USER|; s|%REPO_PATH%|$PWD|" deploy/rh-sniper.service
       sudo cp deploy/rh-sniper.service /etc/systemd/system/
       sudo systemctl daemon-reload
       sudo systemctl enable rh-sniper

  5. Stage a snipe and start it:
       npm run snipe -- --arm-only --ticker 0xYOURCONTRACT --amount 0.01
       sudo systemctl restart rh-sniper
       journalctl -u rh-sniper -f

Fund the wallet before it can actually fire.
──────────────────────────────────────────────────────────────────────
NEXT
