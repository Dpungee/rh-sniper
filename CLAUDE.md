# CLAUDE.md — RH Chain Sniper

Context for Claude Code when working in this repo.

## What this is
A desktop (Electron) meme-coin sniper for **Robinhood Chain** — an Ethereum L2
(Arbitrum Orbit, chainId `4663`, ETH gas). The user gives a **ticker**, an **exact ETH
amount**, and their own **gas** and **slippage**; the app watches the DEX for new pairs and
fires a buy the instant a token with a matching symbol launches.

It is NOT connected to a Robinhood account — it signs transactions directly against on-chain
Uniswap contracts with a locally-held key.

## Run
```bash
npm install
npm run dryrun      # read-only: chain connectivity + live pair listener (no wallet)
npm start           # launch the Electron app
npm run snipe -- --ticker X --amount 0.01   # headless arm+listen+fire (no UI)
npm run keystore import   # optional: import key from terminal instead of the UI
```
`run-headless.bat` / `run-headless.sh` wrap `npm run snipe` with auto-restart-on-crash.
Headless exit codes: 0 = snipe done/cancelled (don't restart), 1 = crash (restart),
2 = setup error (don't restart). Unattended unlock via env `RH_PASSWORD`.
Node 18+ required (uses built-in fetch, ESM, node:crypto scrypt).

## Architecture
```
Electron main (src/main.js)  ── IPC ──  renderer UI (src/ui/*)
        │
        └─ Sniper engine (src/engine/)
             chain.js         viem clients + chain def + endpoint resolution + .env loader
             keystore.js      scrypt + AES-256-GCM local keystore (~/.rh-sniper/keystore.json)
             discovery.js     resilient factory listener: HTTP getLogs polling backbone
                              (persisted block cursor, catches up after any gap) + optional
                              WS accelerator (private RPC only); dedup + backoff, never dies
             resolver.js      symbol == ticker match (case-insensitive, strips leading $)
             safety.js        OPTIONAL honeypot gate (buy+sell sim); OFF by default
             swap.js          SwapRouter02 exactInputSingle path
             swapUniversal.js UniversalRouter (WRAP_ETH + V3_SWAP_EXACT_IN); DEFAULT executor
             abis.js          minimal ABIs
```
Data flow: `arm(params)` -> discovery emits new token -> resolver matches ticker ->
(optional safety) -> executor builds+sends buy -> waitForTransactionReceipt -> log/disarm.
The engine is an EventEmitter; UI subscribes to `log` / `state` / `fired` via preload IPC.

Always-on guarantee: an armed snipe listens until it fires or is cancelled. `arm()` persists
non-secret params to `~/.rh-sniper/pending.json`; `useAccount()` (unlock) auto-resumes any
pending snipe, so an app/machine restart continues the watch. `disarm()` and a confirmed
buy clear the pending file; a transient send failure keeps it armed and keeps watching.

## Config (`config.json`)
- `dex.executor`: `"universal-router"` (default) or `"swap-router-02"`.
- Verified Robinhood Chain addresses (checked to have live bytecode on-chain, July 2026):
  - WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
  - UniswapV3Factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`
  - SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2`
  - QuoterV2 `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7`
  - UniversalRouter `0x8876789976decbfcbbbe364623c63652db8c0904`
  - Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- RPC precedence (see `resolveEndpoints`): env `RH_RPC_HTTP/WSS` > `ALCHEMY_KEY` >
  `chain.rpcHttpPrivate/WssPrivate` > public `chain.rpcHttp/Wss`. A private WSS endpoint
  enables real-time `eth_subscribe` streaming; public RPC is rate-limited and polls.
- `safety.enabled`: honeypot gate (buy+sell quote sim). Currently `true` (user's choice,
  2026-07-16). Unquotable fresh pools are rechecked every `safety.retryMs` up to
  `safety.retries` times before that token is abandoned; the snipe stays armed regardless.
- Per-snipe `smartSlippage` param (UI checkbox, default ON; headless `--no-smart` disables):
  escalating slippage ladder in sniper.js onNewToken — start at user's %, widen by
  `smartSlippage.widenFactor` ONLY on a price revert (see `isPriceRevert`), capped at
  `smartSlippage.maxPct`. Retries both estimate-time rejections and on-chain reverts.
  Never retries non-price failures. Inert in raw mode.
- Per-snipe `rawMode` param (UI checkbox / headless `--raw`) turns off ALL safety features
  for that snipe: skips the honeypot gate AND the quoter/min-out in both executors
  (amountOutMinimum=0, accept any price; saves the quoter RPC round-trip). Persists with
  pending.json. Calldata structure verified unchanged with minOut=0 (round-trip decode).

## Portfolio / PNL
- `trades.js`: append-only fill journal at `~/.rh-sniper/trades.json`; `tokensReceived()`
  sums the receipt's Transfer logs to the buyer (handles fee-on-transfer). sniper.js
  records a fill on every confirmed buy.
- `portfolio.js`: holdings via `alchemy_getTokenBalances` (verified supported on this
  chain; falls back to balanceOf over journaled tokens on public RPC), valued token->WETH
  via QuoterV2 across fee tiers (journal's tier first). Unquotable = null, never 0.
  PNL = live value minus journaled cost; sells outside the app are not tracked.
- Surfaces: `npm run portfolio [-- 0xADDR]`, UI "Holdings & PNL" panel (`portfolio:get` IPC).

## Conventions
- ES modules everywhere (`"type": "module"`). Electron preload MUST stay CommonJS →
  it is `src/preload.cjs`; don't rename it to `.js`.
- Use **viem** (already a dep) for all chain work. Don't add ethers.
- Keep the key handling local-only: never log the private key, never send it off-machine.
- Money-touching code (swap.js / swapUniversal.js): change carefully. The UniversalRouter
  calldata was verified by round-trip decode — execute selector `0x3593564c`, commands
  `0x0b00`, recipient = MSG_SENDER, `payerIsUser=false`. Preserve that structure.

## Verifying changes (do this after edits)
- `node --check` each edited file.
- `npm run dryrun` to confirm chain reads still work.
- For swap changes: encode the calldata and `decodeFunctionData` it back to confirm the
  selector/commands/params, and (ideally) `simulateContract` against the real contracts.
- Never test real buys with real funds — use a throwaway wallet + tiny amount.

## Speed model (important — this is a sequencer L2, not L1)
Robinhood Chain is Arbitrum Orbit: **FCFS sequencer, no public mempool, priority fee = 0**
(verified via RPC: `newPendingTransactions` → "notifications not supported", `txpool_status`
unsupported, `eth_maxPriorityFeePerGas` → 0). Therefore:
- Mempool watching is NOT possible here and must not be built — pools appear already-mined.
- Gas-priority bidding does NOT win ordering; do not add fee-escalation "to win the race".
- The only lever is latency: detect → sign → reach sequencer first.
Code choices that serve this: discovery reads only `symbol` and processes a scan's logs
concurrently (`handleLogs`); both executors pass an explicit `dex.gasLimit` to skip
`eth_estimateGas` (a round-trip AND a fresh-pool revert source). Further latency wins are
infrastructural (paid RPC near the sequencer, low-latency host), not code.

## Known gotchas
- Fresh pools often can't be quoted yet → `computeMinOut` returns `0n` (accept-any). That's
  intentional for launch-moment sniping but is the main money-risk knob; document any change.
- On-chain symbols are NOT unique. Ticker-only matching can hit a duplicate/honeypot token.
  The safety gate exists to mitigate this; it's off by default.

## Roadmap / not-yet-built
- Auto-sell (take-profit / stop-loss) after a fill.
- Migrating v3-path swaps to v4 if/when liquidity moves.
