// Headless, read-only sanity check. Confirms we can reach Robinhood Chain,
// reads chain id + latest block, and (if a factory is configured) subscribes to
// new-pair events for a short window. NEVER sends a transaction.

import { loadConfig, makeHttpPublicClient, makeWsClient } from '../src/engine/chain.js';
import { startPairListener } from '../src/engine/discovery.js';

const WATCH_SECONDS = Number(process.argv[2] || 30);

async function main(){
  const cfg = loadConfig();
  console.log(`\n== RH Chain Sniper — dry run ==`);
  console.log(`RPC:   ${cfg.chain.rpcHttp}`);

  const http = makeHttpPublicClient(cfg);
  const id = await http.getChainId();
  const block = await http.getBlockNumber();
  const gas = await http.getGasPrice();
  console.log(`ChainId reported: ${id} (config: ${cfg.chain.chainId}) ${id === cfg.chain.chainId ? 'OK' : 'MISMATCH'}`);
  console.log(`Latest block:     ${block}`);
  console.log(`Gas price:        ${Number(gas)/1e9} gwei`);

  const factorySet = !/^0x0+$/.test(cfg.dex.factory);
  if (!factorySet){
    console.log(`\nFactory address not set in config.json — skipping live pair listener.`);
    console.log(`Fill dex.factory (and router/quoter) to enable sniping.\n`);
    return;
  }

  const ws = makeWsClient(cfg);
  console.log(`\nWatching ${cfg.dex.kind} factory ${cfg.dex.factory} for ${WATCH_SECONDS}s (${ws ? 'live WS + polling' : 'polling — no private WS endpoint'})...`);
  let count = 0;
  const unwatch = startPairListener({ http, ws }, cfg,
    (t)=>{ count++; console.log(`  NEW PAIR  $${t.symbol}  token=${t.token}  pool=${t.pool}  fee=${t.feeTier}`); },
    (e)=> console.log(`  listener hiccup (auto-retrying): ${e.shortMessage || e.message}`),
    (level, msg)=> console.log(`  [${level}] ${msg}`)
  );
  await new Promise(r=>setTimeout(r, WATCH_SECONDS*1000));
  try{ unwatch(); }catch{}
  console.log(`\nDone. Saw ${count} new pair(s) in ${WATCH_SECONDS}s.\n`);
  process.exit(0);
}
main().catch(e=>{ console.error('DRY RUN FAILED:', e.shortMessage || e.message); process.exit(1); });
