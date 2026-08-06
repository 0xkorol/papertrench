# Deploying the leaderboard server

One-time setup, in order. Everything here is a **maintainer action on real
accounts** — none of it is automated on purpose.

## 1. Cloudflare

```bash
cd server
npx wrangler login
npx wrangler d1 create papertrench
# → paste the printed database_id into wrangler.toml (database_id = "…")
npx wrangler d1 execute papertrench --file=schema.sql --remote
npx wrangler secret put SESSION_SECRET     # paste output of: openssl rand -hex 32
```

`schema.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`), so re-running it
after a release that adds tables is safe. It does **not** add columns to
tables that already exist — if you deployed before duels landed, also run:

```bash
npx wrangler d1 execute papertrench --remote \
  --command "ALTER TABLE records ADD COLUMN badges_json TEXT"
```

The `[[routes]]` block in wrangler.toml binds `api.papertrench.com/*`. For
that to resolve, add a DNS record in the papertrench.com Cloudflare zone:
`api` → AAAA `100::` (proxied) — a placeholder the Worker route intercepts.
(The zone must be on Cloudflare; if the site stays on GitHub Pages that's
fine — only the `api` subdomain routes to the Worker.)

## 2. X (Twitter) OAuth app

1. <https://developer.x.com> → create a project + app (free tier is fine —
   the server only calls `GET /2/users/me` at sign-in).
2. User authentication settings:
   - Type: **Public client** (the Worker uses PKCE; no client secret needed)
   - Callback URI: `https://api.papertrench.com/api/auth/x/callback`
   - Website: `https://papertrench.com`
   - Scopes: `users.read tweet.read` (X requires tweet.read for /users/me)
3. Paste the OAuth 2.0 Client ID into `wrangler.toml` → `X_CLIENT_ID`.

## 3. Deploy

```bash
npx wrangler deploy
curl https://api.papertrench.com/api/health   # → {"ok":true}
```

The cron trigger (every minute) starts draining pricing work automatically;
it is a no-op while there are no pending records.

## 4. Site config

`site/arena.js` → `EXTENSION_IDS`: put the stable extension id the Chrome Web
Store assigns after the listing goes live. Until then the Sync button
honestly reports "extension not detected" for unpacked installs and points
users at the exported-file path, which always works.

### Known limitation: link previews

Profile and duel pages set `og:title`/`og:description` from the loaded
record, but social crawlers do not run JavaScript, so a shared link unfurls
with the site-wide preview rather than that trader's numbers. Fixing it
properly needs server-rendered OG tags plus a rasterised image (satori +
resvg-wasm on the Worker), which is a real chunk of work and cannot be
verified without deploying — so it is deliberately NOT shipped rather than
half-shipped. In the meantime the profile page's **share card** renders the
record to a PNG the user downloads or copies, which is how traders actually
post results anyway.

## 5. Smoke checklist (after deploy)

- [ ] `GET /api/health` returns ok over the custom domain
- [ ] Sign in with X on papertrench.com/leaderboard.html round-trips and
      shows your handle
- [ ] Submitting an exported record from a real install returns
      `status: pending` with replayed stats
- [ ] Within a few minutes the record flips to `verified` on your profile
      (watch: `npx wrangler d1 execute papertrench --remote
      --command "SELECT user_id,status FROM records"`)
- [ ] A second submission with a shorter chain is rejected `chain-shrunk`
- [ ] "delete my data" removes the account and the board row disappears
      after the 60s edge cache expires
- [ ] `/api/activity` returns events, and rejection events carry no handle
- [ ] Create a duel, open the invite link in a second browser profile signed
      in as a different X account, join it — the clock starts on join and
      both sides show as provisional until the window closes
- [ ] A duel whose window has closed shows `awaiting` until a post-close
      submission lands, then settles with a plain-language reason

## Costs, honestly

Reads are edge-cached (60s) so board traffic is ~free at any scale. Writes
are rate-limited (6 submissions/user/hour). The only external dependency is
GeckoTerminal's free OHLCV API, consumed at ≤25 lookups/minute by the cron
with permanent candle caching in D1. Expected bill on Workers Free: $0.
If sustained load ever exceeds the free tier, Workers Paid is $5/mo — that
is the whole worst case.
