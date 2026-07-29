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
(`powercfg /change standby-timeout-ac 0`).

**Deploying to a VPS** (recommended for real speed — this chain rewards proximity to the
sequencer): see [DEPLOY.md](DEPLOY.md) for the full copy-paste guide, including the
systemd service (`deploy/rh-sniper.service`, auto-start on boot + restart on crash),
`npm run latency` to pick the fastest region empirically, and staging snipes with
`npm run snipe -- --arm-only --ticker X`.

Import your key (UI import screen or `npm run keystore import`), unlock, enter a ticker,
set amount/gas/slippage, hit **SNIPE**. The app arms, listens, and fires on the first match.

## Speed — what actually makes you fast here

Robinhood Chain is a **first-come-first-served sequencer L2** (Arbitrum Orbit): no public
mempool, and `priority fee = 0`. Two consequences that differ from Ethereum L1:

- **Mempool sniping is impossible** — there are no visible pending transactions; a pool
  appears already-mined. Everyone sees a launch at the same block.
- **Gas bidding does not win races.** The sequencer orders by arrival, not by fee. Bumping
  priority fee buys you nothing here.

So speed = **raw latency from detecting the new pool to the sequencer receiving your buy**.
What this build does to minimise it:

- **One read per candidate, in parallel.** Detection reads only the token `symbol` (needed
  to match your ticker) and reads all pools in a scan concurrently, so your token is matched
  as fast as its own read — never waiting behind unrelated pairs.
- **No gas-estimation round-trip.** The buy sends with an explicit `dex.gasLimit`, so viem
  skips `eth_estimateGas` at the critical moment. Bonus: estimation *reverts on a brand-new
  pool*, so skipping it also removes a failure that could otherwise abort the snipe.
- **RAW mode** additionally skips the quoter round-trip (see above).
- **WS event stream** (Alchemy) hears about the mined pool without waiting for the next poll.

What's left in **your** hands (not code):

- **RPC latency to the sequencer.** A paid/dedicated endpoint geographically near the
  sequencer, and running the bot on a low-latency box (VPS) rather than a home laptop, is
  the biggest remaining win. On a home connection you are simply farther from the sequencer
  than a co-located bot.
- **`dex.gasLimit`** must stay comfortably above a real swap (~200–300k); too low = out-of-gas.

## Holdings & PNL

Every confirmed snipe is journaled (`~/.rh-sniper/trades.json`: ETH in, tokens actually
received parsed from the receipt, tx, block). The portfolio view shows what the wallet
holds, its live ETH value (each token quoted back to WETH via the QuoterV2), and
unrealized PNL vs. what the sniper paid:

- **In the app** — the "Holdings & PNL" panel (refresh button; auto-refreshes after a fill).
- **Terminal / VPS** — `npm run portfolio` (or `npm run portfolio -- 0xADDRESS` for any address).

Notes: tokens with no liquidity path to WETH show as *unquotable* rather than 0. PNL only
covers buys made by this sniper — manual trades and airdrops have no cost basis. Holdings
enumeration uses `alchemy_getTokenBalances` when an Alchemy key is set; without one it
falls back to checking only tokens the sniper has bought.

## Snipe by contract address (recommended when you know the CA)

The target field takes **either a ticker or a contract address**:

```bash
npm run snipe -- --ticker PEPE --amount 0.01                              # ticker
npm run snipe -- --ticker 0xC05e8894bF585862b7Cf2e1363c46E7546d37139 --amount 0.01   # exact CA
```

An address is **unique and cannot be spoofed**, which removes the single biggest risk in
ticker sniping: copycats deploying the same symbol to catch snipers (duplicates are
rampant — `$HEARING` appeared three times in one 70-second sample). If you have the CA
ahead of launch, always prefer it.

Address mode works across **all three venues** (v3, v4, Virtuals) and:

- **Pre-arms on a contract that doesn't exist yet** — the usual case for a pre-announced CA.
- **Fires immediately if the token is already live.** A pool emits its creation event once,
  so arming after launch would otherwise wait forever; the sniper checks the factory across
  fee tiers at arm time and buys straight away if a pool already exists.
- **Ignores the launchpad filter** (announced in the log) — the CA already identifies the
  token uniquely, so a filter could only cause a miss if it launches somewhere unexpected.

The app shows which mode you're in as you type: `#` and a green confirmation for an
address, `$` and a warning about copycats for a ticker.

## Launchpad coverage (Pons, Virtuals, and any v3 launch)

**Pons** — the chain's #1 launchpad (`PonsLaunchFactory`
`0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`) — needs no special support: its
`launchToken` call creates the pool on the **same UniswapV3Factory this bot already
watches**, so Pons launches are detected like any other. Verified by simulating a real buy
of a live Pons token through the executor path (quotable, 0% tax, succeeds), and by live
detection: **31 of 32 launches** seen in a 70-second window were Pons.

### Launchpad filter

By default a snipe accepts a matching ticker from **any** launch. To restrict it, pick a
launchpad — dropdown in the app, or headless:

```bash
npm run snipe -- --ticker PEPE --amount 0.01 --pons          # Pons launches only
npm run snipe -- --ticker PEPE --launchpad virtuals          # Virtuals only
npm run snipe -- --ticker PEPE --launchpad pons,padB         # either of two pads
```

Known launchpads (`config.json → launchpads`), found by tallying live launch traffic:

| Key | Launchpad | Share of live sample |
| --- | --- | --- |
| `pons` | **Pons** (`PonsLaunchFactory`) — confirmed | ~76% |
| `letscash` | **letscash.fun** — confirmed (Uniswap **v4**) | v4 venue |
| `padB` | Launchpad B (`0x1fae…4ecb`, selector `0x026f2bf0`) — brand unconfirmed | ~18% |
| `padC` | Launchpad C (`deployToken`) — brand unconfirmed | low |
| `padD` | Launchpad D (`newTokenV6`) — brand unconfirmed | low |
| `virtuals` | **Virtuals** (BondingV5) — confirmed, separate venue | n/a |

Only `pons` and `virtuals` are confirmed brands (named and verified on the explorer). The
others were identified purely by on-chain activity — their addresses and launch selectors
are verified, but their public names are not, so they carry neutral labels. Rename them in
`config.json` as you identify them; the UI dropdown is built from that file, so new or
renamed entries appear automatically.

Measured live: **93% of launches attributed** to a known launchpad in **38–70 ms**. The
unattributed remainder were direct `NonfungiblePositionManager` pool creations — i.e. not
launchpad launches at all, correctly left unmatched.

Attribution comes from the launch transaction's receipt — both the tx target and every
emitting log address, so a launch routed through an aggregator or multicall still resolves
correctly. That receipt is the same one the liquidity gate already needs, so **the filter
adds no latency** (measured 44–67 ms for filter + liquidity gate combined). Rejected
launches cost nothing and leave the snipe armed for the real one.

Known launchpads live in `config.json → launchpads`; add more by dropping in their factory
address. Verified live: 8/8 Pons launches correctly identified, and a token from a rival
launchpad (`newTokenV6` on a different proxy) correctly rejected.

**Pons launches are atomic** — measured across 20 consecutive live launches, every one
minted LP in the *same transaction* that created the pool. So a detected Pons pool is
tradeable immediately.

**Beware the RPC state lag.** On 11 of those 20, an `eth_call` to the pool's `liquidity()`
still returned **0 for several seconds** (8 s+) after the mint was already final in the
receipt — the node's state view lags the chain. Naively waiting for `liquidity()` would
hand every competitor an 8-second head start. So the liquidity gate races two proofs and
takes whichever answers first:

1. the creating tx's **receipt containing a `Mint`** (atomic launch — instant, lag-immune), or
2. a live **`liquidity()`** read (covers pools genuinely funded in a later tx).

Measured over live launches: the gate now clears in **~137 ms average** (max 297 ms).

If a pool really is created empty (deferred LP — a pattern other launchpads use), the match
is **held open** instead of abandoned: a WS subscription on that pool's `Mint` event fires
the instant LP lands, with a `liquidity()` poll backstop, up to `liquidityWatch.maxWaitMs`
(30 min). A v3 pool emits `PoolCreated` exactly once, so abandoning it would lose the token
permanently.

⚠ This chain's Uniswap v3 fork emits a **nonstandard `Mint` topic** (ends `…d0bde`, not
upstream's `…d0bae`). Code that watches for liquidity must use the fork's topic.

## Virtuals launchpad + TAX WATCH

The sniper watches **three venues** while armed:

1. **Uniswap v3** — classic new-pool detection (as before).
2. **Uniswap v4** (`--no-v4` to disable). v4 pools live inside a singleton `PoolManager`
   and never emit `PoolCreated` on the v3 factory, so they need their own listener on the
   PoolManager's `Initialize` event — without it these launches are entirely invisible.
   **letscash.fun launches here**: its factory deploys the token, creates and seeds the v4
   pool and locks liquidity in one transaction, with a hook that takes fees in ETH.
   v4 pools trade **native ETH** (no WETH wrapping) and are bought via the UniversalRouter
   `V4_SWAP` command. Note: v4 has no v3 quoter, so the honeypot gate and slippage ladder
   don't apply — v4 buys go out with min-out 0 and the log says so.
3. **The Virtuals Protocol launchpad** (BondingV5 on Robinhood Chain, watched by default;
   `--no-virtuals` / config `virtuals.enabled` to disable). Agent launches are detected at
   `PreLaunched` (announced in the log) and bought the moment `Launched` opens trading.
   Bonding-stage buys are paid in VIRTUAL, so the bot converts your ETH budget to VIRTUAL
   and approves the router **at arm time** — the actual snipe is a single `Bonding.buy` tx.
   If you disarm, the VIRTUAL stays in your wallet (swap it back manually if you want ETH).

**TAX WATCH** (on by default; checkbox in the app / `--no-tax-watch` headless): many
launches open with an anti-sniper tax designed to punish instant apes. With tax watch on,
a matched token is **not** bought while the tax is hot:

- **Virtuals tokens**: reads `FRouter.hasAntiSniperTax(pair)` on-chain — the same flag
  graduation waits on — and fires the second it flips off.
- **DEX tokens**: simulates the real buy via `eth_simulateV1` every `taxWatch.checkMs`
  (2s) and measures the effective transfer tax (tokens actually received vs. quoted);
  fires when it drops to `taxWatch.maxTaxPct` (default 5%) or below.
- Gives up after `taxWatch.maxWaitMs` (default 30 min) and goes back to listening.

⚠ This chain's UniversalRouter is a **fork**: `V3_SWAP_EXACT_IN` takes a 6th field
(`uint256[] minHopPriceX36`). The executors encode it (empty = skip per-hop checks).
Standard Uniswap UR encodings revert with `SliceOutOfBounds` here.

## Smart slippage

A fixed slippage % is a blind guess at launch. With **SMART slippage** (on by default —
checkbox in the app, `--no-smart` to disable headless) the buy starts at *your* slippage
and only widens when it fails **on a price check** (min-out revert), stepping
`x widenFactor` up to `smartSlippage.maxPct` (defaults: 15% → 30% → 50% cap). Calm launch:
you pay the tight price. Chaotic launch: you still get filled, never beyond the cap.
Non-price failures (insufficient funds, gas, nonce, RPC) are **never** retried. Raw mode
ignores this entirely (min-out is 0 there).

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
