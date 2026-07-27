// Liquidity watch: handle launchpads that create the pool FIRST and add LP later.
//
// Most launchpads on this chain (Pons included, verified 2026-07-27) are atomic:
// `launchToken` deploys the token, creates the pool, initializes it and mints LP
// in a single transaction, so the pool is tradeable the instant we detect it.
//
// But the deferred pattern is real (token/pool announced, liquidity seeded later),
// and a v3 pool only emits PoolCreated ONCE — so if we give up on an empty pool we
// can never re-match that token. This module holds the match open and fires the
// moment liquidity actually lands, event-driven rather than on a slow poll.
//
// ⚠ This chain's Uniswap v3 fork uses a NONSTANDARD Mint topic (see MINT_TOPIC).

import { getContract } from 'viem';

// Uniswap v3 pool events as deployed on Robinhood Chain (read off live pools —
// the Mint topic differs from upstream Uniswap in its final byte: ...d0bde).
export const MINT_TOPIC = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';
export const INITIALIZE_TOPIC = '0x98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95';

const POOL_ABI = [
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] }
];

export async function poolHasLiquidity(publicClient, pool) {
  try {
    const l = await getContract({ address: pool, abi: POOL_ABI, client: publicClient }).read.liquidity();
    return l > 0n;
  } catch {
    return false; // pool not initialized yet (or unreadable) — treat as empty
  }
}

// Resolve as soon as the pool holds liquidity. Returns { ready, reason }.
// Uses a WS subscription on the pool's Mint event for instant reaction, with a
// polling backstop so a dropped socket can't make us miss the fill.
export async function waitForLiquidity({ httpClient, wsClient }, cfg, pool, { log, shouldAbort } = {}) {
  if (!pool) return { ready: true, reason: 'no pool address to check' };

  // Fast path: the common (atomic) case — already funded, don't wait at all.
  if (await poolHasLiquidity(httpClient, pool)) return { ready: true, reason: 'pool already funded' };

  const lw = cfg.liquidityWatch || {};
  const maxWaitMs = Number(lw.maxWaitMs ?? 1800000); // 30 min
  const pollMs = Number(lw.pollMs ?? 1500);
  const deadline = Date.now() + maxWaitMs;

  log?.('info', `Pool created but EMPTY — holding the match open and watching for liquidity (up to ${Math.round(maxWaitMs / 60000)} min)...`);

  return new Promise((resolve) => {
    let done = false;
    let unwatch = null;
    let timer = null;

    const finish = (ready, reason) => {
      if (done) return;
      done = true;
      if (unwatch) { try { unwatch(); } catch {} }
      if (timer) clearTimeout(timer);
      resolve({ ready, reason });
    };

    // Instant path: the pool's own Mint event.
    if (wsClient) {
      try {
        unwatch = wsClient.watchEvent({
          address: pool,
          onError: () => { /* poll backstop covers us */ },
          onLogs: (logs) => {
            if (logs.some((l) => l.topics?.[0] === MINT_TOPIC)) finish(true, 'liquidity added (live Mint event)');
          }
        });
      } catch { /* fall back to polling only */ }
    }

    // Backstop: poll the pool's liquidity.
    const tick = async () => {
      if (done) return;
      if (shouldAbort?.()) return finish(false, 'disarmed');
      if (Date.now() > deadline) return finish(false, `no liquidity within ${Math.round(maxWaitMs / 60000)} min`);
      try {
        if (await poolHasLiquidity(httpClient, pool)) return finish(true, 'liquidity detected');
      } catch { /* transient RPC error — keep waiting */ }
      if (!done) timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, pollMs);
  });
}
