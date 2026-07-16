// Orchestrator. Arms a snipe for a ticker, listens for new pairs, and when a
// matching token appears it (optionally checks safety, then) fires the buy.
// Emits structured events so the UI can render a live log.

import { EventEmitter } from 'node:events';
import { makePublicClient, makeHttpPublicClient, makeWalletClient, loadConfig } from './chain.js';
import { startPairListener } from './discovery.js';
import { tickerMatches, normalizeTicker } from './resolver.js';
import { passesSafety } from './safety.js';
import { buildAndSendBuy } from './swap.js';
import { buildAndSendBuyUniversal } from './swapUniversal.js';

export class Sniper extends EventEmitter {
  constructor() {
    super();
    this.cfg = loadConfig();
    this.wsClient = makePublicClient(this.cfg, { preferWs: true });
    this.httpClient = makeHttpPublicClient(this.cfg);
    this.account = null;      // set via useAccount()
    this.walletClient = null;
    this.unwatch = null;
    this.armed = null;        // active snipe params
    this.fired = false;
  }

  log(level, msg, data) {
    this.emit('log', { ts: Date.now(), level, msg, data });
  }

  useAccount(account) {
    this.account = account;
    this.walletClient = makeWalletClient(this.cfg, account);
    this.log('info', `Wallet unlocked: ${account.address}`);
  }

  // params: { ticker, amountEth, slippagePct, maxFeePerGasGwei, maxPriorityFeePerGasGwei, deadlineSeconds }
  arm(params) {
    if (!this.account) throw new Error('Unlock a wallet first.');
    if (this.unwatch) this.disarm();

    this.armed = { ...params, ticker: normalizeTicker(params.ticker) };
    this.fired = false;
    this.log('info', `Armed for $${this.armed.ticker} — ${params.amountEth} ETH, ${params.slippagePct}% slippage. Listening for new pairs...`);

    this.unwatch = startPairListener(
      this.wsClient,
      this.cfg,
      (t) => this.onNewToken(t),
      (e) => this.log('error', `listener error: ${e.shortMessage || e.message}`)
    );
    this.emit('state', { armed: true, ticker: this.armed.ticker });
  }

  disarm() {
    if (this.unwatch) { try { this.unwatch(); } catch {} this.unwatch = null; }
    this.armed = null;
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
      const gate = await passesSafety(this.httpClient, this.cfg, t.token, t.feeTier, this.armed.amountEth);
      if (!gate.ok) {
        this.log('warn', `Blocked by safety gate: ${gate.reason}`);
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
