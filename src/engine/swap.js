// Buy execution. Builds and sends a Uniswap V3 exactInputSingle swap that spends
// your EXACT ETH amount, with YOUR gas settings, and a min-out derived from YOUR
// slippage tolerance. Native ETH is sent as msg.value (router wraps it).

import { parseEther, parseGwei, getContract } from 'viem';
import { UNIV3_ROUTER_ABI, UNIV3_QUOTER_ABI } from './abis.js';

// Optional: ask the quoter what we'd get, then subtract slippage for amountOutMinimum.
async function computeMinOut(publicClient, cfg, tokenOut, amountInWei, feeTier, slippagePct) {
  const quoter = cfg.dex.quoter;
  if (!quoter || /^0x0+$/.test(quoter)) {
    // No quoter configured -> we can't price it; return 0n (accept any amount).
    // This is the fastest but most-exposed setting. Fill in the quoter to protect min-out.
    return 0n;
  }
  try {
    const q = getContract({ address: quoter, abi: UNIV3_QUOTER_ABI, client: publicClient });
    const [amountOut] = await q.simulate.quoteExactInputSingle([
      {
        tokenIn: cfg.chain.wrappedNative,
        tokenOut,
        amountIn: amountInWei,
        fee: feeTier,
        sqrtPriceLimitX96: 0n
      }
    ]).then((r) => [r.result[0]]);
    const bps = BigInt(Math.round((100 - slippagePct) * 100)); // e.g. 15% slip -> 8500 bps
    return (amountOut * bps) / 10000n;
  } catch {
    return 0n; // fresh pool may not quote yet; fall back to accept-any
  }
}

export async function buildAndSendBuy({
  publicClient,
  walletClient,
  account,
  cfg,
  tokenOut,
  feeTier,
  amountEth,
  slippagePct,
  maxFeePerGasGwei,
  maxPriorityFeePerGasGwei,
  deadlineSeconds,
  rawMode
}) {
  const router = cfg.dex.router;
  if (!router || /^0x0+$/.test(router)) {
    throw new Error('Router address not set in config.json — cannot send a real swap.');
  }

  const amountIn = parseEther(String(amountEth));
  // RAW MODE: skip the quoter round-trip entirely and accept ANY price (minOut=0).
  const minOut = rawMode ? 0n : await computeMinOut(publicClient, cfg, tokenOut, amountIn, feeTier, slippagePct);

  const params = {
    tokenIn: cfg.chain.wrappedNative,
    tokenOut,
    fee: feeTier,
    recipient: account.address,
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n
  };

  // Explicit gas limit → viem skips eth_estimateGas. Saves a round-trip at the
  // critical moment AND avoids the estimate reverting on a brand-new pool
  // (which would otherwise abort the buy before it's ever broadcast).
  const gas = {
    gas: BigInt(cfg.dex.gasLimit || 500000),
    maxFeePerGas: parseGwei(String(maxFeePerGasGwei)),
    maxPriorityFeePerGas: parseGwei(String(maxPriorityFeePerGasGwei))
  };

  // Send native ETH as value; SwapRouter02 wraps it to WETH internally.
  const hash = await walletClient.writeContract({
    address: router,
    abi: UNIV3_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [params],
    value: amountIn,
    ...gas
  });

  return { hash, amountIn, minOut };
}
