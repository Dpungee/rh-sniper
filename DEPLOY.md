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

## 2. Install + clone

```bash
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
git clone https://github.com/Dpungee/rh-sniper && cd rh-sniper
npm install --omit=dev        # electron not needed headless
```

## 3. Benchmark BEFORE committing to the region

```bash
npm run latency
```

Compare `p50` against your other candidates (home baseline was ~55 ms public / ~70 ms
Alchemy). A good us-east box should be **well under 20 ms**. If it isn't, try another
region — it's a 5-minute test. Keep the fastest box.

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
npm run snipe -- --arm-only --ticker PEPE --amount 0.01 --slippage 15
sudo systemctl restart rh-sniper
journalctl -u rh-sniper -f        # watch it live (Ctrl+C to stop watching)
```

You should see `Armed for $PEPE ... Listening (live WS + polling)`. The service now
listens until the token launches or you cancel — through crashes and reboots.

Flags work as usual: add `--raw` (ALL safety off) or `--no-smart` (fixed slippage)
to the `--arm-only` line.

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
