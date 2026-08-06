-- PaperTrench leaderboard server — D1 (SQLite) schema.
-- Apply with: wrangler d1 execute papertrench --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x_id TEXT NOT NULL UNIQUE,          -- immutable X user id; handles can change
  handle TEXT NOT NULL,               -- current @handle, refreshed on login
  display_name TEXT,
  avatar_url TEXT,
  session_epoch INTEGER NOT NULL DEFAULT 0,  -- bump to revoke all sessions
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

-- One ranked record per identity (LEADERBOARD.md rule 4). The stored head is
-- the anti-replacement anchor: the next submission must extend it.
CREATE TABLE IF NOT EXISTS records (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  head TEXT NOT NULL,
  chain_len INTEGER NOT NULL,
  starting_sol REAL NOT NULL,
  status TEXT NOT NULL,               -- pending | verified | partial | rejected
  claim_mismatch INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL,           -- ranking.recordStats output
  pricing_json TEXT,                  -- pricing.recordVerdict output once done
  pricing_progress_json TEXT,         -- resumable priceRecord cursor state
  submitted_at INTEGER NOT NULL,
  verified_at INTEGER
);

-- The full chain, segmented like the extension stores it (500 links/segment),
-- so re-verification and sprint slicing never need the client again.
CREATE TABLE IF NOT EXISTS chain_segments (
  user_id INTEGER NOT NULL REFERENCES users(id),
  seg_no INTEGER NOT NULL,
  links_json TEXT NOT NULL,
  PRIMARY KEY (user_id, seg_no)
);

-- Append-only audit log of every submission attempt, accepted or not.
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  head TEXT,
  chain_len INTEGER,
  outcome TEXT NOT NULL,              -- accepted | reason string
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id, created_at);

-- Sprint standings are derived data (recomputed from chains on submission),
-- persisted so the board is a read, not a replay.
CREATE TABLE IF NOT EXISTS sprint_entries (
  week_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  entry_json TEXT NOT NULL,           -- sprint.sprintEntry output
  score REAL NOT NULL,
  rounds INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (week_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sprint_score ON sprint_entries(week_id, score DESC);

-- Candle lookups are cached forever: historical minutes never change, and one
-- popular mint's minute serves every verifier that ever asks again.
CREATE TABLE IF NOT EXISTS candle_cache (
  mint TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  candles_json TEXT,                  -- {tokenUsd:{low,high},solUsd:{low,high}} or null=no-data
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (mint, minute_ts)
);

-- Mint -> top pool resolution (GeckoTerminal), cached with a TTL because new
-- pools appear for young tokens.
CREATE TABLE IF NOT EXISTS pools (
  mint TEXT PRIMARY KEY,
  pool_id TEXT,
  fetched_at INTEGER NOT NULL
);

-- Fixed-window rate limiting (per user and per IP).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
