// Resilient new-pair listener. From the moment a snipe is armed until it is
// cancelled or fires, this must NEVER go deaf. It is built to survive RPC
// hiccups, WebSocket drops, and machine sleep/wake without missing a launch.
//
// Design:
//   • Backbone = HTTP log polling. Each tick scans the factory for PoolCreated
//     events from `fromBlock` to the latest block, then advances `fromBlock`.
//     Because `fromBlock` persists across ticks, any gap (network blip, sleep)
//     is caught up on the next successful scan — no launch slips through.
//     This works on the rate-limited public RPC, which cannot do eth_subscribe.
//   • Accelerator = optional WebSocket subscription (private endpoints only).
//     Lower latency, but treated as best-effort; the poller is the guarantee.
//   • Dedup by pool address so the WS and poll paths never double-fire.
//   • The loop only ends when the returned stop() is called. Errors back off
//     and retry — they do not kill the listener.

import { getContract } from 'viem';
import { UNIV3_FACTORY_ABI, UNIV2_FACTORY_ABI, ERC20_ABI } from './abis.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The token in a new pair that ISN'T the base asset (WETH) is the "new" token.
function pickNewToken(token0, token1, wrappedNative) {
  const w = wrappedNative.toLowerCase();
  if (token0.toLowerCase() === w) return token1;
  if (token1.toLowerCase() === w) return token0;
  // Neither side is WETH (e.g. paired vs a stable) — default to token1.
  return token1;
}

// clients: { http, ws }  — http is REQUIRED (the reliable backbone);
//                          ws is OPTIONAL (a low-latency accelerator).
// log:     optional (level, msg) sink for heartbeat/reconnect breadcrumbs.
export function startPairListener(clients, cfg, onNewToken, onError, log) {
  const httpClient = clients.http || clients; // tolerate an old-style single client
  const wsClient = clients.ws || null;

  const kind = cfg.dex.kind;
  const factory = cfg.dex.factory;
  const wrapped = cfg.chain.wrappedNative;
  const abi = kind === 'uniswap-v2' ? UNIV2_FACTORY_ABI : UNIV3_FACTORY_ABI;
  const eventName = kind === 'uniswap-v2' ? 'PairCreated' : 'PoolCreated';
  const eventItem = abi.find((x) => x.type === 'event' && x.name === eventName);

  const pollMs = Number(cfg.discovery?.pollMs ?? 3000);
  const heartbeatMs = Number(cfg.discovery?.heartbeatMs ?? 20000);
  const maxSpan = BigInt(cfg.discovery?.maxBlockSpan ?? 2000); // cap getLogs range per scan

  const seen = new Set(); // pool addresses already emitted (dedup across ws+poll)
  let stopped = false;
  let fromBlock = null; // next block to scan from
  let lastHeartbeat = 0;
  let consecutiveErrors = 0;
  let unwatchWs = null;
  // Adaptive getLogs span. Some providers cap the block range per request
  // (Alchemy free tier: 10 blocks). We start optimistic and shrink when the
  // RPC rejects the range, so the cursor always advances and never wedges.
  let span = maxSpan;

  function isRangeError(e) {
    const m = `${e?.message || ''} ${e?.details || ''} ${e?.cause?.message || ''}`.toLowerCase();
    return m.includes('block range') || m.includes('range should work') ||
           m.includes('not a valid request') || m.includes('query returned more than');
  }

  async function handleLog(l) {
    const { token0, token1 } = l.args;
    const poolOrPair = l.args.pool ?? l.args.pair;
    if (!poolOrPair) return;
    const key = String(poolOrPair).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key); // synchronous claim before any await → dedup is race-free

    const feeTier = l.args.fee ?? cfg.dex.defaultFeeTier;
    const tokenAddr = pickNewToken(token0, token1, wrapped);

    // Read ONLY the symbol — that's all ticker matching needs. `decimals` used to
    // be read here too, but nothing downstream consumes it, and on an FCFS
    // sequencer chain every round-trip between detection and firing is latency
    // you can't get back. One read, not two.
    let symbol = '?';
    try {
      const token = getContract({ address: tokenAddr, abi: ERC20_ABI, client: httpClient });
      symbol = await token.read.symbol();
    } catch { /* token may not implement symbol(); leave as ? */ }

    onNewToken({
      token: tokenAddr,
      symbol: String(symbol),
      pool: poolOrPair,
      feeTier: Number(feeTier),
      token0,
      token1,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber
    });
  }

  // Process a batch of logs concurrently. When several pools land in one scan,
  // your ticker might be the last one — serial symbol reads would make you wait
  // on every unrelated token first. Parallel = matched as fast as its own read.
  function handleLogs(logs) {
    return Promise.all(logs.map((l) => handleLog(l).catch((e) => onError?.(e))));
  }

  function maybeHeartbeat(block) {
    const now = Date.now();
    if (now - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = now;
      log?.('debug', `listening… scanned to block ${block}${wsClient ? ' (ws+poll)' : ' (poll)'}`);
    }
  }

  async function pollOnce() {
    const latest = await httpClient.getBlockNumber();
    // First tick: start from *now*. We snipe launches that happen after arming,
    // not historical pairs, so we don't backfill the chain's whole history.
    if (fromBlock === null) fromBlock = latest + 1n;
    if (latest < fromBlock) { maybeHeartbeat(latest); return; }

    // Chunk through [fromBlock, latest] with the adaptive span so a backlog
    // (sleep, outage) is fully caught up. Bounded per tick to stay polite.
    for (let chunk = 0; chunk < 50 && fromBlock <= latest && !stopped; chunk++) {
      let toBlock = latest;
      if (toBlock - fromBlock + 1n > span) toBlock = fromBlock + span - 1n;

      let logs;
      try {
        logs = await httpClient.getLogs({ address: factory, event: eventItem, fromBlock, toBlock });
      } catch (e) {
        if (isRangeError(e) && span > 2n) {
          // Provider rejected the range — shrink and retry this window next loop.
          const newSpan = span / 2n < 2n ? 2n : span / 2n;
          log?.('debug', `provider capped getLogs range — shrinking scan window ${span} -> ${newSpan} blocks`);
          span = newSpan;
          continue;
        }
        throw e; // real error: let the outer loop back off and retry
      }

      if (stopped) return;
      await handleLogs(logs); // concurrent symbol reads
      fromBlock = toBlock + 1n; // advance the cursor only after a successful scan
    }
    consecutiveErrors = 0;
    maybeHeartbeat(fromBlock - 1n);
  }

  async function pollLoop() {
    while (!stopped) {
      try {
        await pollOnce();
        if (!stopped) await sleep(pollMs);
      } catch (e) {
        consecutiveErrors++;
        onError?.(e);
        // Exponential backoff capped at 30s so a rate-limit storm or an RPC
        // outage doesn't hammer the endpoint — but we always keep retrying.
        const backoff = Math.min(pollMs * 2 ** Math.min(consecutiveErrors, 5), 30000);
        if (!stopped) await sleep(backoff);
      }
    }
  }

  // Optional WS accelerator (private endpoints only). Best-effort: if it errors
  // or drops, the poller still guarantees delivery, so we just log and lean on it.
  function attachWs() {
    if (!wsClient) return;
    try {
      unwatchWs = wsClient.watchContractEvent({
        address: factory,
        abi,
        eventName,
        onError: (e) => { onError?.(e); },
        onLogs: async (logs) => {
          if (stopped) return;
          await handleLogs(logs); // concurrent symbol reads
        }
      });
    } catch (e) {
      onError?.(e);
    }
  }

  attachWs();
  pollLoop();

  return function stop() {
    stopped = true;
    if (unwatchWs) { try { unwatchWs(); } catch {} unwatchWs = null; }
  };
}
