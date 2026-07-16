// Headless sniper — runs the full arm→listen→fire lifecycle with no Electron UI.
// Built for unattended 24/7 operation on an always-on machine / VPS.
//
//   npm run snipe -- --ticker PEPE --amount 0.01 --slippage 15
//   npm run snipe -- --resume            # resume the snipe saved in ~/.rh-sniper/pending.json
//
// Password: env RH_PASSWORD (or .env) for unattended runs; prompts if absent.
// Exit codes (the auto-restart wrappers key off these):
//   0 = snipe completed (bought + confirmed) or explicitly disarmed — do NOT restart
//   1 = crash / unexpected exit — restart me
//   2 = bad usage / no keystore / wrong password — do NOT restart (fix first)
import readline from 'node:readline';
import { Sniper } from '../src/engine/sniper.js';
import { unlock, keystoreExists, savedAddress } from '../src/engine/keystore.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function ask(q, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    if (hidden) { rl.stdoutMuted = true; rl._writeToOutput = () => {}; }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a); });
  });
}

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!keystoreExists()) {
    console.error('No keystore found. Import a key first: npm run keystore import');
    process.exit(2);
  }

  const sniper = new Sniper();
  let wasArmed = false;

  sniper.on('log', (e) => {
    const line = `[${ts()}] ${e.level.toUpperCase().padEnd(7)} ${e.msg}`;
    (e.level === 'error' ? console.error : console.log)(line);
    if (e.data?.explorer) console.log(`[${ts()}]         ${e.data.explorer}`);
  });
  sniper.on('fired', (e) => console.log(`[${ts()}] FIRED   $${e.token.symbol} tx=${e.hash}`));
  sniper.on('state', (e) => {
    if (e.armed) { wasArmed = true; return; }
    // armed:false after being armed = the snipe ended for good (a confirmed buy
    // calls disarm(), as does an explicit cancel). Exit 0 = wrappers don't restart.
    if (wasArmed) { console.log(`[${ts()}] Snipe lifecycle complete. Exiting.`); process.exit(0); }
  });

  // ---- unlock ----
  let password = process.env.RH_PASSWORD;
  if (!password) {
    if (!process.stdin.isTTY) {
      // Non-interactive (service / wrapper with no terminal): we can't prompt.
      // Without this check, readline dies silently and we'd exit 0 ("done").
      console.error('No RH_PASSWORD set and no terminal to prompt on. Set RH_PASSWORD in .env for unattended runs.');
      process.exit(2);
    }
    process.stdout.write(`Password for ${savedAddress()}`);
    password = await ask(': ', true);
  }
  let account;
  try { account = unlock(password); }
  catch (e) { console.error(`Unlock failed: ${e.message}`); process.exit(2); }

  // NOTE: useAccount() auto-resumes any pending snipe from ~/.rh-sniper/pending.json.
  sniper.useAccount(account);

  // ---- arm (unless we already resumed, or --resume was all that's wanted) ----
  if (args.resume) {
    if (!sniper.armed) { console.error('Nothing to resume (no pending snipe saved).'); process.exit(2); }
  } else if (args.ticker) {
    const cfg = sniper.cfg;
    sniper.arm({
      ticker: String(args.ticker),
      amountEth: String(args.amount ?? cfg.defaults.amountEth),
      slippagePct: Number(args.slippage ?? cfg.defaults.slippagePct),
      maxFeePerGasGwei: Number(args.gas ?? cfg.defaults.maxFeePerGasGwei),
      maxPriorityFeePerGasGwei: Number(args.prio ?? cfg.defaults.maxPriorityFeePerGasGwei),
      deadlineSeconds: Number(args.deadline ?? cfg.defaults.deadlineSeconds),
      rawMode: Boolean(args.raw) // --raw = ALL safety checks off for this snipe
    });
  } else if (!sniper.armed) {
    console.error('Usage: npm run snipe -- --ticker SYMBOL [--amount ETH] [--slippage PCT] [--gas GWEI] [--prio GWEI] [--raw]');
    console.error('       npm run snipe -- --resume');
    console.error('  --raw   turn ALL safety checks off (no honeypot/tax simulation)');
    process.exit(2);
  }

  // Ctrl+C = cancel the snipe for good (clears pending.json, exits 0 = no restart).
  process.on('SIGINT', () => {
    console.log(`\n[${ts()}] Ctrl+C — cancelling snipe and clearing saved state.`);
    try { sniper.disarm(); } catch {} // emits state:disarmed → clean exit 0 above
    process.exit(0);
  });

  // Stay alive until fired+confirmed or cancelled.
  await new Promise(() => {});
}

main().catch((e) => { console.error(`FATAL: ${e?.stack || e}`); process.exit(1); });
