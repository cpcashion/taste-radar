// Taste Radar app dashboard
const $ = (id) => document.getElementById(id);
const fmtN = (n) => n == null ? '—' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : `${n}`;
const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });

async function boot() {
  const me = await fetch('/api/me').then(r => r.json()).catch(() => ({ logged_in: false }));
  if (!me.logged_in) { location.href = '/auth/spotify'; return; }
  $('loading').style.display = 'none';
  $('app').style.display = 'block';
  $('hello').textContent = me.display_name ? `Hi, ${me.display_name}` : 'My Radar';
  $('planLine').textContent = me.paid ? 'Radar Pro · $1/month' : 'Free plan';
  $('cardsUsed').textContent = me.cards.limit === Infinity ? 'unlimited (Pro)' : `${me.cards.used} of ${me.cards.limit}`;
  renderBilling(me);
  await loadProfile();
  $('scanBtn').addEventListener('click', runScan);
  $('deleteAcct').addEventListener('click', deleteAccount);
}

function renderBilling(me) {
  const box = $('billingBox');
  if (me.paid) {
    box.innerHTML = `<p class="small"><strong style="color:var(--accent)">Radar Pro active.</strong> Manage or cancel anytime via Stripe.</p>
      <button class="btn ghost small-btn" id="portalBtn">Manage subscription</button>`;
    $('portalBtn').addEventListener('click', async () => {
      alert('To cancel, use the Stripe receipt email link, or contact support and we will cancel it for you.');
    });
  } else {
    box.innerHTML = `<button class="btn small-btn" id="upgradeBtn">Go Pro — $1/month</button>
      <p class="small muted" style="margin-top:8px">Unlimited cards · all styles · full ledger history · milestone alerts</p>`;
    $('upgradeBtn').addEventListener('click', async () => {
      const r = await fetch('/api/checkout', { method: 'POST' });
      const d = await r.json();
      if (d.url) location.href = d.url;
      else alert(d.error === 'billing_not_configured' ? 'Billing is not enabled yet.' : 'Checkout failed. Try again.');
    });
  }
}

async function runScan() {
  const btn = $('scanBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Scanning…';
  try {
    const r = await fetch('/api/scan', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || d.error || 'scan failed');
    await loadProfile(true);
    alert(`Scanned ${d.tracks} liked tracks and ${d.artists} artists. ${d.new_ledger_entries} new ledger ${d.new_ledger_entries === 1 ? 'entry' : 'entries'}.`);
  } catch (e) {
    alert('Scan failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan library';
  }
}

async function loadProfile(afterScan) {
  const r = await fetch('/api/profile');
  if (r.status === 401) { location.href = '/auth/spotify'; return; }
  const p = await r.json();
  if (!p.scanned) { $('noScan').style.display = 'block'; return; }
  $('noScan').style.display = 'none';
  $('profile').style.display = 'block';

  $('scoreNum').textContent = p.taste_score.score;
  $('scoreWhy').textContent = p.taste_score.breakdown;

  $('genres').innerHTML = p.top_genres.map(g => `<span class="chip">${g.genre}</span>`).join('') || '<span class="muted">No genres found.</span>';

  $('gemsSub').textContent = `${p.hidden_gems.length} artists under 45 popularity in your library.`;
  $('gems').innerHTML = p.hidden_gems.map(a => `
    <a class="gem" href="/card/${a.id}">
      ${a.image ? `<img src="/api/img?url=${encodeURIComponent(a.image)}" alt="" loading="lazy">` : ''}
      <div class="name">${escapeHtml(a.name)}</div>
      <div class="meta">${fmtN(a.followers)} followers · pop. ${a.popularity ?? '—'}</div>
    </a>`).join('');

  const ledger = await fetch('/api/ledger').then(r => r.json()).catch(() => ({ entries: [] }));
  $('ledger').innerHTML = ledger.entries.length
    ? `<table class="ledger"><tr><th>Artist</th><th>First seen</th></tr>` +
      ledger.entries.map(e => `<tr><td>${escapeHtml(e.artist_name)}</td><td class="muted">${fmtDate(e.first_seen_at)}</td></tr>`).join('') + `</table>`
    : '<p class="muted">Your ledger fills up on your first scan.</p>';
  $('ledgerNote').textContent = ledger.limited
    ? 'Showing your 10 latest entries. Radar Pro unlocks full history.'
    : `${ledger.entries.length} entries total.`;

  const alertsBox = $('alerts');
  if (!p.paid) {
    alertsBox.innerHTML = `<div class="notice">Milestone alerts are a <strong>Radar Pro</strong> feature. <a href="/pricing" style="color:#ffe3a3">Go Pro — $1/month</a></div>`;
  } else {
    const al = await fetch('/api/alerts').then(r => r.json()).catch(() => ({ alerts: [] }));
    alertsBox.innerHTML = al.alerts.length
      ? al.alerts.map(x => `<div class="alert"><strong>${escapeHtml(x.artist_name)}</strong> crossed <strong>${fmtN(x.threshold)} followers</strong> <span class="muted">· ${fmtDate(x.created_at)}</span></div>`).join('')
      : '<p class="muted">No milestones crossed yet. We check your ledger artists on a schedule.</p>';
  }
}

async function deleteAccount(e) {
  e.preventDefault();
  if (!confirm('Delete your Taste Radar account and all data? This cannot be undone.')) return;
  if (!confirm('Really delete everything?')) return;
  const r = await fetch('/api/account/delete', { method: 'POST' });
  if (r.ok) location.href = '/';
  else alert('Delete failed. Try again.');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

boot();
