// Ticker matching. Given a target ticker and a stream of newly created tokens,
// decide whether a token matches. Case-insensitive, tolerant of a leading '$'.
//
// NOTE: on-chain symbols are NOT unique. Multiple tokens can share a ticker.
// This resolver matches by symbol only (raw-speed mode). If you later enable
// the safety gate, matched candidates get verified before firing.

export function normalizeTicker(t) {
  return String(t || '').trim().replace(/^\$/, '').toUpperCase();
}

export function tickerMatches(target, candidateSymbol) {
  const a = normalizeTicker(target);
  const b = normalizeTicker(candidateSymbol);
  return a.length > 0 && a === b;
}
