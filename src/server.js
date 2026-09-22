// Taste Radar — Express server. Mobile web app: Spotify OAuth (PKCE), library
// ingestion, taste profile + Taste Score, discovery ledger, milestone alerts,
// share cards, Stripe Radar Pro ($1/month), privacy controls.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const db = require('./db');
const spotify = require('./spotify');
const { computeTasteScore } = require('./score');
const stripeLib = require('./stripe');

const PORT = parseInt(process.env.PORT || '3000', 10);
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-cookie-secret-change-me';
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(cookieParser(COOKIE_SECRET));

// Stripe webhook needs the raw body — mount before the JSON parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.use(express.json({ limit: '1mb' }));

// ---------- helpers ----------
const redirectUri = () =>
  process.env.SPOTIFY_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-library-read',
  'user-top-read',
  'user-read-recently-played',
  'user-follow-read',
].join(' ');

function getSession(req) {
  const token = req.signedCookies && req.signedCookies.tr_session;
  if (!token) return null;
  const s = db.getSession(token);
  if (!s || s.expires_at < Date.now()) {
    if (s) db.deleteSession(token);
    return null;
  }
  return s;
}

function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'not_authenticated' });
  req.session = s;
  req.userId = s.user_id;
  next();
}

function requirePaid(req, res, next) {
  const user = db.getUserById(req.userId);
  if (!user || !user.paid) {
    return res.status(402).json({ error: 'pro_required', message: 'Radar Pro unlocks this feature.' });
  }
  next();
}

function setSessionCookie(res, token) {
  res.cookie('tr_session', token, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: APP_URL.startsWith('https://'),
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  });
}

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// fetch with a hard timeout so one slow upstream call can't hang a request
const fetchT = (url, opts = {}, ms = 15000) =>
  fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });

const fmtFollowers = (n) => {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
};

// ---------- health ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Spotify OAuth (PKCE, no client secret) ----------
app.get('/auth/spotify', (req, res) => {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  db.storePkce(state, verifier);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: spotify.clientId(),
    scope: SCOPES,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
    if (!code || !state) return res.status(400).send('Missing code or state.');
    const pkce = db.takePkce(state);
    if (!pkce) return res.status(400).send('Invalid or expired login attempt. Please try again.');

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: spotify.clientId(),
      code_verifier: pkce.verifier,
    });
    const tokenRes = await fetchT('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text().catch(() => '');
      console.error('token exchange failed', tokenRes.status, t.slice(0, 200));
      return res.status(502).send('Spotify login failed. Please try again.');
    }
    const tokens = await tokenRes.json();

    const meRes = await fetchT('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!meRes.ok) return res.status(502).send('Could not read your Spotify profile.');
    const me = await meRes.json();

    const userId = db.upsertUser({
      spotifyId: me.id,
      displayName: me.display_name || me.id,
      email: me.email || null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });

    const token = db.createSession(userId);
    setSessionCookie(res, token);
    res.redirect('/app.html');
  } catch (e) {
    console.error('callback error', e);
    res.status(500).send('Login failed. Please try again.');
  }
});

app.get('/auth/logout', (req, res) => {
  const token = req.signedCookies && req.signedCookies.tr_session;
  if (token) db.deleteSession(token);
  res.clearCookie('tr_session', { path: '/' });
  res.redirect('/');
});

// ---------- account ----------
app.get('/api/me', (req, res) => {
  const s = getSession(req);
  if (!s) return res.json({ logged_in: false });
  const user = db.getUserById(s.user_id);
  if (!user) return res.json({ logged_in: false });
  res.json({
    logged_in: true,
    display_name: user.display_name,
    paid: !!user.paid,
    scanned_at: user.scanned_at || null,
    cards: db.cardsRemaining(user.id),
  });
});

// ---------- library scan ----------
const scanLocks = new Set();

app.post('/api/scan', requireAuth, async (req, res) => {
  if (scanLocks.has(req.userId)) {
    return res.status(429).json({ error: 'scan_in_progress' });
  }
  scanLocks.add(req.userId);
  try {
    // 1) All liked tracks -> artist ids (track.artist objects carry id+name only)
    const likedArtistIds = new Set();
    let trackCount = 0;
    {
      let offset = 0;
      let total = 1;
      while (offset < total) {
        const data = await spotify.api(req.userId, `/me/tracks?limit=50&offset=${offset}`);
        total = data.total || 0;
        for (const item of data.items || []) {
          if (!item.track) continue;
          trackCount++;
          for (const a of item.track.artists || []) likedArtistIds.add(a.id);
        }
        offset += 50;
      }
    }

    // 2) Followed artists (cursor pagination) — full artist objects
    const followed = [];
    {
      let after = null;
      for (;;) {
        const q = `/me/following?type=artist&limit=50${after ? `&after=${after}` : ''}`;
        const data = await spotify.api(req.userId, q);
        const block = data.artists || {};
        followed.push(...(block.items || []).map(spotify.normalizeArtist));
        if (!block.cursors || !block.cursors.after || !(block.items || []).length) break;
        after = block.cursors.after;
      }
    }

    // 3) Top artists (single page, up to 50) — full artist objects
    const top = (await spotify.api(req.userId, '/me/top/artists?limit=50&time_range=medium_term'))
      .items || [];

    // 4) Full details for liked-track artists (popularity/followers/genres need it)
    const knownIds = new Set([...followed.map((a) => a.id), ...top.map((a) => a.id)]);
    const needDetails = [...likedArtistIds].filter((id) => !knownIds.has(id));
    const detailed = await spotify.fetchArtistDetails(req.userId, needDetails);

    // 5) Merge into one artist map
    const map = new Map();
    for (const a of [...followed, ...top.map(spotify.normalizeArtist), ...detailed]) {
      if (!a || !a.id || map.has(a.id)) continue;
      map.set(a.id, a);
    }
    const artists = [...map.values()];
    const scannedAt = Date.now();

    db.setScan(req.userId, JSON.stringify({ artists, trackCount, scannedAt }));

    // 6) Discovery ledger: hidden gems (popularity < 45), new artists only
    const gems = artists.filter((a) => (a.popularity ?? 50) < 45);
    const added = db.addLedgerRows(req.userId, gems);

    res.json({ ok: true, artists: artists.length, tracks: trackCount, new_ledger_entries: added, scanned_at: scannedAt });
  } catch (e) {
    console.error('scan error', e.message);
    res.status(502).json({ error: 'scan_failed', message: 'Could not read your Spotify library. Please reconnect and try again.' });
  } finally {
    scanLocks.delete(req.userId);
  }
});

// ---------- taste profile ----------
function buildProfile(user) {
  if (!user.last_scan) return { scanned: false };
  const scan = JSON.parse(user.last_scan);
  const artists = scan.artists || [];
  const score = computeTasteScore(artists);

  const genreCounts = {};
  artists.forEach((a) => (a.genres || []).forEach((g) => { genreCounts[g] = (genreCounts[g] || 0) + 1; }));
  const topGenres = Object.entries(genreCounts)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 8)
    .map(([genre, count]) => ({ genre, count }));

  const hiddenGems = artists
    .filter((a) => (a.popularity ?? 50) < 45)
    .sort((a, b) => (a.popularity ?? 50) - (b.popularity ?? 50))
    .slice(0, 18);

  return {
    scanned: true,
    display_name: user.display_name,
    taste_score: score,
    top_genres: topGenres,
    hidden_gems: hiddenGems,
    total_artists: artists.length,
    total_tracks: scan.trackCount || 0,
    scanned_at: scan.scannedAt,
    paid: !!user.paid,
  };
}

app.get('/api/profile', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId);
  res.json(buildProfile(user));
});

// ---------- discovery ledger ----------
app.get('/api/ledger', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId);
  const freeLimit = user.paid ? null : 10;
  const rows = db.getLedger(req.userId, freeLimit);
  res.json({
    entries: rows,
    limited: !user.paid,
    note: 'Timestamps mark when each artist first appeared in your scans. "Heard it first" claims may only reference these timestamps.',
  });
});

// ---------- milestone monitor ----------
const MILESTONES = [10000, 50000, 100000, 500000, 1000000];

app.get('/api/cron/check-milestones', async (req, res) => {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const rows = db.getAllLedger();
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  let checked = 0;
  let newAlerts = 0;
  for (const [userId, ledger] of byUser) {
    try {
      const ids = ledger.map((r) => r.artist_id);
      const details = await spotify.fetchArtistDetails(userId, ids);
      const byId = new Map(details.map((a) => [a.id, a]));
      for (const row of ledger) {
        const a = byId.get(row.artist_id);
        if (!a || a.followers == null) continue;
        checked++;
        const crossed = MILESTONES.filter((m) => m > row.max_milestone && a.followers >= m);
        if (crossed.length) {
          const top = Math.max(...crossed);
          db.addAlert(userId, row.artist_id, row.artist_name, top, a.followers);
          db.setLedgerMilestone(row.id, top);
          newAlerts++;
        }
      }
    } catch (e) {
      console.error('milestone check failed for user', userId, e.message);
    }
  }
  res.json({ ok: true, artists_checked: checked, new_alerts: newAlerts });
});

app.get('/api/alerts', requireAuth, requirePaid, (req, res) => {
  res.json({ alerts: db.getAlerts(req.userId) });
});

// ---------- share cards ----------
app.get('/api/card-data/:artistId', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user.last_scan) return res.status(404).json({ error: 'no_scan' });
  const scan = JSON.parse(user.last_scan);
  const artist = (scan.artists || []).find((a) => a.id === req.params.artistId);
  if (!artist) return res.status(404).json({ error: 'artist_not_found' });
  const ledger = db.getLedgerArtistIds(req.userId);
  const entry = db.getLedger(req.userId).find((r) => r.artist_id === artist.id);
  const score = computeTasteScore(scan.artists || []);
  res.json({
    artist,
    in_ledger: ledger.includes(artist.id),
    first_seen_at: entry ? entry.first_seen_at : null,
    taste_score: score.score,
    paid: !!user.paid,
    cards: db.cardsRemaining(user.id),
  });
});

app.post('/api/cards/consume', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user.paid) {
    const remaining = db.cardsRemaining(user.id);
    if (remaining.remaining <= 0) {
      return res.status(402).json({ error: 'card_limit_reached', message: 'Free plan includes 3 share cards per month. Radar Pro ($1/month) unlocks unlimited cards.' });
    }
    const r = db.consumeCard(user.id);
    return res.json({ ok: true, used: r.used, limit: r.limit });
  }
  res.json({ ok: true, used: null, limit: null });
});

// Same-origin image proxy so canvas exports are not tainted (restricted to Spotify CDN).
app.get('/api/img', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://i.scdn.co/')) {
    return res.status(400).json({ error: 'bad_url' });
  }
  try {
    const upstream = await fetchT(url, {}, 15000);
    if (!upstream.ok) return res.status(502).json({ error: 'fetch_failed' });
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'fetch_failed' });
  }
});

// ---------- Stripe: Radar Pro $1/month ----------
app.get('/api/billing/status', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId);
  res.json({
    paid: !!user.paid,
    stripe_enabled: stripeLib.isEnabled(),
    plan: user.paid ? 'Radar Pro' : 'Free',
    price: '$1/month',
  });
});

app.post('/api/checkout', requireAuth, async (req, res) => {
  const stripe = stripeLib.getStripe();
  if (!stripe) return res.status(501).json({ error: 'billing_not_configured' });
  try {
    const user = db.getUserById(req.userId);
    const priceId = await stripeLib.getPriceId();
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { taste_radar_user: user.id },
      });
      customerId = customer.id;
      db.setStripeCustomer(user.id, customerId);
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/app.html?upgraded=1`,
      cancel_url: `${APP_URL}/pricing.html`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('checkout error', e.message);
    res.status(502).json({ error: 'checkout_failed' });
  }
});

async function handleStripeWebhook(req, res) {
  const stripe = stripeLib.getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(501).json({ error: 'billing_not_configured' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (e) {
    return res.status(400).json({ error: 'bad_signature' });
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      if (userId && db.getUserById(userId)) {
        db.setPaid(userId, true);
        if (session.customer) db.setStripeCustomer(userId, session.customer);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const user = sub.customer ? db.getUserByStripeCustomer(sub.customer) : null;
      if (user) db.setPaid(user.id, false);
    }
    res.json({ received: true });
  } catch (e) {
    console.error('webhook handler error', e);
    res.status(500).json({ error: 'handler_failed' });
  }
}

// ---------- privacy: export + delete ----------
app.get('/api/account/export', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId);
  const data = {
    exported_at: new Date().toISOString(),
    profile: { display_name: user.display_name, spotify_id: user.spotify_id, email: user.email },
    scan: user.last_scan ? JSON.parse(user.last_scan) : null,
    ledger: db.getLedger(req.userId),
    alerts: db.getAlerts(req.userId),
  };
  const safe = (user.display_name || 'user').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.attachment(`taste-radar-export-${safe}.json`);
  res.json(data);
});

app.post('/api/account/delete', requireAuth, (req, res) => {
  const token = req.signedCookies && req.signedCookies.tr_session;
  db.deleteUser(req.userId);
  if (token) db.deleteSession(token);
  res.clearCookie('tr_session', { path: '/' });
  res.json({ ok: true });
});

// ---------- static pages ----------
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'pricing.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));
app.get('/sample', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'sample.html')));
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.html')));
app.get('/card/:artistId', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'card.html')));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// ---------- error handling ----------
app.use((err, req, res, next) => {
  console.error('unhandled', err);
  res.status(500).json({ error: 'internal_error' });
});

if (require.main === module) {
  if (!process.env.COOKIE_SECRET) {
    console.warn('[taste-radar] COOKIE_SECRET not set — using insecure dev default. Set it in production.');
  }
  app.listen(PORT, () => console.log(`[taste-radar] listening on :${PORT}`));
}

module.exports = app;
