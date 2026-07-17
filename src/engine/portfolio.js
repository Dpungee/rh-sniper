// Portfolio view: what the wallet holds, what it's worth in ETH right now, and
// unrealized PNL vs. what the sniper paid (from the trades.json fill journal).
//
// Holdings enumeration prefers Alchemy's alchemy_getTokenBalances (verified
// supported on Robinhood Chain). Without an Alchemy endpoint it falls back to
// balanceOf() on every token the sniper has ever bought — complete for sniper
// activity, blind to airdrops/manual buys.
//
// Valuation: QuoterV2 quoteExactInputSingle(token -> WETH) for the full
// balance. Fresh/illiquid tokens may not quote — value shows as unknown, not 0.

import { formatEther, getContract } from 'viem';
import { ERC20_ABI, UNIV3_QUOTER_ABI } from './abis.js';
import { loadTrades } from './trades.js';
import { resolveEndpoints } from './chain.js';

const FEE_TIERS = [10000, 3000, 500]; // meme pools are almost always 1%; try it first

async function alchemyTokenBalances(cfg, address) {
  const { http, isPrivate } = resolveEndpoints(cfg);
  if (!isPrivate) return null; // public RPC doesn't support alchemy_*
  const res = await fetch(http, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances', params: [address, 'erc20'] })
  });
  const json = await res.json();
  if (json.error) return null;
  return (json.result?.tokenBalances || [])
    .map((t) => ({ token: t.contractAddress, balance: BigInt(t.tokenBalance || '0x0') }))
    .filter((t) => t.balance > 0n);
}

async function fallbackBalances(publicClient, address) {
  const tokens = [...new Set(loadTrades().map((t) => t.token.toLowerCase()))];
  const out = [];
  await Promise.all(tokens.map(async (token) => {
    try {
      const c = getContract({ address: token, abi: ERC20_ABI, client: publicClient });
      const bal = await c.read.balanceOf([address]);
      if (bal > 0n) out.push({ token, balance: bal });
    } catch { /* token unreadable — skip */ }
  }));
  return out;
}

async function quoteToEth(publicClient, cfg, token, balance, feeTierHint) {
  const quoter = cfg.dex.quoter;
  if (!quoter || /^0x0+$/.test(quoter) || balance === 0n) return null;
  const q = getContract({ address: quoter, abi: UNIV3_QUOTER_ABI, client: publicClient });
  const tiers = feeTierHint ? [feeTierHint, ...FEE_TIERS.filter((f) => f !== feeTierHint)] : FEE_TIERS;
  for (const fee of tiers) {
    try {
      const r = await q.simulate.quoteExactInputSingle([
        { tokenIn: token, tokenOut: cfg.chain.wrappedNative, amountIn: balance, fee, sqrtPriceLimitX96: 0n }
      ]);
      return r.result[0]; // wei
    } catch { /* no pool at this tier — try next */ }
  }
  return null; // unquotable (no liquidity path to WETH)
}

export async function getPortfolio(publicClient, cfg, address) {
  const wethAddr = cfg.chain.wrappedNative.toLowerCase();
  const trades = loadTrades();

  const [ethBalance, balances] = await Promise.all([
    publicClient.getBalance({ address }),
    alchemyTokenBalances(cfg, address).then((r) => r ?? fallbackBalances(publicClient, address))
  ]);

  // Cost basis + fee-tier hints per token, from the fill journal.
  const cost = new Map(); // token -> { ethIn: bigint, symbol, feeTier, fills }
  for (const t of trades) {
    const k = t.token.toLowerCase();
    const c = cost.get(k) || { ethIn: 0n, symbol: t.symbol, feeTier: t.feeTier, fills: 0 };
    c.ethIn += BigInt(t.ethIn);
    c.fills += 1;
    cost.set(k, c);
  }

  const holdings = await Promise.all(balances.map(async ({ token, balance }) => {
    const k = token.toLowerCase();
    const basis = cost.get(k);
    let symbol = basis?.symbol ?? '?';
    let decimals = 18;
    try {
      const c = getContract({ address: token, abi: ERC20_ABI, client: publicClient });
      const [s, d] = await Promise.all([c.read.symbol(), c.read.decimals()]);
      symbol = String(s); decimals = Number(d);
    } catch { /* keep journal symbol */ }

    const isWeth = k === wethAddr;
    const valueWei = isWeth ? balance : await quoteToEth(publicClient, cfg, token, balance, basis?.feeTier);
    const costWei = basis?.ethIn ?? null;

    return {
      token,
      symbol,
      decimals,
      balance: balance.toString(),
      balanceFmt: Number(balance) / 10 ** decimals,
      valueEth: valueWei === null ? null : Number(formatEther(valueWei)),
      costEth: costWei === null ? null : Number(formatEther(costWei)),
      pnlEth: valueWei !== null && costWei !== null ? Number(formatEther(valueWei - costWei)) : null,
      pnlPct: valueWei !== null && costWei !== null && costWei > 0n
        ? Number(((valueWei - costWei) * 10000n) / costWei) / 100
        : null,
      fills: basis?.fills ?? 0
    };
  }));

  holdings.sort((a, b) => (b.valueEth ?? -1) - (a.valueEth ?? -1));

  const totals = holdings.reduce((s, h) => {
    if (h.valueEth !== null) s.valueEth += h.valueEth;
    if (h.costEth !== null && h.valueEth !== null) { s.costEth += h.costEth; s.pnlEth += h.pnlEth; }
    return s;
  }, { valueEth: 0, costEth: 0, pnlEth: 0 });

  return {
    address,
    ethBalance: Number(formatEther(ethBalance)),
    holdings,
    totals,
    tradesCount: trades.length,
    source: 'onchain'
  };
}
