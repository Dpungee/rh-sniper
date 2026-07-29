// Uniswap v4 support — detection and execution.
//
// v4 is a different world from v3 and needs its own path:
// - Pools are NOT separate contracts. They live inside a singleton PoolManager
//   and are identified by a poolId; there is no per-pool address to call
//   liquidity() on, and no PoolCreated on the v3 factory. New pools announce
//   themselves with PoolManager's `Initialize` event.
// - Pools trade NATIVE ETH directly (currency0 = address(0)) — no WETH wrapping.
// - Swaps go through UniversalRouter's V4_SWAP command (0x10) with v4-periphery
//   Actions, not the v3 exactInput encoding.
//
// letscash.fun (the launchpad that prompted this) launches here: its factory
// deploys the token, creates + seeds the v4 pool and locks liquidity in ONE tx,
// with a hook that takes fees in ETH.

import { encodeFunctionData, encodeAbiParameters, decodeAbiParameters, parseGwei, getContract } from 'viem';
import { UNIVERSAL_ROUTER_ABI, ERC20_ABI } from './abis.js';

// PoolManager events (verified against the deployed, source-verified contract).
export const V4_INITIALIZE_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
export const V4_MODIFY_LIQUIDITY_TOPIC = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';

const CMD_V4_SWAP = '0x10';
// v4-periphery Actions (the router imports the standard library).
const ACTION_SWAP_EXACT_IN_SINGLE = '06';
const ACTION_SETTLE_ALL = '0c';
const ACTION_TAKE_ALL = '0f';

const POOLKEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' }
];

// Decode an Initialize log into the PoolKey the executor needs.
export function decodeInitialize(log) {
  const [fee, tickSpacing, hooks] = decodeAbiParameters(
    [{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }],
    log.data
  );
  return {
    poolId: log.topics[1],
    currency0: '0x' + log.topics[2].slice(26),
    currency1: '0x' + log.topics[3].slice(26),
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    hooks
  };
}

// ---- Detection ----------------------------------------------------------
// Watch the PoolManager for new pools. Emits the same candidate shape the
// v3 discovery uses, plus `poolKey` for the v4 executor.
export function startV4Listener({ httpClient, wsClient }, cfg, onNewToken, onError, log) {
  const pm = cfg.v4?.poolManager;
  if (!pm) return () => {};
  const seen = new Set();
  let stopped = false;
  let fromBlock = null;
  let unwatchWs = null;
  let timer = null;

  async function handleLog(l) {
    if (l.topics?.[0] !== V4_INITIALIZE_TOPIC) return;
    const key = l.topics[1];
    if (seen.has(key)) return;
    seen.add(key);

    const pk = decodeInitialize(l);
    // The "new" token is the side that isn't the base asset. v4 pools may be
    // paired against native ETH (address(0)) OR wrapped ETH — checking only for
    // native would mis-identify a WETH-paired pool's base asset as the launch.
    const wrapped = String(cfg.chain.wrappedNative || '').toLowerCase();
    const isBase = (a) => /^0x0+$/.test(a) || a.toLowerCase() === wrapped;
    const token = isBase(pk.currency0) ? pk.currency1
      : isBase(pk.currency1) ? pk.currency0
        : pk.currency1; // neither side is a base asset — default to currency1

    let symbol = '?';
    try {
      symbol = String(await getContract({ address: token, abi: ERC20_ABI, client: httpClient }).read.symbol());
    } catch { /* leave ? */ }

    onNewToken({
      source: 'v4',
      token,
      symbol,
      pool: pk.poolId,       // a poolId, not an address — v4 has no pool contract
      poolKey: pk,
      feeTier: pk.fee,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber
    });
  }

  async function pollOnce() {
    const latest = await httpClient.getBlockNumber();
    if (fromBlock === null) fromBlock = latest + 1n;
    if (latest < fromBlock) return;
    for (let i = 0; i < 60 && fromBlock <= latest && !stopped; i++) {
      const toBlock = fromBlock + 6n > latest ? latest : fromBlock + 6n;
      const logs = await httpClient.getLogs({ address: pm, fromBlock, toBlock });
      for (const l of logs) { if (stopped) return; await handleLog(l).catch((e) => onError?.(e)); }
      fromBlock = toBlock + 1n;
    }
  }

  const pollMs = Number(cfg.discovery?.pollMs ?? 3000);
  const tick = async () => {
    if (stopped) return;
    try { await pollOnce(); } catch (e) { onError?.(e); }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };
  tick();

  if (wsClient) {
    try {
      unwatchWs = wsClient.watchEvent({
        address: pm,
        onError: (e) => onError?.(e),
        onLogs: async (logs) => { for (const l of logs) { if (stopped) return; await handleLog(l).catch((e) => onError?.(e)); } }
      });
      log?.('debug', 'Uniswap v4 listener active (ws+poll)');
    } catch { log?.('debug', 'Uniswap v4 listener active (poll)'); }
  } else {
    log?.('debug', 'Uniswap v4 listener active (poll)');
  }

  return () => { stopped = true; if (timer) clearTimeout(timer); if (unwatchWs) { try { unwatchWs(); } catch {} } };
}

// Did this tx seed the pool? v4 has no per-pool contract to query, so the
// launch tx's ModifyLiquidity event is the proof (letscash is atomic).
export function liquidityAddedInLogs(logs) {
  return (logs || []).some((l) => l.topics?.[0] === V4_MODIFY_LIQUIDITY_TOPIC);
}

// ---- Execution ----------------------------------------------------------
// Build the V4_SWAP calldata for an exact-in native-ETH buy.
// Verified by eth_simulateV1 against a live letscash pool.
export function encodeV4Buy({ poolKey, amountIn, minOut = 0n, deadlineSeconds = 60 }) {
  // We pay with NATIVE ETH (sent as msg.value), so the pool must have native ETH
  // on one side. v4 sorts currencies, so native (address(0)) is always
  // currency0 when present — but check explicitly rather than assume, and fail
  // loudly instead of encoding a swap that would spend the wrong side.
  const zeroIsNative = /^0x0+$/.test(poolKey.currency0);
  const oneIsNative = /^0x0+$/.test(poolKey.currency1);
  if (!zeroIsNative && !oneIsNative) {
    throw new Error('v4 pool is not paired against native ETH — this executor pays in native ETH only.');
  }
  const zeroForOne = zeroIsNative;            // spend the native side
  const inputCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const outputCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  const actions = '0x' + ACTION_SWAP_EXACT_IN_SINGLE + ACTION_SETTLE_ALL + ACTION_TAKE_ALL;
  const key = [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks];

  const swapParams = encodeAbiParameters(
    [{ type: 'tuple', components: [
      { name: 'poolKey', type: 'tuple', components: POOLKEY_COMPONENTS },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
      { name: 'hookData', type: 'bytes' }
    ] }],
    [[key, zeroForOne, amountIn, minOut, '0x']]
  );
  const settleAll = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [inputCurrency, amountIn]);
  const takeAll = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [outputCurrency, minOut]);

  const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swapParams, settleAll, takeAll]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(deadlineSeconds || 60));

  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [CMD_V4_SWAP, [v4Input], deadline]
  });
}

export async function buildAndSendBuyV4({ walletClient, account, cfg, poolKey, amountIn, minOut = 0n, maxFeePerGasGwei, maxPriorityFeePerGasGwei, deadlineSeconds }) {
  const router = cfg.dex.universalRouter;
  if (!router || /^0x0+$/.test(router)) throw new Error('universalRouter not set in config.json.');

  const data = encodeV4Buy({ poolKey, amountIn, minOut, deadlineSeconds });
  const hash = await walletClient.sendTransaction({
    account,
    to: router,
    data,
    value: amountIn,                          // v4 takes native ETH directly
    gas: BigInt(cfg.dex.gasLimit || 500000),
    maxFeePerGas: parseGwei(String(maxFeePerGasGwei)),
    maxPriorityFeePerGas: parseGwei(String(maxPriorityFeePerGasGwei))
  });
  return { hash, amountIn, minOut };
}
