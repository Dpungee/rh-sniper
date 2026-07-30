// Selling. Percentage-based exits for positions the sniper opened.
//
// Path (verified by eth_simulateV1 against live pools):
//   1. approve(token -> SwapRouter02)  — only when the current allowance is short
//   2. exactInputSingle(token -> WETH) — through the BEST pool, not a guessed tier
//   3. WETH.withdraw()                 — unwrap so the proceeds land as native ETH
//
// SwapRouter02 with a direct ERC20 approval is used rather than the
// UniversalRouter + Permit2 dance: selling isn't latency-critical (unlike the
// snipe), and this avoids a second approval contract in the path.

import { getContract, parseEther, parseGwei, formatEther } from 'viem';
import { ERC20_ABI, UNIV3_ROUTER_ABI } from './abis.js';
import { bestSellPool, tokenBalance } from './router.js';

const WETH9_ABI = [
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] }
];

// Sell `percent` of the wallet's balance of `token` back to native ETH.
// percent: 1-100. Returns { hash, soldRaw, ethOut, feeTier }.
export async function sellPercent({
  publicClient, walletClient, account, cfg, token,
  percent, slippagePct = 15, preferFee = null,
  maxFeePerGasGwei, maxPriorityFeePerGasGwei, log
}) {
  const pct = Number(percent);
  if (!(pct > 0 && pct <= 100)) throw new Error('Sell percent must be between 1 and 100.');

  const { raw: balance, decimals } = await tokenBalance(publicClient, token, account.address);
  if (balance === 0n) throw new Error('Nothing to sell — wallet holds 0 of this token.');

  // 100% sells the exact balance; anything else takes an integer share of it.
  const amountIn = pct >= 100 ? balance : (balance * BigInt(Math.round(pct))) / 100n;
  if (amountIn === 0n) throw new Error('Computed sell amount rounds to 0 — balance too small for that percentage.');

  const gasOpts = {
    gas: BigInt(cfg.dex.gasLimit || 500000),
    maxFeePerGas: parseGwei(String(maxFeePerGasGwei ?? cfg.defaults.maxFeePerGasGwei)),
    maxPriorityFeePerGas: parseGwei(String(maxPriorityFeePerGasGwei ?? cfg.defaults.maxPriorityFeePerGasGwei))
  };

  // --- pick the pool that actually pays the most ---
  const route = await bestSellPool(publicClient, cfg, { token, amountRaw: amountIn, preferFee });
  log?.('info', `Selling ${pct}% (${formatEther(amountIn)} tokens) via ${route.reason}.`);

  // Min-out from the quote and the caller's slippage. Unquotable => 0 (accept
  // any) rather than blocking the exit: being unable to price a dying token is
  // exactly when getting out matters most.
  let minOut = 0n;
  if (route.out !== null) {
    const bps = BigInt(Math.round((100 - Number(slippagePct)) * 100));
    minOut = (route.out * bps) / 10000n;
  } else {
    log?.('warn', 'Sell is unquotable (thin/!dead pool) — sending with min-out 0.');
  }

  // --- 1. approve only if needed ---
  const erc20 = getContract({ address: token, abi: ERC20_ABI, client: publicClient });
  const allowance = await erc20.read.allowance([account.address, cfg.dex.router]).catch(() => 0n);
  if (allowance < amountIn) {
    log?.('info', 'Approving router to spend the token...');
    const aHash = await walletClient.writeContract({
      address: token, abi: ERC20_ABI, functionName: 'approve',
      args: [cfg.dex.router, 2n ** 256n - 1n], ...gasOpts
    });
    const aRec = await publicClient.waitForTransactionReceipt({ hash: aHash });
    if (aRec.status !== 'success') throw new Error('Token approval reverted.');
  }

  // --- 2. swap token -> WETH (to this wallet) ---
  const hash = await walletClient.writeContract({
    address: cfg.dex.router,
    abi: UNIV3_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: token,
      tokenOut: cfg.chain.wrappedNative,
      fee: route.fee,
      recipient: account.address,
      amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n
    }],
    ...gasOpts
  });
  const rec = await publicClient.waitForTransactionReceipt({ hash });
  if (rec.status !== 'success') throw new Error(`Sell reverted (${hash}).`);

  // --- 3. unwrap WETH so proceeds are spendable native ETH ---
  let ethOut = 0n;
  try {
    const weth = getContract({ address: cfg.chain.wrappedNative, abi: ERC20_ABI, client: publicClient });
    const wbal = await weth.read.balanceOf([account.address]);
    if (wbal > 0n) {
      const uHash = await walletClient.writeContract({
        address: cfg.chain.wrappedNative, abi: WETH9_ABI, functionName: 'withdraw', args: [wbal], ...gasOpts
      });
      await publicClient.waitForTransactionReceipt({ hash: uHash });
      ethOut = wbal;
      log?.('info', `Unwrapped ${formatEther(wbal)} WETH -> native ETH.`);
    }
  } catch (e) {
    log?.('warn', `Sold successfully, but unwrapping WETH failed: ${e.shortMessage || e.message}. Proceeds are sitting as WETH.`);
  }

  return { hash, soldRaw: amountIn, decimals, ethOut, feeTier: route.fee };
}
