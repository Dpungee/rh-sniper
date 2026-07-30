// Orchestrator. Arms a snipe for a ticker, listens for new pairs, and when a
// matching token appears it (optionally checks safety, then) fires the buy.
// Emits structured events so the UI can render a live log.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeHttpPublicClient, makeWsClient, makeWalletClient, loadConfig } from './chain.js';
import { startPairListener } from './discovery.js';
import { targetMatches, normalizeTarget, describeTarget, isAddressTarget } from './resolver.js';
import { passesSafety } from './safety.js';
import { buildAndSendBuy } from './swap.js';
import { buildAndSendBuyUniversal } from './swapUniversal.js';
import { recordFill, recordSale, tokensReceived } from './trades.js';
import { startVirtualsListener, prepVirtualFunding, buildAndSendBondingBuy } from './virtuals.js';
import { startV4Listener, buildAndSendBuyV4, liquidityAddedInLogs } from './v4.js';
import { waitForLowTax } from './taxWatch.js';
import { waitForLiquidity, inspectLaunchTx, matchesLaunchpad, parseLaunchpads, launchpadLabel } from './liquidityWatch.js';
import { formatEther, parseEther, getContract } from 'viem';
import { UNIV3_FACTORY_ABI, ERC20_ABI } from './abis.js';
import { existingPools, bestBuyPool } from './router.js';
import { sellPercent } from './sell.js';

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

// Write a snipe to pending.json WITHOUT starting a listener (no wallet needed).
// Used by `snipe-headless --arm-only`: stage a snipe, then let the service's
// --resume pick it up on its next (re)start.
export function savePending(params) {
  writePending({ ...params, ticker: normalizeTarget(params.ticker) });
}

// Did this send fail on a PRICE check (min-out / slippage revert)? Only these
// are safe to retry with a wider tolerance. Anything else (insufficient funds,
// nonce, gas, RPC trouble) must NOT be retried blindly.
function isPriceRevert(e) {
  const m = `${e?.shortMessage || ''} ${e?.message || ''} ${e?.details || ''} ${e?.cause?.message || ''}`.toLowerCase();
  return m.includes('too little received')      // UniversalRouter V3TooLittleReceived
    || m.includes('v3toolittlereceived')
    || m.includes('insufficient output')        // SwapRouter02 "Too little received" variants
    || m.includes('amountoutminimum')
    || m.includes('slippage');
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
    this.unwatchVirtuals = null;
    this.unwatchV4 = null;
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
      this.log('info', `Resuming saved snipe for ${describeTarget(pending.ticker)} from previous session.`);
      try { this.arm(pending); } catch (e) { this.log('error', `Could not resume snipe: ${e.message}`); }
    }
  }

  // params: { ticker, amountEth, slippagePct, maxFeePerGasGwei, maxPriorityFeePerGasGwei, deadlineSeconds }
  arm(params) {
    if (!this.account) throw new Error('Unlock a wallet first.');
    if (this.unwatch) this.disarm();

    this.armed = { ...params, ticker: normalizeTarget(params.ticker) };
    this.fired = false;
    writePending(this.armed); // survive a restart until cancel or fire
    const mode = this.wsClient ? 'live WS + polling' : 'polling (public RPC)';
    const raw = this.armed.rawMode ? ' ⚠ RAW MODE (no safety checks)' : '';
    const targetDesc = describeTarget(this.armed.ticker);
    const precise = isAddressTarget(this.armed.ticker) ? ' (exact contract — immune to ticker spoofing)' : '';
    this.log('info', `Armed for ${targetDesc}${precise} — ${params.amountEth} ETH, ${params.slippagePct}% slippage.${raw} Listening (${mode}) until it launches or you cancel...`);

    this.unwatch = startPairListener(
      { http: this.httpClient, ws: this.wsClient },
      this.cfg,
      (t) => this.onNewToken(t),
      (e) => this.log('warn', `listener hiccup (auto-retrying): ${e.shortMessage || e.message}`),
      (level, msg) => this.log(level, msg)
    );

    // Uniswap v4: pools live in a singleton PoolManager and never touch the v3
    // factory, so they need their own listener (letscash.fun launches here).
    if (this.cfg.v4?.enabled && this.armed.watchV4 !== false) {
      this.unwatchV4 = startV4Listener(
        { httpClient: this.httpClient, wsClient: this.wsClient },
        this.cfg,
        (t) => this.onNewToken(t),
        (e) => this.log('warn', `v4 listener hiccup (auto-retrying): ${e.shortMessage || e.message}`),
        (level, msg) => this.log(level, msg)
      );
    }

    // Virtuals launchpad: second detection source + arm-time VIRTUAL funding
    // (bonding buys are paid in VIRTUAL; funding now = single-tx fire later).
    if (this.cfg.virtuals?.enabled && this.armed.watchVirtuals !== false) {
      this.unwatchVirtuals = startVirtualsListener(
        { httpClient: this.httpClient, wsClient: this.wsClient },
        this.cfg,
        (t) => this.onNewToken(t),
        (e) => this.log('warn', `virtuals listener hiccup (auto-retrying): ${e.shortMessage || e.message}`),
        (level, msg) => this.log(level, msg)
      );
      prepVirtualFunding({
        publicClient: this.httpClient, walletClient: this.walletClient, account: this.account,
        cfg: this.cfg, amountEth: this.armed.amountEth,
        gas: { maxFeePerGasGwei: this.armed.maxFeePerGasGwei, maxPriorityFeePerGasGwei: this.armed.maxPriorityFeePerGasGwei },
        log: (l, m) => this.log(l, m)
      }).catch((e) => this.log('warn', `VIRTUAL pre-funding failed (will retry at fire time): ${e.shortMessage || e.message}`));
    }

    // Address target: it may already be live (pool created before we armed, so
    // its one-time event is long gone). Check now and fire if so.
    if (isAddressTarget(this.armed.ticker)) {
      const target = this.armed.ticker;
      this.findExistingPool(target).then(async (found) => {
        if (!found || !this.armed || this.fired) return;
        let symbol = '?';
        try { symbol = String(await getContract({ address: target, abi: ERC20_ABI, client: this.httpClient }).read.symbol()); } catch {}
        this.log('info', `${describeTarget(target)} already has a live pool ($${symbol}, fee ${found.feeTier}) — buying now instead of waiting for a launch event.`);
        this.onNewToken({
          source: 'dex', token: target, symbol,
          pool: found.pool, feeTier: found.feeTier,
          txHash: null, blockNumber: null
        });
      }).catch((e) => this.log('debug', `existing-pool check failed: ${e.shortMessage || e.message}`));
    }

    this.emit('state', { armed: true, ticker: this.armed.ticker });
  }

  // Address targets only: is this token ALREADY tradeable? A pool created
  // before we armed has already emitted its one-and-only event, so waiting for
  // that event would hang forever. Checks the v3 factory across fee tiers.
  // (v4 pools can't be looked up this way — their poolId needs the hook and
  // tickSpacing, which aren't knowable in advance; those still rely on events.)
  async findExistingPool(token) {
    const factory = this.cfg.dex.factory;
    if (!factory || /^0x0+$/.test(factory)) return null;
    const pools = await existingPools(this.httpClient, this.cfg, token);
    if (!pools.length) return null;
    // Don't just take the first tier that exists — quote them and take the one
    // that actually pays best, so a thin/stale pool can't hijack the trade.
    const amountEth = this.armed?.amountEth ?? this.cfg.defaults.amountEth;
    const best = await bestBuyPool(this.httpClient, this.cfg, { token, amountEth, preferFee: pools[0].fee });
    const chosen = pools.find((p) => p.fee === best.fee) || pools[0];
    if (pools.length > 1) {
      this.log('info', `Token has ${pools.length} pools (${pools.map((p) => p.fee).join(', ')}) — routing via ${chosen.fee} (${best.reason}).`);
    }
    return { pool: chosen.pool, feeTier: chosen.fee };
  }

  // Sell a percentage of a held position back to native ETH. Independent of
  // the armed/disarmed state — you can exit a position while hunting the next.
  async sell({ token, percent, slippagePct, feeTier = null }) {
    if (!this.account) throw new Error('Unlock a wallet first.');
    this.log('info', `SELL ${percent}% of ${token.slice(0, 10)}… requested.`);
    try {
      const res = await sellPercent({
        publicClient: this.httpClient,
        walletClient: this.walletClient,
        account: this.account,
        cfg: this.cfg,
        token,
        percent,
        slippagePct: slippagePct ?? this.cfg.defaults.slippagePct,
        preferFee: feeTier,
        maxFeePerGasGwei: this.cfg.defaults.maxFeePerGasGwei,
        maxPriorityFeePerGasGwei: this.cfg.defaults.maxPriorityFeePerGasGwei,
        log: (l, m) => this.log(l, m)
      });
      this.log('success', `SOLD ${percent}% — received ${formatEther(res.ethOut)} ETH. tx: ${res.hash}`,
        { hash: res.hash, explorer: `${this.cfg.chain.explorer}/tx/${res.hash}` });
      recordSale({
        token, percent: Number(percent), soldRaw: res.soldRaw.toString(),
        ethOut: res.ethOut.toString(), feeTier: res.feeTier, txHash: res.hash, ts: Date.now()
      });
      this.emit('sold', { token, percent, hash: res.hash, ethOut: res.ethOut.toString() });
      return { hash: res.hash, ethOut: res.ethOut.toString() };
    } catch (e) {
      this.log('error', `Sell failed: ${e.shortMessage || e.message}`);
      throw e;
    }
  }

  disarm() {
    if (this.unwatch) { try { this.unwatch(); } catch {} this.unwatch = null; }
    if (this.unwatchVirtuals) { try { this.unwatchVirtuals(); } catch {} this.unwatchVirtuals = null; }
    if (this.unwatchV4) { try { this.unwatchV4(); } catch {} this.unwatchV4 = null; }
    this.armed = null;
    clearPending(); // an explicit cancel (or a confirmed fill) ends the watch for good
    this.emit('state', { armed: false });
    this.log('info', 'Disarmed.');
  }

  async onNewToken(t) {
    const src = t.source === 'virtuals' ? `virtuals:${t.phase}` : 'dex';
    this.log('debug', `New token [${src}]: $${t.symbol} (${t.token}) pool=${t.pool}${t.feeTier ? ` fee=${t.feeTier}` : ''}`);
    if (!this.armed || this.fired) return;
    if (!targetMatches(this.armed.ticker, t)) return;

    // Venue-level launchpad filter. Virtuals launches never touch the DEX
    // factory, so a DEX-launchpad filter (e.g. pons) must reject them here —
    // and vice versa — before any per-launch inspection.
    // A contract address already identifies the token uniquely, so a launchpad
    // filter can only cause a miss (e.g. it launches somewhere unexpected).
    // Address targets bypass it — announced, not silently.
    const addressMode = isAddressTarget(this.armed.ticker);
    const wantPad = addressMode ? 'any' : (this.armed.launchpad || 'any');
    if (addressMode && (this.armed.launchpad || 'any') !== 'any') {
      this.log('debug', 'Address target: ignoring the launchpad filter (the CA is already unique).');
    }
    const wantedPads = parseLaunchpads(this.cfg, wantPad);
    if (wantedPads.length) {
      const thisVenue = t.source === 'virtuals' ? 'virtuals' : t.source === 'v4' ? 'v4' : 'dex';
      if (!wantedPads.some((p) => (p.venue || 'dex') === thisVenue)) {
        this.log('debug', `Skipping $${t.symbol} — ${thisVenue} launch, filter wants ${launchpadLabel(this.cfg, wantPad)}.`);
        return;
      }
    }

    // Virtuals pre-launch: the token exists on the launchpad but trading hasn't
    // opened (Bonding.buy reverts until `launch`). Announce and keep listening —
    // the Launched event for the same token will re-match and fire.
    if (t.source === 'virtuals' && t.phase === 'prelaunch') {
      this.log('info', `🎯 $${t.symbol} spotted on the VIRTUALS launchpad (pre-launch). Trading not open yet — watching for its Launched event...`);
      return;
    }

    this.log('info', `MATCH $${t.symbol} [${src}] — verifying/executing...`);
    this.fired = true; // prevent double-fire

    try {
      // LIQUIDITY WATCH (DEX only): most launchpads seed LP in the same tx that
      // creates the pool, but some create the pool first and add liquidity later.
      // PoolCreated fires only once, so we hold this match open and fire the
      // instant liquidity lands rather than abandoning the token.
      if (t.source !== 'virtuals') {
        // ONE receipt fetch gives us both the launchpad (for the filter) and
        // proof of whether LP was minted in the same tx (for the gate below).
        const launchInfo = await inspectLaunchTx(this.httpClient, t.txHash);
        // v4 liquidity lives in the PoolManager, so the v3 Mint topic won't
        // appear — ModifyLiquidity in the launch tx is the equivalent proof.
        if (t.source === 'v4' && liquidityAddedInLogs(launchInfo.logs)) launchInfo.minted = true;

        // LAUNCHPAD FILTER: skip launches that didn't come from the chosen
        // launchpad. Checked before any waiting so a rejected launch costs
        // nothing and the sniper stays armed for the real one.
        if (!matchesLaunchpad(this.cfg, wantPad, launchInfo)) {
          this.log('info', `Skipping $${t.symbol} — not a ${launchpadLabel(this.cfg, wantPad)} launch (from ${(launchInfo.launchpad || 'unknown').slice(0, 10)}…). Still armed.`);
          this.fired = false;
          return;
        }
        if (wantedPads.length) this.log('info', `$${t.symbol} confirmed as a ${launchpadLabel(this.cfg, wantPad)} launch.`);

        const lw = await waitForLiquidity(
          { httpClient: this.httpClient, wsClient: this.wsClient },
          this.cfg, t.pool,
          { log: (l, m) => this.log(l, m), shouldAbort: () => !this.armed, launchInfo }
        );
        if (!this.armed) { this.fired = false; return; } // cancelled mid-wait
        if (!lw.ready) {
          this.log('warn', `Liquidity watch gave up on $${t.symbol}: ${lw.reason}. Still armed, still listening.`);
          this.fired = false;
          return;
        }
        if (lw.reason !== 'pool already funded') this.log('info', `Liquidity GO: ${lw.reason}.`);
      }

      // TAX WATCH: if the launch opened with an anti-sniper tax, wait it out
      // and fire the moment it clears (Virtuals: authoritative on-chain flag;
      // DEX: simulated effective-tax measurement vs the ceiling).
      if (this.armed.taxWatch !== false) {
        const tw = await waitForLowTax(this.httpClient, this.cfg, t, {
          account: this.account,
          amountEth: this.armed.amountEth,
          log: (l, m) => this.log(l, m),
          shouldAbort: () => !this.armed
        });
        if (!this.armed) { this.fired = false; return; } // cancelled mid-wait
        if (!tw.fire) {
          this.log('warn', `Tax watch gave up on $${t.symbol}: ${tw.reason}. Still armed, still listening.`);
          this.fired = false;
          return;
        }
        this.log('info', `Tax watch GO: ${tw.reason}. Firing...`);
      }

      // Uniswap v4 buy: native ETH in, via UniversalRouter V4_SWAP. There is no
      // v3 pool to quote, so the v3 safety gate / slippage ladder don't apply.
      if (t.source === 'v4') {
        this.log('debug', 'executor: UniversalRouter V4_SWAP (native ETH)');
        if (!this.armed.rawMode) this.log('warn', 'v4 pool: honeypot gate and quoter-based slippage are not available here — buying with min-out 0.');
        const res = await buildAndSendBuyV4({
          walletClient: this.walletClient, account: this.account, cfg: this.cfg,
          poolKey: t.poolKey,
          amountIn: parseEther(String(this.armed.amountEth)),
          minOut: 0n,
          maxFeePerGasGwei: this.armed.maxFeePerGasGwei,
          maxPriorityFeePerGasGwei: this.armed.maxPriorityFeePerGasGwei,
          deadlineSeconds: this.armed.deadlineSeconds
        });
        this.log('success', `TX sent (v4 swap): ${res.hash}`, { hash: res.hash, explorer: `${this.cfg.chain.explorer}/tx/${res.hash}` });
        this.emit('fired', { token: t, hash: res.hash });
        const receipt = await this.httpClient.waitForTransactionReceipt({ hash: res.hash });
        if (receipt.status === 'success') {
          this.log('success', `CONFIRMED in block ${receipt.blockNumber}. Bought $${t.symbol} (Uniswap v4).`);
          try {
            const got = tokensReceived(receipt, t.token, this.account.address);
            recordFill({
              token: t.token, symbol: t.symbol, feeTier: t.feeTier, txHash: res.hash,
              blockNumber: Number(receipt.blockNumber),
              ethIn: res.amountIn.toString(), tokensOut: got.toString(), ts: Date.now(), venue: 'v4'
            });
          } catch (e) { this.log('warn', `Could not journal the fill: ${e.message}`); }
          this.disarm();
        } else {
          this.log('error', `v4 buy reverted (${res.hash}). Still armed.`);
          this.fired = false;
        }
        return;
      }

      // Virtuals bonding-stage buy: single tx, paid in pre-funded VIRTUAL.
      if (t.source === 'virtuals') {
        this.log('debug', 'executor: Virtuals Bonding.buy (VIRTUAL-denominated)');
        // Safety gate/quoter don't apply — no v3 pool exists during bonding.
        const res = await buildAndSendBondingBuy({
          publicClient: this.httpClient, walletClient: this.walletClient, account: this.account,
          cfg: this.cfg, tokenOut: t.token,
          maxFeePerGasGwei: this.armed.maxFeePerGasGwei,
          maxPriorityFeePerGasGwei: this.armed.maxPriorityFeePerGasGwei,
          deadlineSeconds: this.armed.deadlineSeconds
        });
        this.log('success', `TX sent (bonding buy, ${formatEther(res.amountIn)} VIRTUAL): ${res.hash}`, { hash: res.hash, explorer: `${this.cfg.chain.explorer}/tx/${res.hash}` });
        this.emit('fired', { token: t, hash: res.hash });
        const receipt = await this.httpClient.waitForTransactionReceipt({ hash: res.hash });
        if (receipt.status === 'success') {
          this.log('success', `CONFIRMED in block ${receipt.blockNumber}. Bought $${t.symbol} on the Virtuals launchpad.`);
          try {
            const got = tokensReceived(receipt, t.token, this.account.address);
            recordFill({
              token: t.token, symbol: t.symbol, feeTier: null, txHash: res.hash,
              blockNumber: Number(receipt.blockNumber),
              ethIn: parseEther(String(this.armed.amountEth)).toString(), // budget spent via VIRTUAL leg
              tokensOut: got.toString(), ts: Date.now(), venue: 'virtuals'
            });
          } catch (e) { this.log('warn', `Could not journal the fill: ${e.message}`); }
          this.disarm();
        } else {
          this.log('error', `Bonding buy reverted (${res.hash}). Still armed.`);
          this.fired = false;
        }
        return;
      }

      if (this.armed.rawMode) {
        // RAW MODE: the user explicitly disabled ALL safety features for this
        // snipe. No honeypot simulation, no tax check, no quoter/min-out (the
        // executor sends amountOutMinimum=0 = accept ANY price). Pure speed.
        this.log('warn', 'RAW MODE — all safety checks skipped, min-out=0 (any price accepted). Firing immediately.');
      } else {
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
      }

      // POOL CORRECTNESS: confirm we're routing through the pool that actually
      // pays best, not just the tier the launch event happened to announce. At
      // the launch moment nothing is quotable yet and this correctly falls back
      // to the detected tier (which is by definition the launch pool). Skipped
      // in raw mode, where the extra quoting round-trip costs speed.
      let feeTier = t.feeTier;
      if (!this.armed.rawMode) {
        const route = await bestBuyPool(this.httpClient, this.cfg, {
          token: t.token, amountEth: this.armed.amountEth, preferFee: t.feeTier
        });
        if (route.quoted && route.fee !== t.feeTier) {
          this.log('info', `Pool check: routing via fee ${route.fee} instead of ${t.feeTier} — ${route.reason}.`);
          feeTier = route.fee;
        } else if (route.quoted) {
          this.log('debug', `Pool check: fee ${feeTier} confirmed best.`);
        }
      }

      const useUniversal = (this.cfg.dex.executor || 'universal-router') === 'universal-router';
      const execFn = useUniversal ? buildAndSendBuyUniversal : buildAndSendBuy;
      this.log('debug', `executor: ${useUniversal ? 'UniversalRouter' : 'SwapRouter02'}`);

      const sendOnce = (slippagePct) => execFn({
        publicClient: this.httpClient,
        walletClient: this.walletClient,
        account: this.account,
        cfg: this.cfg,
        tokenOut: t.token,
        feeTier,                       // verified best pool, not just the detected tier
        amountEth: this.armed.amountEth,
        slippagePct,
        maxFeePerGasGwei: this.armed.maxFeePerGasGwei,
        maxPriorityFeePerGasGwei: this.armed.maxPriorityFeePerGasGwei,
        deadlineSeconds: this.armed.deadlineSeconds,
        rawMode: Boolean(this.armed.rawMode)
      });

      // Smart slippage: start at the user's tolerance; if the buy fails on a
      // PRICE check (min-out revert), widen a step and retry immediately, up to
      // a hard cap. Non-price failures (funds, gas, nonce) are never retried.
      const smart = Boolean(this.armed.smartSlippage) && !this.armed.rawMode;
      const capPct = Number(this.cfg.smartSlippage?.maxPct ?? 50);
      const widen = Number(this.cfg.smartSlippage?.widenFactor ?? 2);
      const ladder = [Number(this.armed.slippagePct)];
      if (smart) {
        for (let s = ladder[0] * widen; s < capPct; s *= widen) ladder.push(Math.round(s));
        if (ladder[ladder.length - 1] < capPct) ladder.push(capPct);
      }

      let res = null;
      let receipt = null;
      for (let i = 0; i < ladder.length; i++) {
        const slip = ladder[i];
        if (i > 0) this.log('warn', `Smart slippage: widening to ${slip}% (attempt ${i + 1}/${ladder.length})...`);
        try {
          res = await sendOnce(slip);
        } catch (e) {
          if (smart && i < ladder.length - 1 && isPriceRevert(e)) {
            this.log('warn', `Buy rejected on price at ${slip}% slippage: ${e.shortMessage || e.message}`);
            continue;
          }
          throw e;
        }
        this.log('success', `TX sent (${slip}% slippage): ${res.hash}`, { hash: res.hash, explorer: `${this.cfg.chain.explorer}/tx/${res.hash}` });
        this.emit('fired', { token: t, hash: res.hash });

        receipt = await this.httpClient.waitForTransactionReceipt({ hash: res.hash });
        if (receipt.status === 'success') break;
        // Reverted on-chain — price moved between estimate and inclusion.
        if (smart && i < ladder.length - 1) {
          this.log('warn', `TX reverted on-chain at ${slip}% slippage (${res.hash}) — price moved. Widening...`);
          continue;
        }
        break;
      }

      if (receipt?.status === 'success') {
        this.log('success', `CONFIRMED in block ${receipt.blockNumber}. Bought $${t.symbol}.`);
        // Journal the fill for the portfolio/PNL view. Parse the receipt for
        // what we ACTUALLY received (handles fee-on-transfer weirdness).
        try {
          const got = tokensReceived(receipt, t.token, this.account.address);
          const ethIn = parseEther(String(this.armed.amountEth));
          recordFill({
            token: t.token,
            symbol: t.symbol,
            feeTier,                   // the pool actually used
            txHash: res.hash,
            blockNumber: Number(receipt.blockNumber),
            ethIn: ethIn.toString(),
            tokensOut: got.toString(),
            ts: Date.now()
          });
          if (got > 0n) {
            this.log('info', `Fill: ${formatEther(ethIn)} ETH -> ${got} raw units of $${t.symbol}. Run the portfolio view for live PNL.`);
          } else {
            this.log('warn', 'Fill recorded, but no incoming token transfer found in the receipt — check the tx on the explorer.');
          }
        } catch (e) {
          this.log('warn', `Could not journal the fill: ${e.message}`);
        }
      } else if (receipt) {
        this.log('error', `Transaction reverted (${res.hash}).`);
      }
      this.disarm();
    } catch (e) {
      this.log('error', `Snipe failed: ${e.shortMessage || e.message}`);
      this.fired = false;
    }
  }
}
