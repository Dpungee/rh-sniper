// Target matching. A snipe targets either a TICKER or a contract ADDRESS, and
// this decides whether a newly-seen token is the one we're waiting for.
//
// ADDRESS mode is the precise one: a contract address is unique, so it cannot
// be spoofed. Prefer it whenever the CA is known ahead of the launch.
//
// TICKER mode is the loose one: on-chain symbols are NOT unique, and scammers
// spam duplicates of anticipated tickers specifically to catch snipers. A
// ticker match can therefore hit the wrong token; the safety gate mitigates
// this but cannot fully solve it.

export function normalizeTicker(t) {
  return String(t || '').trim().replace(/^\$/, '').toUpperCase();
}

// Is this target a contract address rather than a ticker?
export function isAddressTarget(target) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(target || '').trim());
}

// Canonical form for storing/comparing a target.
export function normalizeTarget(target) {
  const raw = String(target || '').trim();
  return isAddressTarget(raw) ? raw.toLowerCase() : normalizeTicker(raw);
}

export function tickerMatches(target, candidateSymbol) {
  const a = normalizeTicker(target);
  const b = normalizeTicker(candidateSymbol);
  return a.length > 0 && a === b;
}

// Does this candidate token match the snipe's target?
// Address targets compare against the token's contract address; ticker targets
// compare against its symbol.
export function targetMatches(target, candidate) {
  const t = String(target || '').trim();
  if (!t) return false;
  if (isAddressTarget(t)) {
    return String(candidate?.token || '').toLowerCase() === t.toLowerCase();
  }
  return tickerMatches(t, candidate?.symbol);
}

// How to describe the target in logs.
export function describeTarget(target) {
  return isAddressTarget(target) ? `CA ${target}` : `$${normalizeTicker(target)}`;
}
