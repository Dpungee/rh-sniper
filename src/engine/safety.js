// Optional anti-rug / honeypot gate. DISABLED by default (raw-speed mode).
// When enabled it simulates a buy and an immediate sell; if the sell reverts or
// the effective tax is above a threshold, it blocks the snipe.
//
// This is intentionally lightweight and best-effort. It is NOT a guarantee of
// safety — nothing makes meme-coin sniping safe.

import { getContract, parseEther } from 'viem';
import { UNIV3_QUOTER_ABI } from './abis.js';

export async function passesSafety(publicClient, cfg, tokenOut, feeTier, amountEth) {
  if (!cfg.safety?.enabled) return { ok: true, reason: 'safety-disabled' };

  const quoter = cfg.dex.quoter;
  if (!quoter || /^0x0+$/.test(quoter)) return { ok: true, reason: 'no-quoter-cannot-check' };

  try {
    const q = getContract({ address: quoter, abi: UNIV3_QUOTER_ABI, client: publicClient });
    const amountIn = parseEther(String(amountEth));

    // Quote buy: WETH -> token
    const buy = await q.simulate.quoteExactInputSingle([
      { tokenIn: cfg.chain.wrappedNative, tokenOut, amountIn, fee: feeTier, sqrtPriceLimitX96: 0n }
    ]);
    const tokensOut = buy.result[0];
    if (tokensOut === 0n) return { ok: false, reason: 'buy-returns-zero' };

    // Quote sell: token -> WETH. If this reverts, it's a likely honeypot.
    const sell = await q.simulate.quoteExactInputSingle([
      { tokenIn: tokenOut, tokenOut: cfg.chain.wrappedNative, amountIn: tokensOut, fee: feeTier, sqrtPriceLimitX96: 0n }
    ]);
    const ethBack = sell.result[0];

    const roundTripPct = Number((ethBack * 10000n) / amountIn) / 100; // % of input recovered
    if (roundTripPct < 50) return { ok: false, reason: `high-tax-or-honeypot (${roundTripPct.toFixed(1)}% round-trip)` };

    return { ok: true, reason: `round-trip ${roundTripPct.toFixed(1)}%` };
  } catch (e) {
    return { ok: false, reason: 'sell-simulation-reverted (likely honeypot)' };
  }
}
