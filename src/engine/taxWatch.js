// Tax watch: for launches that open with an anti-sniper tax, wait it out and
// fire the moment the tax clears (Virtuals) or drops below your ceiling
// (generic fee-on-transfer tokens on the DEX).
//
// Two measurement paths:
// - Virtuals bonding tokens: FRouter.hasAntiSniperTax(pair) — authoritative
//   boolean straight from the launchpad (graduation itself is gated on it).
// - Uniswap v3 tokens: eth_simulateV1 (verified supported on this chain's
//   Alchemy RPC) simulates the real UniversalRouter buy from the sniper's own
//   address and compares tokens actually received (Transfer logs) against the
//   QuoterV2's pool-level quote. The gap IS the transfer tax.

import { encodeFunctionData, encodeAbiParameters, encodePacked, getContract, parseEther, numberToHex } from 'viem';
import { UNIVERSAL_ROUTER_ABI, UNIV3_QUOTER_ABI } from './abis.js';
import { antiSniperTaxActive } from './virtuals.js';
import { TRANSFER_TOPIC } from './trades.js';
import { resolveEndpoints } from './chain.js';

const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const MSG_SENDER = '0x0000000000000000000000000000000000000001';

// Measure the effective buy tax % for a v3 token: simulate the actual buy and
// compare received vs quoted. Returns { taxPct, quotable } — taxPct null when
// the pool can't be quoted yet.
export async function measureBuyTaxV3(publicClient, cfg, { account, tokenOut, feeTier, amountEth }) {
  const amountIn = parseEther(String(amountEth));

  // Pool-level expectation (no transfer tax included).
  let expected = null;
  try {
    const q = getContract({ address: cfg.dex.quoter, abi: UNIV3_QUOTER_ABI, client: publicClient });
    const r = await q.simulate.quoteExactInputSingle([
      { tokenIn: cfg.chain.wrappedNative, tokenOut, amountIn, fee: feeTier, sqrtPriceLimitX96: 0n }
    ]);
    expected = r.result[0];
  } catch { return { taxPct: null, quotable: false }; }
  if (!expected || expected === 0n) return { taxPct: null, quotable: false };

  // Simulate the real buy from the sniper's address (balance overridden so the
  // measurement works even pre-funding) and read the actual Transfer to us.
  const path = encodePacked(['address', 'uint24', 'address'], [cfg.chain.wrappedNative, feeTier, tokenOut]);
  const wrapInput = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ADDRESS_THIS, amountIn]);
  // 6-field encoding: Robinhood's UR fork appends uint256[] minHopPriceX36 (empty = skip).
  const swapInput = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
    [MSG_SENDER, amountIn, 0n, path, false, []]
  );
  const data = encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute',
    args: ['0x0b00', [wrapInput, swapInput], BigInt(Math.floor(Date.now() / 1000) + 120)]
  });

  const { http } = resolveEndpoints(cfg);
  const res = await fetch(http, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_simulateV1',
      params: [{
        blockStateCalls: [{
          stateOverrides: { [account.address]: { balance: numberToHex(amountIn * 2n) } },
          calls: [{ from: account.address, to: cfg.dex.universalRouter, value: numberToHex(amountIn), data }]
        }]
      }, 'latest']
    })
  });
  const json = await res.json();
  const call = json.result?.[0]?.calls?.[0];
  if (!call || call.status !== '0x1') return { taxPct: null, quotable: true, simFailed: true };

  const to32 = '0x' + account.address.toLowerCase().slice(2).padStart(64, '0');
  let received = 0n;
  for (const l of call.logs || []) {
    if ((l.address || '').toLowerCase() !== tokenOut.toLowerCase()) continue;
    if (l.topics?.[0] !== TRANSFER_TOPIC) continue;
    if ((l.topics?.[2] || '').toLowerCase() !== to32) continue;
    received += BigInt(l.data);
  }
  if (received >= expected) return { taxPct: 0, quotable: true };
  const taxPct = Number(((expected - received) * 10000n) / expected) / 100;
  return { taxPct, quotable: true };
}

// Wait until the launch's tax situation clears, then return { fire: true }.
// Polls every checkMs, gives up after maxWaitMs ({ fire: false, reason }).
// `shouldAbort` lets the sniper cancel the wait on disarm.
export async function waitForLowTax(publicClient, cfg, t, { account, amountEth, log, shouldAbort }) {
  const tw = cfg.taxWatch || {};
  const maxTaxPct = Number(tw.maxTaxPct ?? 5);
  const checkMs = Number(tw.checkMs ?? 2000);
  const maxWaitMs = Number(tw.maxWaitMs ?? 1800000);
  const deadline = Date.now() + maxWaitMs;
  let lastReported = null;

  while (Date.now() < deadline) {
    if (shouldAbort?.()) return { fire: false, reason: 'disarmed' };

    if (t.source === 'virtuals') {
      let active = true;
      try { active = await antiSniperTaxActive(publicClient, cfg, t.pool); }
      catch (e) { log?.('warn', `tax check failed (retrying): ${e.shortMessage || e.message}`); }
      if (!active) return { fire: true, reason: 'anti-sniper tax cleared' };
      if (lastReported !== 'active') { lastReported = 'active'; log?.('info', `$${t.symbol}: Virtuals anti-sniper tax ACTIVE — waiting for it to clear (checking every ${checkMs / 1000}s)...`); }
    } else {
      const m = await measureBuyTaxV3(publicClient, cfg, { account, tokenOut: t.token, feeTier: t.feeTier, amountEth });
      if (m.taxPct !== null && m.taxPct <= maxTaxPct) {
        return { fire: true, reason: `effective tax ${m.taxPct.toFixed(1)}% <= ${maxTaxPct}% ceiling` };
      }
      const now = m.taxPct === null ? (m.quotable ? 'sim-failed' : 'unquotable') : `${m.taxPct.toFixed(1)}%`;
      if (now !== lastReported) { lastReported = now; log?.('info', `$${t.symbol}: effective buy tax ${now} (ceiling ${maxTaxPct}%) — waiting...`); }
    }
    await new Promise((r) => setTimeout(r, checkMs));
  }
  return { fire: false, reason: `tax never cleared within ${Math.round(maxWaitMs / 60000)} min` };
}
