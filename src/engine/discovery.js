// New-pair listener. Subscribes to the DEX factory and emits every freshly
// created pool/pair the moment it lands on-chain. This is the "sniping" core:
// we hear about a launch as it happens, then match it against the target ticker.

import { getContract } from 'viem';
import { UNIV3_FACTORY_ABI, UNIV2_FACTORY_ABI, ERC20_ABI } from './abis.js';

const NATIVE_LIKE = new Set(); // filled from config.wrappedNative at runtime

// The token in a new pair that ISN'T the base asset (WETH) is the "new" token.
function pickNewToken(token0, token1, wrappedNative) {
  const w = wrappedNative.toLowerCase();
  if (token0.toLowerCase() === w) return token1;
  if (token1.toLowerCase() === w) return token0;
  // Neither side is WETH (e.g. paired vs a stable) — default to token1.
  return token1;
}

export function startPairListener(publicClient, cfg, onNewToken, onError) {
  const kind = cfg.dex.kind;
  const factory = cfg.dex.factory;
  const wrapped = cfg.chain.wrappedNative;

  const abi = kind === 'uniswap-v2' ? UNIV2_FACTORY_ABI : UNIV3_FACTORY_ABI;
  const eventName = kind === 'uniswap-v2' ? 'PairCreated' : 'PoolCreated';

  const unwatch = publicClient.watchContractEvent({
    address: factory,
    abi,
    eventName,
    onError: (e) => onError?.(e),
    onLogs: async (logs) => {
      for (const log of logs) {
        try {
          const { token0, token1 } = log.args;
          const poolOrPair = log.args.pool ?? log.args.pair;
          const feeTier = log.args.fee ?? cfg.dex.defaultFeeTier;
          const tokenAddr = pickNewToken(token0, token1, wrapped);

          // Read the token's symbol so we can match by ticker.
          let symbol = '?';
          let decimals = 18;
          try {
            const token = getContract({ address: tokenAddr, abi: ERC20_ABI, client: publicClient });
            [symbol, decimals] = await Promise.all([token.read.symbol(), token.read.decimals()]);
          } catch { /* token may not implement symbol(); leave as ? */ }

          onNewToken({
            token: tokenAddr,
            symbol: String(symbol),
            decimals: Number(decimals),
            pool: poolOrPair,
            feeTier: Number(feeTier),
            token0,
            token1,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber
          });
        } catch (e) {
          onError?.(e);
        }
      }
    }
  });

  return unwatch; // call to stop listening
}
