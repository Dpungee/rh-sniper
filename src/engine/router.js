// Pool selection. Guarantees a trade routes through the BEST pool for that
// token, not merely the first one found.
//
// Why this exists: a token can have pools at several v3 fee tiers (and/or a v4
// pool). Picking the first tier that happens to exist can route a trade through
// a thin or stale pool and get a far worse fill. This module quotes every
// candidate and picks the one that actually returns the most.
//
// Used for both buys (ETH -> token) and sells (token -> ETH).

import { getContract, parseEther } from 'viem';
import { UNIV3_FACTORY_ABI, UNIV3_QUOTER_ABI, ERC20_ABI } from './abis.js';

export const FEE_TIERS = [10000, 3000, 500, 100];

// Which v3 fee tiers actually have a pool for this token?
export async function existingPools(publicClient, cfg, token) {
  const f = getContract({ address: cfg.dex.factory, abi: UNIV3_FACTORY_ABI, client: publicClient });
  const found = [];
  await Promise.all(FEE_TIERS.map(async (fee) => {
    try {
      const pool = await f.read.getPool([token, cfg.chain.wrappedNative, fee]);
      if (pool && !/^0x0+$/.test(pool)) found.push({ fee, pool });
    } catch { /* tier unavailable */ }
  }));
  return found.sort((a, b) => FEE_TIERS.indexOf(a.fee) - FEE_TIERS.indexOf(b.fee));
}

// Quote one direction through a specific fee tier. Returns null if unquotable
// (fresh pool with no liquidity yet, or no pool at that tier).
async function quote(publicClient, cfg, { tokenIn, tokenOut, amountIn, fee }) {
  try {
    const q = getContract({ address: cfg.dex.quoter, abi: UNIV3_QUOTER_ABI, client: publicClient });
    const r = await q.simulate.quoteExactInputSingle([
      { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }
    ]);
    const out = r.result[0];
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

// Pick the pool that returns the most for this trade.
//
// `preferFee` (the tier a launch was detected on) is used as a tie-break and as
// the fallback when NOTHING can be quoted — which is the normal case at the
// moment of launch, since a brand-new pool often can't be quoted yet. In that
// situation the launch pool is by definition the right one.
export async function bestPool(publicClient, cfg, { tokenIn, tokenOut, amountIn, preferFee = null, candidates = null }) {
  const tiers = candidates ?? FEE_TIERS;
  const results = await Promise.all(tiers.map(async (fee) => ({
    fee, out: await quote(publicClient, cfg, { tokenIn, tokenOut, amountIn, fee })
  })));

  const quotable = results.filter((r) => r.out !== null);
  if (!quotable.length) {
    return { fee: preferFee ?? cfg.dex.defaultFeeTier, out: null, quoted: false, reason: 'nothing quotable — using launch/default tier' };
  }

  quotable.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  const best = quotable[0];
  const alternatives = quotable.slice(1);

  // Only mention a switch when it actually changes the outcome.
  const switched = preferFee != null && best.fee !== preferFee;
  return {
    fee: best.fee,
    out: best.out,
    quoted: true,
    switched,
    alternatives,
    reason: switched
      ? `fee ${best.fee} beats detected tier ${preferFee}`
      : `fee ${best.fee}${alternatives.length ? ` (best of ${quotable.length} pools)` : ''}`
  };
}

// Convenience: best pool for spending ETH on a token.
export function bestBuyPool(publicClient, cfg, { token, amountEth, preferFee = null }) {
  return bestPool(publicClient, cfg, {
    tokenIn: cfg.chain.wrappedNative,
    tokenOut: token,
    amountIn: parseEther(String(amountEth)),
    preferFee
  });
}

// Convenience: best pool for selling a token amount back to ETH.
export function bestSellPool(publicClient, cfg, { token, amountRaw, preferFee = null }) {
  return bestPool(publicClient, cfg, {
    tokenIn: token,
    tokenOut: cfg.chain.wrappedNative,
    amountIn: amountRaw,
    preferFee
  });
}

// Token balance helper (used by percentage sells).
export async function tokenBalance(publicClient, token, owner) {
  const t = getContract({ address: token, abi: ERC20_ABI, client: publicClient });
  const [bal, decimals] = await Promise.all([t.read.balanceOf([owner]), t.read.decimals().catch(() => 18)]);
  return { raw: bal, decimals: Number(decimals) };
}
