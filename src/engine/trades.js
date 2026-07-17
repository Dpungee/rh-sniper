// Fill journal. Every confirmed snipe is appended to ~/.rh-sniper/trades.json
// so the portfolio can show cost basis and PNL. Append-only; sells made outside
// this app are NOT tracked (PNL is unrealized, vs. what the sniper paid).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TRADES_PATH = path.join(os.homedir(), '.rh-sniper', 'trades.json');

export function loadTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8')); } catch { return []; }
}

// trade: { token, symbol, txHash, blockNumber, ethIn (wei string), tokensOut (raw string), ts }
export function recordFill(trade) {
  const all = loadTrades();
  all.push(trade);
  fs.mkdirSync(path.dirname(TRADES_PATH), { recursive: true });
  fs.writeFileSync(TRADES_PATH, JSON.stringify(all, null, 2), { mode: 0o600 });
  return all.length;
}

// ERC20 Transfer(address,address,uint256) topic
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// How many tokens did `recipient` actually receive in this receipt?
// Sums Transfer logs FROM the token contract TO the recipient — works no matter
// how the router routed, and naturally nets out weird fee-on-transfer mechanics
// that emit multiple transfers to the buyer.
export function tokensReceived(receipt, tokenAddr, recipient) {
  const token = tokenAddr.toLowerCase();
  const to32 = '0x' + recipient.toLowerCase().slice(2).padStart(64, '0');
  let total = 0n;
  for (const l of receipt.logs || []) {
    if ((l.address || '').toLowerCase() !== token) continue;
    if (!l.topics || l.topics[0] !== TRANSFER_TOPIC) continue;
    if ((l.topics[2] || '').toLowerCase() !== to32) continue;
    total += BigInt(l.data);
  }
  return total;
}
