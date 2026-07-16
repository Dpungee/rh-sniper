# RH Chain Sniper

A desktop meme-coin sniper for **Robinhood Chain** (Ethereum L2, chain ID `4663`).
You give it a **ticker**, an **exact ETH amount**, and your own **gas** and **slippage** — it
watches the DEX for new pairs and fires a buy the instant a matching token launches.

Keys stay on your machine (encrypted local keystore). It talks directly to the chain's
public RPC and DEX router — it is **not** connected to your Robinhood account.

---

## ⚠️ Read this first

- **Ticker sniping is not safe by design.** On-chain, symbols are not unique — scammers
  spam duplicate tickers and honeypots to catch snipers. This build runs in **raw-speed
  mode with the safety gate OFF** (your choice). A honeypot filter exists in `src/engine/safety.js`;
  flip `safety.enabled` to `true` in `config.json` to use it.
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

Import your key (UI import screen or `npm run keystore import`), unlock, enter a ticker,
set amount/gas/slippage, hit **SNIPE**. The app arms, listens, and fires on the first match.

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
