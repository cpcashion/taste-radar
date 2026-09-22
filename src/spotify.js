// Spotify API helpers: PKCE auth helpers live in server.js; this module handles
// authenticated API calls with automatic access-token refresh.
const db = require('./db');

const DEFAULT_CLIENT_ID = 'd5baa23332d64e198419d95d2272be2e';
const clientId = () => process.env.SPOTIFY_CLIENT_ID || DEFAULT_CLIENT_ID;

// fetch with a hard timeout so one slow upstream call can't hang a request (e.g. cron)
const fetchT = (url, opts = {}, ms = 15000) =>
  fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });

async function refreshAccessToken(user) {
  if (!user.refresh_token) throw new Error('no_refresh_token');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: user.refresh_token,
    client_id: clientId(),
  });
  const res = await fetchT('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) throw new Error('token_refresh_failed');
  const data = await res.json();
  const expiresAt = Date.now() + data.expires_in * 1000;
  db.setTokens(user.id, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || user.refresh_token,
    expiresAt,
  });
  return { ...user, access_token: data.access_token, refresh_token: data.refresh_token || user.refresh_token, token_expires_at: expiresAt };
}

// Authenticated GET against the Spotify Web API. `user` may be a user id or row.
async function api(userOrId, path, retried = false) {
  let user = typeof userOrId === 'string' ? db.getUserById(userOrId) : userOrId;
  if (!user || !user.access_token) throw new Error('not_authenticated');
  if (!user.token_expires_at || user.token_expires_at - 60000 < Date.now()) {
    user = await refreshAccessToken(user);
  }
  const res = await fetchT(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${user.access_token}` },
  });
  if (res.status === 401 && !retried) {
    user = await refreshAccessToken(user);
    return api(user, path, true);
  }
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('retry-after') || '5', 10) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 15000)));
    return api(user, path, retried);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`spotify_${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Normalize a full Spotify artist object to the fields we store.
function normalizeArtist(a) {
  return {
    id: a.id,
    name: a.name,
    popularity: typeof a.popularity === 'number' ? a.popularity : null,
    followers: a.followers && typeof a.followers.total === 'number' ? a.followers.total : null,
    genres: Array.isArray(a.genres) ? a.genres : [],
    image: a.images && a.images.length ? a.images[0].url : null,
  };
}

async function fetchArtistDetails(userId, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await api(userId, `/artists?ids=${chunk.join(',')}`);
    for (const a of data.artists || []) {
      if (a) out.push(normalizeArtist(a));
    }
  }
  return out;
}

module.exports = { api, normalizeArtist, fetchArtistDetails, clientId };
