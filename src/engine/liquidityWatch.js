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

// Inspect the pool-creating transaction ONCE and derive everything we need from
// that single receipt fetch:
//
// - `minted`: did this tx also mint liquidity? Most launchpads (Pons included)
//   are atomic: token + pool + LP in one tx. The receipt proves the LP exists
//   and is available IMMEDIATELY — whereas an eth_call to liquidity() can read 0
//   for seconds afterwards while the RPC's state catches up (measured 8s+ live).
// - `launchpad`: which contract drove the launch, so a snipe can filter by it.
//   Checked via the tx target AND the emitting log addresses, so a launch routed
//   through an aggregator or multicall is still attributed correctly.
//
// Deriving both from one call keeps the launchpad filter latency-free.
export async function inspectLaunchTx(publicClient, txHash) {
  if (!txHash) return { minted: false, launchpad: null, addresses: [] };
  try {
    const rec = await publicClient.getTransactionReceipt({ hash: txHash });
    const addresses = new Set();
    if (rec.to) addresses.add(rec.to.toLowerCase());
    for (const l of rec.logs || []) if (l.address) addresses.add(l.address.toLowerCase());
    return {
      minted: (rec.logs || []).some((l) => l.topics?.[0] === MINT_TOPIC),
      launchpad: rec.to ? rec.to.toLowerCase() : null,
      addresses: [...addresses],
      logs: rec.logs || [] // callers (e.g. v4) may need other liquidity proofs
    };
  } catch {
    return { minted: false, launchpad: null, addresses: [], logs: [] };
  }
}

// Back-compat helper.
export async function mintedInTx(publicClient, txHash) {
  return (await inspectLaunchTx(publicClient, txHash)).minted;
}

// Parse a launchpad filter into config entries. Accepts "any", a single key,
// or a comma-separated list ("pons,padB"). Unknown keys are dropped rather than
// silently blocking everything.
export function parseLaunchpads(cfg, which) {
  if (!which || which === 'any') return [];
  const pads = cfg.launchpads || {};
  return String(which)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => (pads[k] ? { key: k, ...pads[k] } : null))
    .filter((p) => p && p.address);
}

// Does this launch belong to any of the selected launchpads?
export function matchesLaunchpad(cfg, which, info) {
  const wanted = parseLaunchpads(cfg, which);
  if (!wanted.length) return true; // "any", or nothing resolvable
  const seen = info?.addresses || [];
  return wanted.some((p) => seen.includes(String(p.address).toLowerCase()));
}

// Human-readable name(s) for logging.
export function launchpadLabel(cfg, which) {
  const wanted = parseLaunchpads(cfg, which);
  return wanted.length ? wanted.map((p) => p.name || p.key).join(' / ') : String(which);
}

// Resolve as soon as the pool holds liquidity. Returns { ready, reason }.
// Uses a WS subscription on the pool's Mint event for instant reaction, with a
// polling backstop so a dropped socket can't make us miss the fill.
export async function waitForLiquidity({ httpClient, wsClient }, cfg, pool, { log, shouldAbort, launchInfo } = {}) {
  if (!pool) return { ready: true, reason: 'no pool address to check' };

  // Fast path. Two independent proofs of liquidity; take whichever holds:
  //   - the creating tx's receipt containing a Mint (atomic launch — instant,
  //     immune to state lag; already fetched for the launchpad filter)
  //   - a live liquidity() read (covers pools funded in a later tx)
  // Checking only liquidity() would stall an atomic snipe for seconds while the
  // RPC catches up, which on an FCFS chain is the whole race.
  if (launchInfo?.minted) return { ready: true, reason: 'LP minted in the launch tx' };

  // Uniswap v4 pools have no per-pool contract — `pool` is a bytes32 poolId, so
  // there is nothing to call liquidity() on. If the launch tx didn't prove
  // liquidity above, say so rather than polling an address that doesn't exist.
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(pool))) {
    return { ready: true, reason: 'v4 pool — liquidity not pre-verifiable (proceeding)' };
  }

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
