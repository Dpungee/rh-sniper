// Virtuals Protocol launchpad support for Robinhood Chain.
//
// Discovered on-chain 2026-07-18 (see CLAUDE.md "Virtuals launchpad"):
// - Launches happen via BondingV5 proxy `preLaunch` -> emits PreLaunched(token, pair, ...)
//   then `launch` -> emits Launched(token, pair, ...). Bonding-stage ("UNDERGRAD")
//   tokens trade against VIRTUAL through Bonding.buy/sell — NOT on Uniswap v3.
// - Anti-sniper tax is a first-class launch param (`antiSniperTaxType_`). Its live
//   state is readable: FRouter.hasAntiSniperTax(pair) — graduation itself is gated
//   on it turning false, so it is THE authoritative "taxes cleared" signal.
// - Buys are paid in VIRTUAL (FRouter.assetToken() == VIRTUAL). We pre-fund
//   VIRTUAL at ARM time (ETH -> WETH -> pair swap -> approve), so the actual
//   snipe is a single Bonding.buy() tx — FCFS latency stays minimal.

import { getContract, parseEther, parseGwei, formatEther } from 'viem';
import { ERC20_ABI } from './abis.js';

export const BONDING_ABI = [
  { type: 'function', name: 'buy', stateMutability: 'payable', inputs: [
    { name: 'amountIn_', type: 'uint256' }, { name: 'tokenAddress_', type: 'address' },
    { name: 'amountOutMin_', type: 'uint256' }, { name: 'deadline_', type: 'uint256' }
  ], outputs: [{ type: 'bool' }] }
];

export const FROUTER_ABI = [
  { type: 'function', name: 'hasAntiSniperTax', stateMutability: 'view',
    inputs: [{ name: 'pairAddress', type: 'address' }], outputs: [{ type: 'bool' }] }
];

const WETH9_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }
];

const V2_PAIR_ABI = [
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [
    { name: 'reserve0', type: 'uint112' }, { name: 'reserve1', type: 'uint112' }, { name: 'blockTimestampLast', type: 'uint32' }
  ] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'swap', stateMutability: 'nonpayable', inputs: [
    { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes' }
  ], outputs: [] }
];

// Event topics observed on the live BondingV5 proxy (verified against real
// preLaunch/launch transactions — see CLAUDE.md for the sample tx hashes).
export const TOPIC_PRELAUNCHED = '0xb9ee8aa6d909a3efd0bf1b0bc2bde7f998f7ad30178b0d45f9227f5382cebc8f';
export const TOPIC_LAUNCHED = '0x6ed5dc54f1333f448f2cdf7a6efc675343f880035d6f647fb7f6e9cbf8959718';

// ---- Detection ----------------------------------------------------------
// Watches the Bonding proxy for PreLaunched/Launched. Emits the same candidate
// shape as the Uniswap discovery so the resolver/sniper treat both alike.
export function startVirtualsListener({ httpClient, wsClient }, cfg, onNewToken, onError, log) {
  const vcfg = cfg.virtuals;
  const bonding = vcfg.bonding;
  const seen = new Set();
  let stopped = false;
  let fromBlock = null;
  let unwatchWs = null;

  async function handleLog(l) {
    const phase = l.topics?.[0] === TOPIC_LAUNCHED ? 'launched'
      : l.topics?.[0] === TOPIC_PRELAUNCHED ? 'prelaunch' : null;
    if (!phase) return;
    const token = '0x' + (l.topics?.[1] || '').slice(26);
    const pair = '0x' + (l.topics?.[2] || '').slice(26);
    if (token.length !== 42) return;
    const key = token.toLowerCase() + ':' + phase;
    if (seen.has(key)) return;
    seen.add(key);

    let symbol = '?';
    try {
      const t = getContract({ address: token, abi: ERC20_ABI, client: httpClient });
      symbol = String(await t.read.symbol());
    } catch { /* leave ? */ }

    onNewToken({
      source: 'virtuals',
      phase, // 'prelaunch' (created, trading may start later) | 'launched' (tradeable now)
      token,
      symbol,
      pool: pair,
      feeTier: null,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber
    });
  }

  async function pollOnce() {
    const latest = await httpClient.getBlockNumber();
    if (fromBlock === null) fromBlock = latest + 1n;
    if (latest < fromBlock) return;
    // Bonding proxy emits few logs; scan in provider-safe chunks (Alchemy free
    // tier caps ranges at 10 blocks — mirror discovery.js's approach, fixed 7).
    for (let i = 0; i < 60 && fromBlock <= latest && !stopped; i++) {
      const toBlock = fromBlock + 6n > latest ? latest : fromBlock + 6n;
      const logs = await httpClient.getLogs({ address: bonding, fromBlock, toBlock });
      for (const l of logs) { if (stopped) return; await handleLog(l).catch((e) => onError?.(e)); }
      fromBlock = toBlock + 1n;
    }
  }

  const pollMs = Number(cfg.discovery?.pollMs ?? 3000);
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    try { await pollOnce(); } catch (e) { onError?.(e); }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };
  tick();

  if (wsClient) {
    try {
      unwatchWs = wsClient.watchEvent({
        address: bonding,
        onError: (e) => onError?.(e),
        onLogs: async (logs) => { for (const l of logs) { if (stopped) return; await handleLog(l).catch((e) => onError?.(e)); } }
      });
      log?.('debug', 'Virtuals launchpad listener active (ws+poll)');
    } catch { log?.('debug', 'Virtuals launchpad listener active (poll)'); }
  } else {
    log?.('debug', 'Virtuals launchpad listener active (poll)');
  }

  return () => { stopped = true; if (timer) clearTimeout(timer); if (unwatchWs) { try { unwatchWs(); } catch {} } };
}

// ---- Anti-sniper tax state ----------------------------------------------
export async function antiSniperTaxActive(publicClient, cfg, pair) {
  const r = getContract({ address: cfg.virtuals.frouter, abi: FROUTER_ABI, client: publicClient });
  return r.read.hasAntiSniperTax([pair]);
}

// ---- Arm-time funding: ETH -> VIRTUAL + approve --------------------------
// Uniswap v2 constant-product output with the 0.3% LP fee.
function v2AmountOut(amountIn, reserveIn, reserveOut) {
  const inFee = amountIn * 997n;
  return (inFee * reserveOut) / (reserveIn * 1000n + inFee);
}

export async function prepVirtualFunding({ publicClient, walletClient, account, cfg, amountEth, gas, log }) {
  const vcfg = cfg.virtuals;
  const need = parseEther(String(amountEth));
  const virtual = getContract({ address: vcfg.virtualToken, abi: ERC20_ABI, client: publicClient });

  const txOpts = {
    gas: BigInt(cfg.dex.gasLimit || 500000),
    maxFeePerGas: parseGwei(String(gas.maxFeePerGasGwei)),
    maxPriorityFeePerGas: parseGwei(String(gas.maxPriorityFeePerGasGwei))
  };

  // Already funded? (balance from an earlier arm, or user-held VIRTUAL)
  const pair = getContract({ address: vcfg.wethVirtualPair, abi: V2_PAIR_ABI, client: publicClient });
  const [r0, r1] = await pair.read.getReserves();
  const t0 = (await pair.read.token0()).toLowerCase();
  const wethIs0 = t0 === cfg.chain.wrappedNative.toLowerCase();
  const [rWeth, rVirt] = wethIs0 ? [r0, r1] : [r1, r0];
  const targetVirtual = v2AmountOut(need, rWeth, rVirt); // what the budget buys today

  const have = await virtual.read.balanceOf([account.address]);
  if (have < targetVirtual) {
    log?.('info', `Funding snipe budget: swapping ${amountEth} ETH -> VIRTUAL (have ${formatEther(have)}, want ~${formatEther(targetVirtual)})...`);
    // 1) wrap
    let hash = await walletClient.writeContract({ address: cfg.chain.wrappedNative, abi: WETH9_ABI, functionName: 'deposit', args: [], value: need, ...txOpts });
    await publicClient.waitForTransactionReceipt({ hash });
    // 2) send WETH to the pair
    hash = await walletClient.writeContract({ address: cfg.chain.wrappedNative, abi: WETH9_ABI, functionName: 'transfer', args: [vcfg.wethVirtualPair, need], ...txOpts });
    await publicClient.waitForTransactionReceipt({ hash });
    // 3) swap out VIRTUAL. getReserves() still reports pre-transfer reserves
    // (they only sync on swap), which is exactly what the x*y=k output math needs.
    const [r0b, r1b] = await pair.read.getReserves();
    const [rW2, rV2] = wethIs0 ? [r0b, r1b] : [r1b, r0b];
    const out = v2AmountOut(need, rW2, rV2);
    const amount0Out = wethIs0 ? 0n : out;
    const amount1Out = wethIs0 ? out : 0n;
    hash = await walletClient.writeContract({ address: vcfg.wethVirtualPair, abi: V2_PAIR_ABI, functionName: 'swap', args: [amount0Out, amount1Out, account.address, '0x'], ...txOpts });
    const rec = await publicClient.waitForTransactionReceipt({ hash });
    if (rec.status !== 'success') throw new Error('ETH->VIRTUAL swap reverted');
    log?.('success', `VIRTUAL funded: ${formatEther(await virtual.read.balanceOf([account.address]))} VIRTUAL ready.`);
  } else {
    log?.('info', `VIRTUAL already funded (${formatEther(have)}).`);
  }

  // Approve the FRouter (it transferFroms the buyer inside Bonding.buy).
  const allowance = await virtual.read.allowance([account.address, vcfg.frouter]);
  const bal = await virtual.read.balanceOf([account.address]);
  if (allowance < bal) {
    const hash = await walletClient.writeContract({ address: vcfg.virtualToken, abi: ERC20_ABI, functionName: 'approve', args: [vcfg.frouter, 2n ** 256n - 1n], ...txOpts });
    await publicClient.waitForTransactionReceipt({ hash });
    log?.('info', 'VIRTUAL approved to Virtuals router.');
  }
  return bal;
}

// ---- Fire: single-tx bonding buy ----------------------------------------
export async function buildAndSendBondingBuy({ publicClient, walletClient, account, cfg, tokenOut, maxFeePerGasGwei, maxPriorityFeePerGasGwei, deadlineSeconds }) {
  const vcfg = cfg.virtuals;
  const virtual = getContract({ address: vcfg.virtualToken, abi: ERC20_ABI, client: publicClient });
  const amountIn = await virtual.read.balanceOf([account.address]);
  if (amountIn === 0n) throw new Error('No VIRTUAL balance — arm-time funding did not run or was spent.');

  const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(deadlineSeconds || 60));
  const hash = await walletClient.writeContract({
    address: vcfg.bonding,
    abi: BONDING_ABI,
    functionName: 'buy',
    args: [amountIn, tokenOut, 0n, deadline], // minOut 0: bonding curve is deterministic; tax watch is the price gate
    gas: BigInt(cfg.dex.gasLimit || 500000),
    maxFeePerGas: parseGwei(String(maxFeePerGasGwei)),
    maxPriorityFeePerGas: parseGwei(String(maxPriorityFeePerGasGwei))
  });
  return { hash, amountIn, minOut: 0n };
}
