// Buy execution via Uniswap UniversalRouter (Uniswap's preferred entrypoint).
//
// For a native-ETH -> token exact-in V3 buy we send two commands in one call:
//   1) WRAP_ETH      (0x0b) — wrap msg.value into WETH, held by the router
//   2) V3_SWAP_EXACT_IN (0x00) — swap that WETH to the target token, sent to you
//
// Address constants the router understands:
//   ADDRESS_THIS = 0x...0002  (the router itself)
//   MSG_SENDER   = 0x...0001  (you)

import { parseEther, parseGwei, getContract, encodeAbiParameters, encodePacked } from 'viem';
import { UNIVERSAL_ROUTER_ABI, UNIV3_QUOTER_ABI } from './abis.js';

const CMD_V3_SWAP_EXACT_IN = '00';
const CMD_WRAP_ETH = '0b';
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const MSG_SENDER = '0x0000000000000000000000000000000000000001';

async function computeMinOut(publicClient, cfg, tokenOut, amountInWei, feeTier, slippagePct) {
  const quoter = cfg.dex.quoter;
  if (!quoter || /^0x0+$/.test(quoter)) return 0n;
  try {
    const q = getContract({ address: quoter, abi: UNIV3_QUOTER_ABI, client: publicClient });
    const r = await q.simulate.quoteExactInputSingle([
      { tokenIn: cfg.chain.wrappedNative, tokenOut, amountIn: amountInWei, fee: feeTier, sqrtPriceLimitX96: 0n }
    ]);
    const amountOut = r.result[0];
    const bps = BigInt(Math.round((100 - slippagePct) * 100));
    return (amountOut * bps) / 10000n;
  } catch {
    return 0n; // fresh pool may not quote yet -> accept any (raw-speed launch)
  }
}

export async function buildAndSendBuyUniversal({
  publicClient, walletClient, account, cfg,
  tokenOut, feeTier, amountEth, slippagePct,
  maxFeePerGasGwei, maxPriorityFeePerGasGwei, deadlineSeconds,
  rawMode
}) {
  const router = cfg.dex.universalRouter;
  if (!router || /^0x0+$/.test(router)) throw new Error('universalRouter not set in config.json.');

  const amountIn = parseEther(String(amountEth));
  // RAW MODE: skip the quoter round-trip entirely and accept ANY price (minOut=0).
  const minOut = rawMode ? 0n : await computeMinOut(publicClient, cfg, tokenOut, amountIn, feeTier, slippagePct);

  // V3 path: WETH -> fee -> tokenOut
  const path = encodePacked(
    ['address', 'uint24', 'address'],
    [cfg.chain.wrappedNative, feeTier, tokenOut]
  );

  const commands = ('0x' + CMD_WRAP_ETH + CMD_V3_SWAP_EXACT_IN);

  const wrapInput = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [ADDRESS_THIS, amountIn]                 // wrap msg.value, keep WETH in router
  );
  // NOTE: Robinhood Chain's UniversalRouter is a FORK — V3_SWAP_EXACT_IN takes a
  // 6th field, uint256[] minHopPriceX36 (per-hop price floors; empty = skip).
  // The standard 5-field encoding reverts with SliceOutOfBounds. Found via
  // eth_simulateV1 against the deployed router (2026-07-18).
  const swapInput = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
    [MSG_SENDER, amountIn, minOut, path, false, []]  // recipient=you, payerIsUser=false (router holds WETH)
  );

  const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(deadlineSeconds || 60));

  // Explicit gas limit → viem skips eth_estimateGas. Saves a round-trip at the
  // critical moment AND avoids the estimate reverting on a brand-new pool
  // (which would otherwise abort the buy before it's ever broadcast).
  const gasLimit = BigInt(cfg.dex.gasLimit || 500000);

  const hash = await walletClient.writeContract({
    address: router,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [commands, [wrapInput, swapInput], deadline],
    value: amountIn,
    gas: gasLimit,
    maxFeePerGas: parseGwei(String(maxFeePerGasGwei)),
    maxPriorityFeePerGas: parseGwei(String(maxPriorityFeePerGasGwei))
  });

  return { hash, amountIn, minOut };
}
