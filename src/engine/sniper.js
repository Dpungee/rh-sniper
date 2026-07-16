// Orchestrator. Arms a snipe for a ticker, listens for new pairs, and when a
// matching token appears it (optionally checks safety, then) fires the buy.
// Emits structured events so the UI can render a live log.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeHttpPublicClient, makeWsClient, makeWalletClient, loadConfig } from './chain.js';
import { startPairListener } from './discovery.js';
import { tickerMatches, normalizeTicker } from './resolver.js';
import { passesSafety } from './safety.js';
import { buildAndSendBuy } from './swap.js';
import { buildAndSendBuyUniversal } from './swapUniversal.js';

// A pending (armed) snipe is persisted here so that if the app is closed or the
// machine restarts mid-watch, unlocking the wallet automatically resumes it.
// Only non-secret params live here — never the key.
const PENDING_PATH = path.join(os.homedir(), '.rh-sniper', 'pending.json');

function writePending(params) {
  try {
    fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
    fs.writeFileSync(PENDING_PATH, JSON.stringify({ ...params, savedAt: Date.now() }, null, 2), { mode: 0o600 });
  } catch { /* best-effort */ }
}
function readPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); } catch { return null; }
}
function clearPending() {
  try { fs.rmSync(PENDING_PATH, { force: true }); } catch { /* best-effort */ }
}

export class Sniper extends EventEmitter {
  constructor() {
    super();
    this.cfg = loadConfig();
    this.httpClient = makeHttpPublicClient(this.cfg); // reliable polling backbone
    this.wsClient = makeWsClient(this.cfg);           // optional low-latency accelerator (private RPC only)
    this.account = null;      // set via useAccount()
    this.walletClient = null;
    this.unwatch = null;
    this.armed = null;        // active snipe params
    this.fired = false;
  }

  // Is there a snipe persisted from a previous session (awaiting unlock)?
  pendingSnipe() {
    if (this.armed) return null;
    return readPending();
  }

  log(level, msg, data) {
    this.emit('log', { ts: Date.now(), level, msg, data });
  }

  useAccount(account) {
    this.account = account;
    this.walletClient = makeWalletClient(this.cfg, account);
    this.log('info', `Wallet unlocked: ${account.address}`);

    // Resume a snipe that was armed before the app/machine restarted.
    const pending = this.pendingSnipe();
    if (pending && pending.ticker) {
      this.log('info', `Resuming saved snipe for $${normalizeTicker(pending.ticker)} from previous session.`);
      try { this.arm(pending); } catch (e) { this.log('error', `Could not resume snipe: ${e.message}`); }
    }
  }

  // params: { ticker, amountEth, slippagePct, maxFeePerGasGwei, maxPriorityFeePerGasGwei, deadlineSeconds }
  arm(params) {
    if (!this.account) throw new Error('Unlock a wallet first.');
    if (this.unwatch) this.disarm();

    this.armed = { ...params, ticker: normalizeTicker(params.ticker) };
    this.fired = false;
    writePending(this.armed); // survive a restart until cancel or fire
    const mode = this.wsClient ? 'live WS + polling' : 'polling (public RPC)';
    this.log('info', `Armed for $${this.armed.ticker} — ${params.amountEth} ETH, ${params.slippagePct}% slippage. Listening (${mode}) until it launches or you cancel...`);

    this.unwatch = startPairListener(
      { http: this.httpClient, ws: this.wsClient },
      this.cfg,
      (t) => this.onNewToken(t),
      (e) => this.log('warn', `listener hiccup (auto-retrying): ${e.shortMessage || e.message}`),
      (level, msg) => this.log(level, msg)
    );
    this.emit('state', { armed: true, ticker: this.armed.ticker });
  }

  disarm() {
    if (this.unwatch) { try { this.unwatch(); } catch {} this.unwatch = null; }
    this.armed = null;
    clearPending(); // an explicit cancel (or a confirmed fill) ends the watch for good
    this.emit('state', { armed: false });
    this.log('info', 'Disarmed.');
  }

  async onNewToken(t) {
    this.log('debug', `New pair: $${t.symbol} (${t.token}) pool=${t.pool} fee=${t.feeTier}`);
    if (!this.armed || this.fired) return;
    if (!tickerMatches(this.armed.ticker, t.symbol)) return;

    this.log('info', `MATCH $${t.symbol} — verifying/executing...`);
    this.fired = true; // prevent double-fire

    try {
      // A just-created pool often can't be quoted until liquidity lands, and its
      // PoolCreated event only fires once — so a blocked match RETRIES the gate
      // for a window instead of abandoning the token forever.
      const retries = Number(this.cfg.safety?.retries ?? 20);
      const retryMs = Number(this.cfg.safety?.retryMs ?? 3000);
      let gate = await passesSafety(this.httpClient, this.cfg, t.token, t.feeTier, this.armed.amountEth);
      for (let i = 1; !gate.ok && i <= retries && this.armed; i++) {
        this.log('warn', `Safety gate not passing yet (${gate.reason}) — recheck ${i}/${retries} in ${retryMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, retryMs));
        gate = await passesSafety(this.httpClient, this.cfg, t.token, t.feeTier, this.armed.amountEth);
      }
      if (!this.armed) { this.fired = false; return; } // cancelled mid-retry
      if (!gate.ok) {
        this.log('warn', `Blocked by safety gate after ${retries} rechecks: ${gate.reason}. Still armed, still listening.`);
        this.fired = false; // allow a later, cleaner match
        return;
      }
      if (this.cfg.safety?.enabled) this.log('info', `Safety OK: ${gate.reason}`);

      const useUniversal = (this.cfg.dex.executor || 'universal-router') === 'universal-router';
      const execFn = useUniversal ? buildAndSendBuyUniversal : buildAndSendBuy;
      this.log('debug', `executor: ${useUniversal ? 'UniversalRouter' : 'SwapRouter02'}`);
      const res = await execFn({
        publicClient: this.httpClient,
        walletClient: this.walletClient,
        account: this.account,
        cfg: this.cfg,
        tokenOut: t.token,
        feeTier: t.feeTier,
        amountEth: this.armed.amountEth,
        slippagePct: this.armed.slippagePct,
        maxFeePerGasGwei: this.armed.maxFeePerGasGwei,
        maxPriorityFeePerGasGwei: this.armed.maxPriorityFeePerGasGwei,
        deadlineSeconds: this.armed.deadlineSeconds
      });

      this.log('success', `TX sent: ${res.hash}`, { hash: res.hash, explorer: `${this.cfg.chain.explorer}/tx/${res.hash}` });
      this.emit('fired', { token: t, hash: res.hash });

      // Watch for confirmation.
      const receipt = await this.httpClient.waitForTransactionReceipt({ hash: res.hash });
      if (receipt.status === 'success') {
        this.log('success', `CONFIRMED in block ${receipt.blockNumber}. Bought $${t.symbol}.`);
      } else {
        this.log('error', `Transaction reverted (${res.hash}).`);
      }
      this.disarm();
    } catch (e) {
      this.log('error', `Snipe failed: ${e.shortMessage || e.message}`);
      this.fired = false;
    }
  }
}
