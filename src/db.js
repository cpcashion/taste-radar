// SQLite storage layer using Node's built-in node:sqlite (no native deps).
// All secrets stay in env vars; tokens live here.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'taste-radar.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  spotify_id TEXT UNIQUE NOT NULL,
  display_name TEXT,
  email TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER,
  paid INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  last_scan TEXT,
  scanned_at INTEGER,
  cards_used INTEGER NOT NULL DEFAULT 0,
  cards_period TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pkce (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  popularity INTEGER,
  followers INTEGER,
  first_seen_at INTEGER NOT NULL,
  max_milestone INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, artist_id)
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  followers INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);
`);

const now = () => Date.now();

function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  };
}

// ---- users ----
const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const getUserBySpotifyId = (sid) => db.prepare('SELECT * FROM users WHERE spotify_id = ?').get(sid);
const getUserByStripeCustomer = (cid) =>
  db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(cid);

function upsertUser({ spotifyId, displayName, email, accessToken, refreshToken, expiresAt }) {
  const existing = getUserBySpotifyId(spotifyId);
  if (existing) {
    db.prepare(
      `UPDATE users SET display_name = ?, email = ?, access_token = ?, refresh_token = ?,
       token_expires_at = ? WHERE id = ?`
    ).run(displayName, email, accessToken, refreshToken || existing.refresh_token, expiresAt, existing.id);
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO users (id, spotify_id, display_name, email, access_token, refresh_token,
     token_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, spotifyId, displayName, email, accessToken, refreshToken, expiresAt, now());
  return id;
}

const setTokens = (userId, { accessToken, refreshToken, expiresAt }) =>
  db.prepare('UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?')
    .run(accessToken, refreshToken, expiresAt, userId);

const setScan = (userId, scanJson) =>
  db.prepare('UPDATE users SET last_scan = ?, scanned_at = ? WHERE id = ?')
    .run(scanJson, now(), userId);

const setPaid = (userId, paid) =>
  db.prepare('UPDATE users SET paid = ? WHERE id = ?').run(paid ? 1 : 0, userId);

const setStripeCustomer = (userId, customerId) =>
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, userId);

function consumeCard(userId) {
  const user = getUserById(userId);
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
  if (user.cards_period !== period) {
    db.prepare('UPDATE users SET cards_used = 1, cards_period = ? WHERE id = ?').run(period, userId);
    return { used: 1, limit: 3 };
  }
  db.prepare('UPDATE users SET cards_used = cards_used + 1 WHERE id = ?').run(userId);
  return { used: Number(user.cards_used) + 1, limit: 3 };
}

const cardsRemaining = (userId) => {
  const user = getUserById(userId);
  const period = new Date().toISOString().slice(0, 7);
  if (user.paid) return { used: Number(user.cards_used), limit: Infinity, remaining: Infinity };
  if (user.cards_period !== period) return { used: 0, limit: 3, remaining: 3 };
  return { used: Number(user.cards_used), limit: 3, remaining: Math.max(0, 3 - Number(user.cards_used)) };
};

// ---- sessions ----
function createSession(userId, days = 30) {
  const token = crypto.randomBytes(32).toString('hex');
  const t = now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, t, t + days * 24 * 3600 * 1000);
  return token;
}
const getSession = (token) => db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
const deleteSession = (token) => db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
const deleteUserSessions = (userId) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

// ---- PKCE ----
function storePkce(state, verifier) {
  db.prepare('INSERT INTO pkce (state, verifier, created_at) VALUES (?, ?, ?)')
    .run(state, verifier, now());
  db.prepare('DELETE FROM pkce WHERE created_at < ?').run(now() - 15 * 60 * 1000); // prune
}
function takePkce(state) {
  const row = db.prepare('SELECT * FROM pkce WHERE state = ?').get(state);
  if (row) db.prepare('DELETE FROM pkce WHERE state = ?').run(state);
  return row;
}

// ---- ledger ----
function addLedgerRows(userId, artists) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ledger
     (user_id, artist_id, artist_name, popularity, followers, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const t = now();
  const tx = transaction((list) => {
    let added = 0;
    for (const a of list) {
      const r = insert.run(userId, a.id, a.name, a.popularity ?? null, a.followers ?? null, t);
      if (Number(r.changes) > 0) added++;
    }
    return added;
  });
  return tx(artists);
}

const getLedger = (userId, limit) => {
  const lim = limit ? ` LIMIT ${Number(limit)}` : '';
  const sql = `SELECT artist_id, artist_name, popularity, followers, first_seen_at, max_milestone
               FROM ledger WHERE user_id = ? ORDER BY first_seen_at DESC${lim}`;
  return db.prepare(sql).all(userId);
};
const getLedgerArtistIds = (userId) =>
  db.prepare('SELECT artist_id FROM ledger WHERE user_id = ?').all(userId).map((r) => r.artist_id);
const getAllLedger = () =>
  db.prepare('SELECT * FROM ledger ORDER BY user_id, artist_id').all();
const setLedgerMilestone = (ledgerId, milestone) =>
  db.prepare('UPDATE ledger SET max_milestone = ? WHERE id = ?').run(milestone, ledgerId);

// ---- alerts ----
const addAlert = (userId, artistId, artistName, threshold, followers) =>
  db.prepare(
    `INSERT INTO alerts (user_id, artist_id, artist_name, threshold, followers, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, artistId, artistName, threshold, followers, now());

const getAlerts = (userId) =>
  db.prepare('SELECT artist_id, artist_name, threshold, followers, created_at FROM alerts WHERE user_id = ? ORDER BY created_at DESC').all(userId);

// ---- meta ----
const getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
const setMeta = (key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);

// ---- account ----
function deleteUser(userId) {
  const tx = transaction(() => {
    db.prepare('DELETE FROM ledger WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM alerts WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  tx();
}

module.exports = {
  getUserById, getUserBySpotifyId, getUserByStripeCustomer, upsertUser, setTokens,
  setScan, setPaid, setStripeCustomer, consumeCard, cardsRemaining,
  createSession, getSession, deleteSession, deleteUserSessions,
  storePkce, takePkce,
  addLedgerRows, getLedger, getLedgerArtistIds, getAllLedger, setLedgerMilestone,
  addAlert, getAlerts,
  getMeta, setMeta,
  deleteUser,
};
