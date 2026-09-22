# Taste Radar — You heard it first.

A mobile-first web app that turns a Spotify library into a taste profile, a **Taste Score**, a timestamped **discovery ledger** of obscure artists, **milestone alerts** when those artists blow up, and **shareable cards** to prove you heard them first.

**Revenue model: freemium subscription.** Free = taste profile + Taste Score + 3 share cards/month. **Radar Pro = $1/month** (Stripe) = unlimited cards, all card styles, full ledger history, milestone alerts.

## Stack

- Node.js + Express (single deployable unit)
- Node's built-in `node:sqlite` (file DB, WAL mode — zero native dependencies)
- Vanilla HTML/CSS/JS frontend, mobile-first, PWA basics (manifest, theme-color, apple-touch meta)
- Spotify Web API via OAuth PKCE (no client secret)
- Stripe Checkout + webhooks for Radar Pro

## Quick start (local)

```bash
npm install
cp .env.example .env
# edit .env — at minimum set COOKIE_SECRET and CRON_SECRET
npm start
# open http://localhost:3000
```

### Spotify setup

1. Go to https://developer.spotify.com/dashboard and create an app.
2. Add this Redirect URI (must match exactly):
   - Local: `http://localhost:3000/auth/callback`
   - Production: `https://your-domain/auth/callback`
3. Set in `.env`:
   - `SPOTIFY_CLIENT_ID` — your app's client ID (a public PKCE default is built in for dev)
   - `SPOTIFY_REDIRECT_URI` — the URI you allowlisted
   - `APP_URL` — your public base URL (used for Stripe return URLs)

No client secret is needed: login uses the PKCE S256 flow, which is designed for public clients.

### Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP port |
| `APP_URL` | no | `http://localhost:3000` | Public base URL (Stripe redirects) |
| `COOKIE_SECRET` | **yes (prod)** | insecure dev default | Signs session cookies |
| `SPOTIFY_CLIENT_ID` | no | built-in PKCE public client | Spotify app client ID |
| `SPOTIFY_REDIRECT_URI` | no | `http://localhost:3000/auth/callback` | Must be allowlisted in Spotify dashboard |
| `STRIPE_SECRET_KEY` | for billing | — | Stripe secret key; billing disabled without it |
| `STRIPE_PRICE_ID` | no | created on first use | `$1/month` recurring price; auto-created once if unset |
| `STRIPE_WEBHOOK_SECRET` | for billing | — | Verifies Stripe webhook signatures |
| `CRON_SECRET` | **yes (prod)** | — | Shared secret for `GET /api/cron/check-milestones` |
| `DATABASE_PATH` | no | `./data/taste-radar.db` | SQLite file |

## Deploy

### Railway

1. Push this repo to GitHub, then **New Project → Deploy from GitHub**.
2. Railway uses the `Dockerfile` automatically (`railway.json` included).
3. Set env vars in the Railway dashboard (see table above). Set `APP_URL` to your Railway domain and `SPOTIFY_REDIRECT_URI` to `https://<domain>/auth/callback` (allowlist it in Spotify too).
4. Add a **Volume** mounted at `/app/data` so the SQLite DB survives restarts, and set `DATABASE_PATH=/app/data/taste-radar.db`.

### Render

1. **New → Web Service → from GitHub**. `render.yaml` is included as a blueprint (or configure manually: Docker runtime).
2. Set the env vars (Render can generate `COOKIE_SECRET`/`CRON_SECRET`).
3. Add a **Disk** mounted at `/app/data` and set `DATABASE_PATH=/app/data/taste-radar.db`.

### Docker (any host)

```bash
docker build -t taste-radar .
docker run -p 3000:3000 --env-file .env -v taste-radar-data:/app/data \
  -e DATABASE_PATH=/app/data/taste-radar.db taste-radar
```

## Milestone cron

Schedule this to hit (daily is plenty):

```
GET https://your-domain/api/cron/check-milestones?secret=$CRON_SECRET
```

For each ledger artist it re-reads Spotify **follower counts** and records an alert when one crosses 10K / 50K / 100K / 500K / 1M followers. (Spotify's API does not expose monthly listeners — the app never claims otherwise.)

## Stripe setup (Radar Pro, $1/month)

1. Create a Stripe account, get a **secret key** → `STRIPE_SECRET_KEY`.
2. Either create a $1/month recurring Price in the Stripe dashboard → `STRIPE_PRICE_ID`, or leave it unset and the app creates the Product + Price on first checkout (the ID is cached in the DB).
3. Create a webhook endpoint pointing at `https://your-domain/api/stripe/webhook`, subscribe to `checkout.session.completed` and `customer.subscription.deleted` → `STRIPE_WEBHOOK_SECRET`.
4. Local webhook testing: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

Without `STRIPE_SECRET_KEY`, billing endpoints return `501 billing_not_configured` and upgrade buttons explain billing isn't enabled.

## API overview

| Method & path | Auth | Description |
|---|---|---|
| `GET /auth/spotify` | — | Start Spotify PKCE login |
| `GET /auth/callback` | — | OAuth callback, creates session |
| `GET /auth/logout` | — | Clear session |
| `GET /api/me` | — | `{ logged_in, display_name, paid, … }` |
| `POST /api/scan` | user | Ingest library (liked tracks, follows, top artists) |
| `GET /api/profile` | user | Taste profile + Taste Score JSON (401 when logged out) |
| `GET /api/ledger` | user | Discovery ledger (free: latest 10) |
| `GET /api/alerts` | Pro | Milestone alerts (402 for free) |
| `GET /api/cron/check-milestones?secret=` | cron secret | Follower milestone check |
| `GET /api/billing/status` | user | Plan state |
| `POST /api/checkout` | user | Stripe Checkout session for Radar Pro |
| `POST /api/stripe/webhook` | Stripe sig | Subscription events |
| `GET /api/card-data/:artistId` | user | Card payload |
| `POST /api/cards/consume` | user | Use one monthly card (402 at free limit) |
| `GET /api/img?url=` | — | Spotify CDN image proxy (un-taints canvas) |
| `GET /api/account/export` | user | JSON download of all stored data |
| `POST /api/account/delete` | user | Delete account + all data |

Pages: `/` landing · `/app` dashboard · `/card/:artistId` share card · `/pricing` · `/privacy` · `/sample` (clearly labeled demo).

## Honesty rules (enforced in code & copy)

- No invented discovery dates, listener counts, or rankings. Ledger timestamps are written at scan time and are the only basis for "heard it first" claims.
- Audience numbers are Spotify **follower** counts; the API has no monthly-listener field.
- Taste Score is labeled illustrative, never a percentile.
- The sample profile is labeled "Sample profile — demo" with illustrative figures.
- Listening data is never sold; export/delete are one click in the app.

## License

MIT.
