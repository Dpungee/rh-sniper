const $ = (id) => document.getElementById(id);

let cfg = null;

function fmtTime(ts){ const d = new Date(ts); return d.toLocaleTimeString([], {hour12:false}); }

function addLog({ ts, level, msg, data }){
  const el = document.createElement('div');
  el.className = 'line';
  const cls = { info:'l-info', debug:'l-debug', success:'l-success', warn:'l-warn', error:'l-error' }[level] || 'l-info';
  el.innerHTML = `<span class="t">${fmtTime(ts)} </span><span class="${cls}"></span>`;
  el.querySelector(`.${cls}`).textContent = msg;
  if (data?.explorer){
    const a = document.createElement('a');
    a.href = data.explorer; a.target = '_blank'; a.textContent = ' ↗';
    el.appendChild(a);
  }
  const log = $('log');
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function setStatus(state){
  const pill = $('statusPill');
  if (state === 'armed'){ pill.className='pill armed'; pill.textContent='armed'; $('armBtn').classList.add('hidden'); $('disarmBtn').classList.remove('hidden'); }
  else if (state === 'hit'){ pill.className='pill hit'; pill.textContent='hit'; }
  else { pill.className='pill idle'; pill.textContent='idle'; $('armBtn').classList.remove('hidden'); $('disarmBtn').classList.add('hidden'); }
}

async function init(){
  cfg = await window.api.getConfig();
  $('wallet').textContent = cfg.address ? (cfg.address.slice(0,6)+'…'+cfg.address.slice(-4)) : 'no wallet';

  // Wallet gate
  if (!cfg.hasKey){ $('importBox').classList.remove('hidden'); }
  else { $('unlockBox').classList.remove('hidden'); $('lockedAddr').textContent = cfg.address; }

  // Launchpad filter options come from config, so adding a launchpad there
  // shows up here without touching the UI.
  for (const p of (cfg.launchpads || [])) {
    const o = document.createElement('option');
    o.value = p.key; o.textContent = p.name + ' only';
    $('launchpad').appendChild(o);
  }

  // Prefill defaults
  $('amount').value = cfg.defaults.amountEth;
  $('slippage').value = cfg.defaults.slippagePct;
  $('maxfee').value = cfg.defaults.maxFeePerGasGwei;
  $('prio').value = cfg.defaults.maxPriorityFeePerGasGwei;

  // Config warnings
  const warns = [];
  if (!cfg.factorySet) warns.push('DEX factory address not set in config.json — listener has nothing to watch.');
  if (!cfg.routerSet) warns.push('Router address not set — snipes cannot execute.');
  if (!cfg.safetyEnabled) warns.push('Safety gate OFF (raw speed). Honeypots will not be filtered.');
  if (warns.length){ const w=$('warn'); w.classList.remove('hidden'); w.textContent = '⚠ ' + warns.join('  '); }

  window.api.onLog(addLog);
  window.api.onState((s)=> setStatus(s.armed ? 'armed' : 'idle'));
  window.api.onFired(()=> setStatus('hit'));
}

$('importBtn')?.addEventListener('click', async ()=>{
  try{
    const { address } = await window.api.importKey($('pkInput').value, $('pkPass').value);
    $('importBox').classList.add('hidden');
    $('unlockBox').classList.remove('hidden');
    $('lockedAddr').textContent = address;
    $('wallet').textContent = address.slice(0,6)+'…'+address.slice(-4);
  }catch(e){ alert(e.message); }
});

$('unlockBtn')?.addEventListener('click', async ()=>{
  try{
    const { address } = await window.api.unlock($('unlockPass').value);
    $('lockPane').classList.add('hidden');
    $('mainPane').classList.remove('hidden');
    $('wallet').textContent = address.slice(0,6)+'…'+address.slice(-4);
    addLog({ ts:Date.now(), level:'info', msg:`Unlocked ${address}` });
  }catch(e){ alert(e.message); }
});

// Reflect what kind of target was typed: an exact contract, or a ticker.
const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v||'').trim());
$('ticker')?.addEventListener('input', ()=>{
  const v = $('ticker').value.trim();
  const addr = isAddr(v);
  $('tickerSigil').textContent = addr ? '#' : '$';
  $('ticker').style.fontSize = addr ? '13px' : '';
  $('ticker').style.textTransform = addr ? 'none' : '';
  $('targetHint').textContent = addr
    ? '✓ Exact contract address — cannot be spoofed by a copycat ticker.'
    : (v.length && !/^0x/i.test(v)
        ? 'Ticker mode: symbols are NOT unique — a copycat with the same ticker can be hit instead.'
        : 'A contract address is exact — it can\'t be spoofed by a copycat ticker.');
  $('targetHint').className = 'small ' + (addr ? 'pf-up' : (v.length && !/^0x/i.test(v) ? 'warn' : 'muted'));
});

$('armBtn')?.addEventListener('click', async ()=>{
  const ticker = $('ticker').value.trim();
  if (!ticker){ alert('Enter a ticker or contract address.'); return; }
  if (/^0x/i.test(ticker) && !isAddr(ticker)){ alert('That looks like a contract address but is not valid.\n\nAn address must be 0x followed by 40 hex characters.'); return; }
  const params = {
    ticker,
    amountEth: $('amount').value.trim(),
    slippagePct: Number($('slippage').value),
    maxFeePerGasGwei: $('maxfee').value.trim(),
    maxPriorityFeePerGasGwei: $('prio').value.trim(),
    deadlineSeconds: cfg.defaults.deadlineSeconds,
    rawMode: $('rawMode').checked,
    smartSlippage: $('smartSlippage').checked,
    taxWatch: $('taxWatch').checked,
    launchpad: $('launchpad').value
  };
  try{ await window.api.arm(params); }catch(e){ alert(e.message); }
});

$('disarmBtn')?.addEventListener('click', async ()=>{ await window.api.disarm(); });

// ---- Holdings & PNL ----
const fmt = (n, dp=6) => (n===null||n===undefined) ? '?' : (Number(n).toFixed(dp).replace(/\.?0+$/,'') || '0');

const SELL_STEPS = [10, 25, 50, 100];
let selling = false;

async function doSell(h, pct, btn){
  if (selling) return;
  const label = pct === 100 ? 'ALL' : pct + '%';
  const est = h.valueEth !== null ? ` (~${fmt(h.valueEth * pct/100, 5)} ETH)` : '';
  if (!confirm(`Sell ${label} of $${h.symbol}${est}?\n\nThis sends a real transaction and cannot be undone.`)) return;
  selling = true;
  const old = btn.textContent; btn.textContent = '…'; btn.disabled = true;
  try{
    await window.api.sell(h.token, pct, undefined, h.feeTier ?? undefined);
    // engine logs the result; refresh once it has settled
    setTimeout(refreshPortfolio, 2500);
  }catch(e){ alert('Sell failed: ' + (e?.message || e)); }
  finally{ selling = false; btn.textContent = old; btn.disabled = false; }
}

async function refreshPortfolio(){
  const btn = $('pfBtn'); btn.disabled = true; btn.textContent = '…';
  try{
    const p = await window.api.portfolio();
    const t = p.totals;
    const pnlCls = t.pnlEth >= 0 ? 'pf-up' : 'pf-down';
    const realised = t.realisedEth ? ` · realised <span class="pf-up">+${fmt(t.realisedEth,4)} ETH</span>` : '';
    $('pfTotals').innerHTML =
      `wallet <b>${fmt(p.ethBalance,4)} ETH</b> · tokens <b>${fmt(t.valueEth,4)} ETH</b>` +
      (t.costEth ? ` · cost ${fmt(t.costEth,4)} · <span class="${pnlCls}">unrealised ${t.pnlEth>=0?'+':''}${fmt(t.pnlEth,4)} ETH</span>` : '') +
      realised;
    const list = $('pfList'); list.innerHTML = '';
    if (!p.holdings.length){ list.innerHTML = '<div class="muted small">no open positions</div>'; return; }
    for (const h of p.holdings){
      const row = document.createElement('div');
      row.className = 'pf-pos';
      const val = h.valueEth===null ? '<span class="muted">unquotable</span>' : `${fmt(h.valueEth,4)} ETH`;
      const pnl = h.pnlEth===null ? '' :
        `<span class="${h.pnlEth>=0?'pf-up':'pf-down'}">${h.pnlEth>=0?'+':''}${fmt(h.pnlEth,4)} ETH (${h.pnlPct>=0?'+':''}${fmt(h.pnlPct,1)}%)</span>`;
      const head = document.createElement('div');
      head.className = 'pf-row';
      head.innerHTML = `<a class="pf-sym" target="_blank" href="${p.explorer}/token/${h.token}">$${h.symbol}</a>` +
        `<span class="pf-bal muted">${h.balanceFmt>=1e6?h.balanceFmt.toExponential(2):fmt(h.balanceFmt,2)}</span>` +
        `<span class="pf-val">${val}</span><span class="pf-pnl">${pnl}</span>`;
      row.appendChild(head);
      // sell buttons — skip WETH (nothing to route) and dust
      if (h.balanceFmt > 0 && h.symbol !== 'WETH'){
        const bar = document.createElement('div');
        bar.className = 'sell-bar';
        for (const pct of SELL_STEPS){
          const b = document.createElement('button');
          b.className = 'sell-btn' + (pct===100?' sell-all':'');
          b.textContent = pct===100 ? 'SELL ALL' : pct + '%';
          b.addEventListener('click', ()=> doSell(h, pct, b));
          bar.appendChild(b);
        }
        row.appendChild(bar);
      }
      list.appendChild(row);
    }
  }catch(e){ $('pfTotals').textContent = e.message; }
  finally{ btn.disabled = false; btn.textContent = 'refresh'; }
}
$('pfBtn')?.addEventListener('click', refreshPortfolio);
window.api.onFired(()=> setTimeout(refreshPortfolio, 4000));
window.api.onSold(()=> setTimeout(refreshPortfolio, 1500));

// Live monitoring: poll while positions are open so PNL tracks the market.
setInterval(()=>{ if ($('pfAuto')?.checked && !selling) refreshPortfolio(); }, 20000);

init();
