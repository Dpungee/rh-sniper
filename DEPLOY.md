# Deploying to a VPS (24/7, lowest latency)

Robinhood Chain's sequencer is first-come-first-served, so the bot should run on a box
with the lowest round-trip time to the sequencer — almost certainly **AWS us-east-1
(Ashburn, N. Virginia)** or nearby. Measure, don't guess: this guide bakes that in.

**Wallet warning (read first):** to run unattended, the encrypted keystore AND its
password (`RH_PASSWORD` in `.env`) live on the server. Anyone who compromises the box can
drain that wallet. Use a **dedicated throwaway wallet** funded only with snipe money.

---

## 1. Get a box

Any 1 vCPU / 1 GB Linux VPS (Ubuntu 22.04+/Debian 12) works. Pick the **Ashburn /
N. Virginia / us-east** region:

- AWS EC2 `us-east-1` (likely the sequencer's own region)
- Vultr / DigitalOcean — New York or Ashburn
- Hetzner / Latitude.sh — Ashburn

## 2. Bootstrap (one command)

SSH in and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Dpungee/rh-sniper/main/scripts/bootstrap-vps.sh | bash
```

That installs Node, clones the repo, installs dependencies, and **runs the latency
benchmark before anything is configured** — so you can judge the region and walk away if
it's bad. It deliberately stops short of touching keys; it prints the remaining steps.

## 3. Judge the region from the benchmark

The bootstrap ends with `npm run latency`. Compare `p50` against the **measured home
baseline: ~43 ms (Alchemy) / ~47 ms (public RPC)**.

A good us-east box should be **well under 20 ms**. If it isn't, destroy it and try another
region — nothing is configured yet, so it costs you five minutes. Keep the fastest box.

Why this matters: this chain's sequencer is **first-come-first-served with zero priority
fees**, so gas cannot buy you position — network latency is the only lever. Measured
locally, over 95% of the sniper's end-to-end time is RPC round-trips (signing is 0.7 ms),
so the box's distance to the sequencer effectively *is* the bot's speed.

## 4. Configure

```bash
cp .env.example .env
nano .env       # set ALCHEMY_KEY=...  and  RH_PASSWORD=...  (throwaway wallet!)
npm run keystore import        # paste the throwaway wallet's private key
chmod 600 .env ~/.rh-sniper/keystore.json
```

Sanity check (read-only): `npm run dryrun`

## 5. Install the service (auto-start on boot, restart on crash)

```bash
sed -i "s|%USERNAME%|$USER|; s|%REPO_PATH%|$PWD|" deploy/rh-sniper.service
sudo cp deploy/rh-sniper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable rh-sniper
```

## 6. Arm a snipe

```bash
# by exact contract address (preferred — cannot be spoofed by a copycat ticker)
npm run snipe -- --arm-only --ticker 0xC05e8894bF585862b7Cf2e1363c46E7546d37139 --amount 0.01

# or by ticker
npm run snipe -- --arm-only --ticker PEPE --amount 0.01 --slippage 15

sudo systemctl restart rh-sniper
journalctl -u rh-sniper -f        # watch it live (Ctrl+C to stop watching)
```

You should see `Armed for CA 0x… (exact contract — immune to ticker spoofing)` or
`Armed for $PEPE …`, followed by `Listening (live WS + polling)`. The service watches all
three venues (Uniswap v3, Uniswap v4/letscash.fun, Virtuals) until the token launches or
you cancel — through crashes and reboots.

Useful flags on the `--arm-only` line:

| Flag | Effect |
| --- | --- |
| `--raw` | ALL safety off, min-out 0 — the fastest fire path (see the speed note above) |
| `--no-smart` | fixed slippage instead of the escalating ladder |
| `--no-tax-watch` | fire even while an anti-sniper launch tax is active |
| `--pons` / `--launchpad pons,padB` | only accept launches from those launchpads |
| `--no-v4` / `--no-virtuals` | ignore a venue |

## 7. Cancel / change a snipe

```bash
sudo systemctl stop rh-sniper          # stop listening
rm ~/.rh-sniper/pending.json           # forget the staged snipe
# or stage a different one:
npm run snipe -- --arm-only --ticker OTHER --amount 0.02
sudo systemctl restart rh-sniper
```

## 8. After a fill

The service exits cleanly (systemd shows `inactive (dead)` — that's success, not a
crash). Check the log for the tx hash + explorer link:

```bash
journalctl -u rh-sniper -n 50
```

Tokens land in the throwaway wallet. There's no auto-sell yet — exit manually.

---

### Ops cheat-sheet

| What | Command |
| --- | --- |
| Status | `systemctl status rh-sniper` |
| Live log | `journalctl -u rh-sniper -f` |
| Stop listening | `sudo systemctl stop rh-sniper` |
| Update the bot | `cd rh-sniper && git pull && npm install --omit=dev && sudo systemctl restart rh-sniper` |
| Re-check latency | `npm run latency` |
