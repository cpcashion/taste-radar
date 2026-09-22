// Taste Radar share cards — 1080x1350 canvas, 3 styles, save + native share.
const $ = (id) => document.getElementById(id);
const artistId = location.pathname.split('/card/')[1]?.split('?')[0];
let data = null;
let style = 'radar';
let imgEl = null;

const STYLES = {
  radar:    { bg1: '#0a0f1e', bg2: '#12233d', accent: '#00ffa3', sub: '#9fd8c3', ring: 'rgba(0,255,163,0.25)', label: 'Radar' },
  nocturne: { bg1: '#120a1e', bg2: '#2a1240', accent: '#ff5da2', sub: '#d8a9c9', ring: 'rgba(255,93,162,0.25)', label: 'Nocturne' },
  signal:   { bg1: '#160f06', bg2: '#33200a', accent: '#ffb020', sub: '#e8c98a', ring: 'rgba(255,176,32,0.28)', label: 'Signal' },
};

const fmtN = (n) => n == null ? '—' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : `${n}`;
const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = '/api/img?url=' + encodeURIComponent(src);
  });
}

function fitFont(ctx, text, maxWidth, base, weight) {
  let size = base;
  ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`;
  while (ctx.measureText(text).width > maxWidth && size > 20) {
    size -= 6;
    ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`;
  }
  return size;
}

function drawCard() {
  const s = STYLES[style];
  const cv = $('cardCanvas');
  const ctx = cv.getContext('2d');
  const W = 1080, H = 1350;

  // background
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, s.bg2); g.addColorStop(0.55, s.bg1); g.addColorStop(1, s.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // radar rings
  ctx.strokeStyle = s.ring; ctx.lineWidth = 3;
  const cx = W/2, cy = 560;
  [180, 300, 420, 540].forEach(r => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke(); });
  ctx.beginPath(); ctx.moveTo(cx-560, cy); ctx.lineTo(cx+560, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy-560); ctx.lineTo(cx, cy+560); ctx.stroke();
  // sweep line
  const sweep = ctx.createLinearGradient(cx, cy, cx+500, cy-260);
  sweep.addColorStop(0, s.accent); sweep.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.strokeStyle = sweep; ctx.lineWidth = 10; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx+500, cy-260); ctx.stroke();

  // eyebrow
  ctx.fillStyle = s.accent; ctx.textAlign = 'center';
  fitFont(ctx, 'T A S T E   R A D A R', 700, 44, 800);
  ctx.fillText('T A S T E   R A D A R', cx, 130);

  // artist image in accent ring
  const ir = 250, iy = 560;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, iy, ir+14, 0, Math.PI*2);
  ctx.strokeStyle = s.accent; ctx.lineWidth = 12; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, iy, ir, 0, Math.PI*2); ctx.clip();
  if (imgEl) {
    const ar = imgEl.width / imgEl.height;
    let dw, dh;
    if (ar >= 1) { dh = ir*2; dw = dh*ar; } else { dw = ir*2; dh = dw/ar; }
    ctx.drawImage(imgEl, cx-dw/2, iy-dh/2, dw, dh);
  } else {
    ctx.fillStyle = '#1a2440'; ctx.fillRect(cx-ir, iy-ir, ir*2, ir*2);
    ctx.fillStyle = s.sub; fitFont(ctx, '?', 200, 160, 800); ctx.fillText('?', cx, iy+55);
  }
  ctx.restore();

  // artist name
  const name = data.artist.name || 'Unknown artist';
  ctx.fillStyle = '#ffffff';
  const ns = fitFont(ctx, name.toUpperCase(), 920, 96, 900);
  ctx.fillText(name.toUpperCase(), cx, 950);

  // followers + popularity
  ctx.fillStyle = s.sub; fitFont(ctx, '', 700, 44, 600);
  ctx.font = `600 44px system-ui, -apple-system, sans-serif`;
  const stats = `${fmtN(data.artist.followers)} followers · popularity ${data.artist.popularity ?? '—'}`;
  ctx.fillText(stats, cx, 1015);

  // heard-it-first badge
  const badgeY = 1100;
  if (data.in_ledger && data.first_seen_at) {
    ctx.fillStyle = s.accent;
    roundRect(ctx, cx-380, badgeY-58, 760, 96, 48); ctx.fill();
    ctx.fillStyle = '#06130d';
    fitFont(ctx, `HEARD IT FIRST · ${fmtDate(data.first_seen_at).toUpperCase()}`, 700, 40, 800);
    ctx.fillText(`HEARD IT FIRST · ${fmtDate(data.first_seen_at).toUpperCase()}`, cx, badgeY+8);
  } else {
    ctx.strokeStyle = s.accent; ctx.lineWidth = 4;
    roundRect(ctx, cx-300, badgeY-58, 600, 96, 48); ctx.stroke();
    ctx.fillStyle = s.accent;
    fitFont(ctx, 'ON MY RADAR', 600, 40, 800);
    ctx.fillText('ON MY RADAR', cx, badgeY+8);
  }

  // footer
  ctx.fillStyle = s.sub; ctx.font = `600 36px system-ui, -apple-system, sans-serif`;
  ctx.fillText('You heard it first.', cx, 1260);
  ctx.fillStyle = s.accent; ctx.font = `800 32px system-ui, -apple-system, sans-serif`;
  ctx.fillText(`TASTE SCORE ${data.taste_score}/100`, cx, 1305);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

function setStyle(next) {
  if (!data) return;
  if (next !== 'radar' && !data.paid) {
    if (confirm('Nocturne and Signal styles are Radar Pro ($1/month). Upgrade now?')) location.href = '/pricing.html';
    return;
  }
  style = next;
  document.querySelectorAll('.style-btn').forEach(b => b.classList.toggle('active', b.dataset.style === style));
  drawCard();
}

async function boot() {
  if (!artistId) { $('loading').innerHTML = '<p class="muted">No artist selected.</p>'; return; }
  const r = await fetch('/api/card-data/' + encodeURIComponent(artistId));
  if (r.status === 401) { location.href = '/auth/spotify'; return; }
  if (!r.ok) { $('loading').innerHTML = '<p class="muted">Artist not found. Scan your library first.</p>'; return; }
  data = await r.json();

  document.querySelectorAll('.style-btn').forEach(b => {
    if (b.dataset.style !== 'radar' && !data.paid) {
      b.classList.add('locked');
      b.textContent += ' · Pro';
    }
    b.addEventListener('click', () => setStyle(b.dataset.style));
  });

  imgEl = await loadImage(data.artist.image);
  drawCard();
  $('loading').style.display = 'none';
  $('stage').style.display = 'flex';

  const remaining = data.cards;
  $('cardNote').textContent = remaining.limit === Infinity
    ? 'Radar Pro · unlimited cards'
    : `Free plan · ${remaining.remaining} of ${remaining.limit} cards left this month`;

  $('saveBtn').addEventListener('click', saveImage);
  $('shareBtn').addEventListener('click', shareImage);
}

async function consumeOrThrow() {
  const r = await fetch('/api/cards/consume', { method: 'POST' });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || 'Card limit reached.');
}

function canvasBlob() {
  return new Promise((res) => $('cardCanvas').toBlob(res, 'image/png'));
}

async function saveImage() {
  const btn = $('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await consumeOrThrow();
    const blob = await canvasBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `taste-radar-${artistId}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Save image';
  }
}

async function shareImage() {
  const btn = $('shareBtn');
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    await consumeOrThrow();
    const blob = await canvasBlob();
    const file = new File([blob], `taste-radar-${artistId}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Taste Radar', text: 'You heard it first.' });
    } else {
      await saveImage();
    }
  } catch (e) {
    if (e.name !== 'AbortError') alert(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Share';
  }
}

boot();
