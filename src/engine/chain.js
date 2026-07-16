import { createPublicClient, createWalletClient, http, webSocket, fallback, defineChain } from 'viem';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '../../config.json');
const ENV_PATH = path.resolve(__dirname, '../../.env');
(function loadDotEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) return;
    for (const raw of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && process.env[key] === undefined && val !== '') process.env[key] = val;
    }
  } catch { /* ignore */ }
})();

export function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Resolve endpoints with this precedence:
//   env RH_RPC_HTTP / RH_RPC_WSS  >  ALCHEMY_KEY (built into Alchemy URL)  >
//   config.chain.rpcHttpPrivate / rpcWssPrivate  >  config.chain.rpcHttp / rpcWss (public)
export function resolveEndpoints(cfg) {
  const env = process.env;
  const alchemyKey = env.ALCHEMY_KEY || cfg.chain.alchemyKey;
  const alchemyHttp = alchemyKey ? `https://robinhood-mainnet.g.alchemy.com/v2/${alchemyKey}` : null;
  const alchemyWss = alchemyKey ? `wss://robinhood-mainnet.g.alchemy.com/v2/${alchemyKey}` : null;

  const http_ =
    env.RH_RPC_HTTP || alchemyHttp || cfg.chain.rpcHttpPrivate || cfg.chain.rpcHttp;
  const wss_ =
    env.RH_RPC_WSS || alchemyWss || cfg.chain.rpcWssPrivate || cfg.chain.rpcWss;

  const isPrivate = Boolean(env.RH_RPC_HTTP || alchemyHttp || cfg.chain.rpcHttpPrivate);
  return { http: http_, wss: wss_, isPrivate };
}

export function robinhoodChain(cfg) {
  const { http: h, wss } = resolveEndpoints(cfg);
  return defineChain({
    id: cfg.chain.chainId,
    name: cfg.chain.name,
    nativeCurrency: { name: 'Ether', symbol: cfg.chain.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [h], webSocket: wss ? [wss] : [] } },
    blockExplorers: { default: { name: 'Blockscout', url: cfg.chain.explorer } }
  });
}

// Read-only client. With a private WS endpoint (Alchemy) this yields real-time
// eth_subscribe log streaming; on the rate-limited public RPC viem falls back to
// polling automatically. HTTP is kept as a fallback transport for resilience.
export function makePublicClient(cfg, { preferWs = true } = {}) {
  const chain = robinhoodChain(cfg);
  const { http: h, wss } = resolveEndpoints(cfg);
  const transport =
    preferWs && wss ? fallback([webSocket(wss), http(h)]) : http(h);
  return createPublicClient({ chain, transport });
}

export function makeHttpPublicClient(cfg) {
  const { http: h } = resolveEndpoints(cfg);
  return createPublicClient({ chain: robinhoodChain(cfg), transport: http(h) });
}

export function makeWalletClient(cfg, account) {
  const { http: h } = resolveEndpoints(cfg);
  return createWalletClient({ account, chain: robinhoodChain(cfg), transport: http(h) });
}
