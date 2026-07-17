// Latency benchmark — measure round-trip time from THIS machine to the chain's
// RPC endpoints. On a first-come-first-served sequencer L2, whoever reaches the
// sequencer first wins, so the only real speed lever is where you run the bot.
//
// Run this on each candidate host (your laptop, a us-east VPS, an eu VPS…) and
// compare. Lower p50/p99 total = closer to the sequencer = faster snipes.
//
//   node scripts/latency.js            # 40 warm samples per endpoint
//   node scripts/latency.js 100        # custom sample count
//
// It reuses ONE keep-alive connection per endpoint (like the bot does), so the
// numbers reflect steady-state request latency, not cold TLS handshakes.

import { loadConfig, resolveEndpoints } from '../src/engine/chain.js';

const N = Number(process.argv[2] || 40);
const WARMUP = 5;

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function bench(name, url) {
  if (!url) { console.log(`\n${name}: (not configured)`); return; }
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 });
  const headers = { 'Content-Type': 'application/json', 'Connection': 'keep-alive' };

  // Warm up the connection (DNS + TCP + TLS) so we time steady-state requests.
  try {
    for (let i = 0; i < WARMUP; i++) {
      await fetch(url, { method: 'POST', headers, body }).then((r) => r.text());
    }
  } catch (e) {
    console.log(`\n${name}: FAILED — ${(e.message || e).toString().slice(0, 120)}`);
    return;
  }

  const samples = [];
  let errors = 0;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(url, { method: 'POST', headers, body });
      await r.text();
      samples.push(performance.now() - t0);
    } catch { errors++; }
  }
  if (!samples.length) { console.log(`\n${name}: all ${N} requests failed`); return; }

  samples.sort((a, b) => a - b);
  const avg = samples.reduce((s, x) => s + x, 0) / samples.length;
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  console.log(`\n${name}  (${host})`);
  console.log(`  samples ${samples.length}/${N}${errors ? `  errors ${errors}` : ''}`);
  console.log(`  min ${samples[0].toFixed(1)}ms   p50 ${pct(samples, 50).toFixed(1)}ms   p90 ${pct(samples, 90).toFixed(1)}ms   p99 ${pct(samples, 99).toFixed(1)}ms   avg ${avg.toFixed(1)}ms`);
}

async function main() {
  const cfg = loadConfig();
  const { http, isPrivate } = resolveEndpoints(cfg);
  console.log(`RPC latency benchmark — ${N} warm samples per endpoint`);
  console.log(`(run this on each candidate host and compare p50/p99; lower = closer to sequencer)`);

  // Always test the public sequencer RPC (the tx write path's origin), and the
  // active endpoint (Alchemy/private) if different.
  await bench('public RPC (sequencer edge)', cfg.chain.rpcHttp);
  if (isPrivate && http && http !== cfg.chain.rpcHttp) {
    await bench('active RPC (private/Alchemy)', http);
  }
  console.log('');
}

main().catch((e) => { console.error('benchmark failed:', e.message); process.exit(1); });
