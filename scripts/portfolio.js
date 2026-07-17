// Portfolio CLI — holdings, live ETH value, and unrealized PNL vs. sniper cost.
//   npm run portfolio                 # uses the saved keystore's address
//   npm run portfolio -- 0xADDRESS    # any address
import { loadConfig, makeHttpPublicClient } from '../src/engine/chain.js';
import { getPortfolio } from '../src/engine/portfolio.js';
import { savedAddress } from '../src/engine/keystore.js';

const arg = process.argv[2];
const address = arg && arg.startsWith('0x') ? arg : savedAddress();
if (!address) {
  console.error('No keystore found and no address given. Usage: npm run portfolio -- 0xADDRESS');
  process.exit(2);
}

const cfg = loadConfig();
const client = makeHttpPublicClient(cfg);

const fmt = (n, dp = 6) => (n === null || n === undefined) ? '?' : Number(n).toFixed(dp).replace(/\.?0+$/, '') || '0';
const sign = (n) => n === null ? ' ?' : (n >= 0 ? ` +${fmt(n)}` : ` ${fmt(n)}`);

console.log(`\n== Portfolio ${address} ==`);
const p = await getPortfolio(client, cfg, address);
console.log(`ETH balance: ${fmt(p.ethBalance)} ETH   (fills journaled: ${p.tradesCount})\n`);

if (!p.holdings.length) {
  console.log('No token holdings found.');
} else {
  for (const h of p.holdings) {
    const bal = h.balanceFmt >= 1e6 ? h.balanceFmt.toExponential(3) : fmt(h.balanceFmt, 4);
    const val = h.valueEth === null ? 'unquotable' : `${fmt(h.valueEth)} ETH`;
    const pnl = h.pnlEth === null ? '' : `  pnl${sign(h.pnlEth)} ETH (${h.pnlPct >= 0 ? '+' : ''}${fmt(h.pnlPct, 1)}%)`;
    const cost = h.costEth === null ? '' : `  cost ${fmt(h.costEth)} ETH`;
    console.log(`  $${h.symbol.padEnd(12)} ${bal.padStart(14)}   value ${val}${cost}${pnl}`);
    console.log(`    ${h.token}${h.fills ? `  (${h.fills} fill${h.fills > 1 ? 's' : ''})` : ''}`);
  }
  console.log(`\n  TOTAL value ${fmt(p.totals.valueEth)} ETH   cost ${fmt(p.totals.costEth)} ETH   unrealized PNL${sign(p.totals.pnlEth)} ETH`);
  console.log('  (PNL covers sniper buys only; manual buys/sells and airdrops have no cost basis.)');
}
console.log('');
