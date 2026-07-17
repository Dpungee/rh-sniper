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

$('armBtn')?.addEventListener('click', async ()=>{
  const ticker = $('ticker').value.trim();
  if (!ticker){ alert('Enter a ticker.'); return; }
  const params = {
    ticker,
    amountEth: $('amount').value.trim(),
    slippagePct: Number($('slippage').value),
    maxFeePerGasGwei: $('maxfee').value.trim(),
    maxPriorityFeePerGasGwei: $('prio').value.trim(),
    deadlineSeconds: cfg.defaults.deadlineSeconds,
    rawMode: $('rawMode').checked,
    smartSlippage: $('smartSlippage').checked
  };
  try{ await window.api.arm(params); }catch(e){ alert(e.message); }
});

$('disarmBtn')?.addEventListener('click', async ()=>{ await window.api.disarm(); });

// ---- Holdings & PNL ----
const fmt = (n, dp=6) => (n===null||n===undefined) ? '?' : (Number(n).toFixed(dp).replace(/\.?0+$/,'') || '0');

async function refreshPortfolio(){
  const btn = $('pfBtn'); btn.disabled = true; btn.textContent = '…';
  try{
    const p = await window.api.portfolio();
    const t = p.totals;
    const pnlCls = t.pnlEth >= 0 ? 'pf-up' : 'pf-down';
    $('pfTotals').innerHTML =
      `wallet <b>${fmt(p.ethBalance,4)} ETH</b> · tokens <b>${fmt(t.valueEth,4)} ETH</b>` +
      (t.costEth ? ` · cost ${fmt(t.costEth,4)} · <span class="${pnlCls}">PNL ${t.pnlEth>=0?'+':''}${fmt(t.pnlEth,4)} ETH</span>` : '');
    const list = $('pfList'); list.innerHTML = '';
    if (!p.holdings.length){ list.innerHTML = '<div class="muted small">no token holdings</div>'; return; }
    for (const h of p.holdings){
      const row = document.createElement('div');
      row.className = 'pf-row';
      const val = h.valueEth===null ? '<span class="muted">unquotable</span>' : `${fmt(h.valueEth,4)} ETH`;
      const pnl = h.pnlEth===null ? '' :
        `<span class="${h.pnlEth>=0?'pf-up':'pf-down'}">${h.pnlEth>=0?'+':''}${fmt(h.pnlEth,4)} (${h.pnlPct>=0?'+':''}${fmt(h.pnlPct,1)}%)</span>`;
      row.innerHTML = `<a class="pf-sym" target="_blank" href="${p.explorer}/token/${h.token}">$${h.symbol}</a>` +
        `<span class="pf-bal muted">${h.balanceFmt>=1e6?h.balanceFmt.toExponential(2):fmt(h.balanceFmt,2)}</span>` +
        `<span class="pf-val">${val}</span><span class="pf-pnl">${pnl}</span>`;
      list.appendChild(row);
    }
  }catch(e){ $('pfTotals').textContent = e.message; }
  finally{ btn.disabled = false; btn.textContent = 'refresh'; }
}
$('pfBtn')?.addEventListener('click', refreshPortfolio);
// Auto-refresh after a fill lands.
window.api.onFired(()=> setTimeout(refreshPortfolio, 4000));

init();
