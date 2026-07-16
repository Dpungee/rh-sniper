# RH Chain Sniper

A desktop meme-coin sniper for **Robinhood Chain** (Ethereum L2, chain ID `4663`).
You give it a **ticker**, an **exact ETH amount**, and your own **gas** and **slippage** — it
watches the DEX for new pairs and fires a buy the instant a matching token launches.

Keys stay on your machine (encrypted local keystore). It talks directly to the chain's
public RPC and DEX router — it is **not** connected to your Robinhood account.

---

## ⚠️ Read this first

- **Ticker sniping is not safe by design.** On-chain, symbols are not unique — scammers
  spam duplicate tickers and honeypots to catch snipers. The honeypot **safety gate is ON**
  by default (`safety.enabled` in `config.json`): before firing it simulates a buy and an
  immediate sell, blocking likely honeypots and >50% round-trip tax. Fresh pools that can't
  be quoted yet are rechecked every 3s for ~1 minute (`safety.retries`/`retryMs`) so a real
  launch isn't abandoned just because liquidity landed a few blocks late. Set
  `safety.enabled: false` for raw speed — no checks, fires on first symbol match.
  You can also go raw **per snipe** without touching config: the red **RAW MODE** checkbox
  in the app, or `--raw` on the headless runner. Raw mode turns off EVERY safety feature:
  no honeypot/tax simulation, no price quote, and `amountOutMinimum = 0` — the buy accepts
  **any** price, including one token for all your ETH. It is the fastest path (no quoter
  round-trip before firing) and the most exposed. Entirely on you.
- **Contract addresses are filled in and verified.** `config.json` ships with the real
  Robinhood Chain Uniswap v3 addresses (factory, SwapRouter02, QuoterV2) and canonical WETH,
  confirmed against Uniswap + Robinhood docs and checked to have live contract code on-chain.
  The public RPC is rate-limited — drop in an Alchemy/QuickNode key for production.
- Only risk what you can afford to lose. Meme-coin sniping loses money for most people.

## Verified addresses (already in config.json)

| Role | Address |
| --- | --- |
| WETH (L2) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| UniswapV3 Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| SwapRouter02 (router) | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Sources: Uniswap v3 Robinhood Chain deployments + Robinhood Chain contract docs. All four
active contracts were verified to have live bytecode on-chain and WETH reads `symbol=WETH`.

## Execution & RPC

- Executor: `dex.executor` in `config.json` selects `universal-router` (default, Uniswap's
  preferred entrypoint — wraps ETH + swaps via `UniversalRouter` + Permit2) or `swap-router-02`
  (the classic `exactInputSingle` path). Both are implemented; the encoding was round-trip
  verified against the deployed contract (execute selector `0x3593564c`).
- Faster RPC + real-time events: set `ALCHEMY_KEY` in a `.env` file (copy `.env.example`) or
  `chain.alchemyKey` in config. With a private WebSocket endpoint the new-pair listener uses
  live `eth_subscribe` streaming instead of polling — critical for beating other snipers.
  The public RPC still works but is rate-limited. Env `RH_RPC_HTTP` / `RH_RPC_WSS` override everything.

## Install & run

```bash
npm install
npm run dryrun        # read-only: confirms RPC + (if factory set) live pair listener
npm start             # launches the desktop app
```

### Headless / 24-7 (no UI)

```bash
npm run snipe -- --ticker PEPE --amount 0.01 --slippage 15   # arm + listen in the terminal
npm run snipe -- --resume                                    # resume a saved snipe
run-headless.bat --ticker PEPE --amount 0.01                 # Windows: auto-restarts on crash
./run-headless.sh  --ticker PEPE --amount 0.01               # macOS/Linux/VPS: same
```

The wrappers restart the sniper if it crashes and stop cleanly once the snipe completes
(exit 0) or on a setup error like a wrong password (exit 2). For fully unattended runs set
`RH_PASSWORD` in `.env` so it can unlock without a prompt — **throwaway wallet only**, since
anyone who can read that file can unlock the key. On Windows, disable sleep while it runs
(`powercfg /change standby-timeout-ac 0`); on a VPS use tmux/systemd so it outlives SSH.

Import your key (UI import screen or `npm run keystore import`), unlock, enter a ticker,
set amount/gas/slippage, hit **SNIPE**. The app arms, listens, and fires on the first match.

## Always-on listening (until cancel or launch)

Once armed, the sniper keeps watching **until the ticker launches or you cancel** — it is
built not to go deaf in between:

- **Polling backbone.** Every `discovery.pollMs` (default 3s) it scans the DEX factory for
  new pools over a persisted block cursor, so an RPC blip, a dropped connection, or the
  machine sleeping is **caught up** on the next scan — no launch slips through the gap.
  This is what makes the rate-limited public RPC usable (it can't do `eth_subscribe`).
- **WS accelerator (optional).** With a private endpoint (`ALCHEMY_KEY`) it *also* opens a
  live WebSocket subscription for lower latency. It's best-effort — the poller is the
  guarantee — and both paths are de-duplicated so a pair fires once.
- **Self-healing.** Errors back off and retry (capped at 30s); the listener never dies on
  its own. A heartbeat line (`listening… scanned to block N`) shows it's alive.
- **Survives a restart.** The armed snipe is saved to `~/.rh-sniper/pending.json` (ticker +
  amounts only, never the key). Reopen the app and **unlock**, and the snipe resumes
  automatically. It's cleared only when you cancel or a buy confirms.

Tune it in `config.json` under `discovery`. To listen truly 24/7 unattended, run it on an
always-on machine with sleep disabled (and ideally a private RPC key for real-time speed).

## How it works

```
UI (Electron renderer)
  │  ipc
main.js ── Sniper engine
             ├─ discovery.js  watchContractEvent(factory) → new pairs in real time
             ├─ resolver.js   match new token symbol == your ticker
             ├─ safety.js     (optional) simulate buy+sell, block honeypots
             ├─ swap.js       exactInputSingle, exact ETH in, min-out from slippage, your gas
             └─ keystore.js   scrypt + AES-256-GCM, key stays local
```

## Files

- `config.json` — chain + DEX addresses + defaults (**edit this**)
- `src/engine/*` — chain client, keystore, discovery, resolver, safety, swap, orchestrator
- `src/ui/*` — single-screen dark UI
- `scripts/dryrun.js` — headless connectivity + listener test
- `scripts/keystore-cli.js` — import/check key from terminal

## Not financial advice. Not affiliated with Robinhood.
