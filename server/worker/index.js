/* PaperTrench leaderboard server — Cloudflare Worker entry.
 *
 * Thin adapter over the pure core (server/core): routing, CORS, sessions,
 * D1 persistence, edge caching, rate limits, and the pricing cron. Anything
 * that decides WHETHER a record is honest lives in core/ and runs identically
 * under `node --test`; this file only decides WHERE bytes go.
 *
 * Read traffic is the scale story: board and profile responses carry
 * s-maxage and are served from Cloudflare's edge cache, so ten users and ten
 * million cost about the same. Writes (submissions) are rate-limited and the
 * heavy half (re-pricing against market history) drains through the cron
 * under an external-API budget.
 */
import { fastChecks, priceRecord } from '../core/submission.js';
import { windowOf, sprintEntry } from '../core/sprint.js';
import { sessionUser, startLogin, finishLogin, logout } from './auth.js';
import { makeGetCandles } from './candles.js';

const SEG_SIZE = 500;
const SUBMITS_PER_HOUR = 6;
const CANDLE_BUDGET_PER_RUN = 25;
const BOARD_CACHE_SEC = 60;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/* ---------------- plumbing ---------------- */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = [env.SITE_ORIGIN, env.SITE_ORIGIN_ALT].filter(Boolean);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}),
  });
}

/** Fixed-window rate limit in D1. Returns true when the call is allowed. */
async function allowRate(env, key, perHour) {
  const now = Date.now();
  const windowStart = Math.floor(now / 3600000) * 3600000;
  const row = await env.DB.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?')
    .bind(key).first();
  if (!row || row.window_start !== windowStart) {
    await env.DB.prepare(`
      INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET window_start = ?, count = 1`)
      .bind(key, windowStart, windowStart).run();
    return true;
  }
  if (row.count >= perHour) return false;
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
  return true;
}

/** Serve a GET from the edge cache, computing + caching on miss. */
async function edgeCached(request, ctx, ttlSec, compute) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await compute();
  if (response.status === 200) {
    const cacheable = new Response(response.clone().body, response);
    cacheable.headers.set('Cache-Control', `public, max-age=30, s-maxage=${ttlSec}`);
    ctx.waitUntil(cache.put(request, cacheable.clone()));
    return cacheable;
  }
  return response;
}

/* ---------------- chain storage ---------------- */

async function storeChain(env, userId, chain) {
  const statements = [
    env.DB.prepare('DELETE FROM chain_segments WHERE user_id = ?').bind(userId),
  ];
  for (let i = 0; i < chain.length; i += SEG_SIZE) {
    statements.push(env.DB.prepare(
      'INSERT INTO chain_segments (user_id, seg_no, links_json) VALUES (?, ?, ?)')
      .bind(userId, Math.floor(i / SEG_SIZE), JSON.stringify(chain.slice(i, i + SEG_SIZE))));
  }
  await env.DB.batch(statements);
}

async function loadChain(env, userId) {
  const rows = await env.DB.prepare(
    'SELECT links_json FROM chain_segments WHERE user_id = ? ORDER BY seg_no')
    .bind(userId).all();
  const chain = [];
  for (const row of rows.results) chain.push(...JSON.parse(row.links_json));
  return chain;
}

/* ---------------- routes ---------------- */

async function handleSubmit(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  if (!(await allowRate(env, 'submit:' + user.id, SUBMITS_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, reason: 'too-large' }, 413);
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ ok: false, reason: 'bad-json' }, 400); }

  const previousRow = await env.DB.prepare(
    'SELECT head, chain_len FROM records WHERE user_id = ?').bind(user.id).first();
  const previous = previousRow
    ? { head: previousRow.head, chainLen: previousRow.chain_len } : null;

  const result = await fastChecks(payload, previous);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO submissions (user_id, head, chain_len, outcome, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(user.id, String(payload && payload.head || ''),
      payload && Array.isArray(payload.chain) ? payload.chain.length : 0,
      result.accepted ? 'accepted' : result.reason, now)
    .run();
  if (!result.accepted) {
    return json({ ok: false, reason: result.reason, problems: result.problems || [] }, 422);
  }

  const start = Number(payload.claim.startingBalanceSol);
  await storeChain(env, user.id, payload.chain);
  await env.DB.prepare(`
    INSERT INTO records (user_id, head, chain_len, starting_sol, status, claim_mismatch,
                         stats_json, pricing_json, pricing_progress_json, submitted_at, verified_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, ?, NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      head = excluded.head, chain_len = excluded.chain_len,
      starting_sol = excluded.starting_sol, status = 'pending',
      claim_mismatch = excluded.claim_mismatch, stats_json = excluded.stats_json,
      pricing_json = NULL, pricing_progress_json = NULL,
      submitted_at = excluded.submitted_at, verified_at = NULL`)
    .bind(user.id, payload.head, payload.chain.length, start,
      result.claimMismatch ? 1 : 0, JSON.stringify(result.stats), now)
    .run();

  // Sprint entry for the current window, derived from the same chain.
  const window = windowOf(now);
  const entry = sprintEntry(payload.chain, start, window);
  await env.DB.prepare(`
    INSERT INTO sprint_entries (week_id, user_id, entry_json, score, rounds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(week_id, user_id) DO UPDATE SET
      entry_json = excluded.entry_json, score = excluded.score,
      rounds = excluded.rounds, updated_at = excluded.updated_at`)
    .bind(window.weekId, user.id, JSON.stringify(entry), entry.score, entry.rounds, now)
    .run();

  return json({
    ok: true,
    status: 'pending',
    note: 'chain verified and replayed; prices now re-checking against market history',
    stats: result.stats,
    claimMismatch: result.claimMismatch,
    sprint: entry,
  });
}

async function handleLeaderboard(env) {
  const rows = await env.DB.prepare(`
    SELECT u.handle, u.display_name, u.avatar_url,
           r.status, r.stats_json, r.chain_len, r.verified_at, r.submitted_at
    FROM records r JOIN users u ON u.id = r.user_id
    WHERE r.status != 'rejected'
    ORDER BY r.submitted_at DESC LIMIT 500`).all();
  const entries = rows.results
    .map((row) => {
      const stats = JSON.parse(row.stats_json);
      return {
        handle: row.handle,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        status: row.status,
        chainLen: row.chain_len,
        verifiedAt: row.verified_at,
        stats,
      };
    })
    .filter((e) => e.stats.rankable)
    .sort((a, b) => b.stats.score - a.stats.score);
  return json({ board: 'global', entries });
}

async function handleSprint(env) {
  const window = windowOf(Date.now());
  const rows = await env.DB.prepare(`
    SELECT u.handle, u.display_name, u.avatar_url, r.status, s.entry_json
    FROM sprint_entries s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN records r ON r.user_id = s.user_id
    WHERE s.week_id = ? AND s.rounds > 0 AND (r.status IS NULL OR r.status != 'rejected')
    ORDER BY s.score DESC LIMIT 200`).bind(window.weekId).all();
  return json({
    weekId: window.weekId,
    startTs: window.startTs,
    endTs: window.endTs,
    entries: rows.results.map((row) => ({
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      status: row.status || 'pending',
      entry: JSON.parse(row.entry_json),
    })),
  });
}

async function handleProfile(env, handle) {
  const user = await env.DB.prepare(
    'SELECT id, handle, display_name, avatar_url, created_at FROM users WHERE handle = ? COLLATE NOCASE')
    .bind(handle).first();
  if (!user) return json({ ok: false, reason: 'not-found' }, 404);
  const record = await env.DB.prepare(
    `SELECT head, chain_len, starting_sol, status, claim_mismatch, stats_json,
            pricing_json, submitted_at, verified_at FROM records WHERE user_id = ?`)
    .bind(user.id).first();
  const sprints = await env.DB.prepare(
    'SELECT week_id, entry_json FROM sprint_entries WHERE user_id = ? ORDER BY week_id DESC LIMIT 12')
    .bind(user.id).all();
  return json({
    handle: user.handle,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    joinedAt: user.created_at,
    record: record ? {
      head: record.head,
      chainLen: record.chain_len,
      startingSol: record.starting_sol,
      status: record.status,
      claimMismatch: !!record.claim_mismatch,
      stats: JSON.parse(record.stats_json),
      pricing: record.pricing_json ? JSON.parse(record.pricing_json) : null,
      submittedAt: record.submitted_at,
      verifiedAt: record.verified_at,
    } : null,
    sprints: sprints.results.map((row) => ({ weekId: row.week_id, entry: JSON.parse(row.entry_json) })),
  });
}

/* ---------------- pricing cron ---------------- */

async function drainPricing(env) {
  const row = await env.DB.prepare(
    `SELECT user_id, starting_sol, pricing_progress_json FROM records
     WHERE status = 'pending' ORDER BY submitted_at ASC LIMIT 1`).first();
  if (!row) return;
  const chain = await loadChain(env, row.user_id);
  if (!chain.length) return;
  const budget = { used: 0, max: CANDLE_BUDGET_PER_RUN };
  const progress = row.pricing_progress_json ? JSON.parse(row.pricing_progress_json) : null;
  let result;
  try {
    result = await priceRecord({ chain }, makeGetCandles(env, budget), progress, {});
  } catch (err) {
    // Budget or upstream rate limit: progress (if any) is already in
    // priceRecord's returned value only on success, so just retry next run.
    return;
  }
  if (!result.done) {
    await env.DB.prepare('UPDATE records SET pricing_progress_json = ? WHERE user_id = ?')
      .bind(JSON.stringify({ cursor: result.cursor, verdicts: result.verdicts }), row.user_id)
      .run();
    return;
  }
  await env.DB.prepare(`
    UPDATE records SET status = ?, pricing_json = ?, pricing_progress_json = NULL,
                       verified_at = ? WHERE user_id = ?`)
    .bind(result.verdict.status, JSON.stringify(result.verdict), Date.now(), row.user_id)
    .run();
}

/* ---------------- entry ---------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let response;
    try {
      if (path === '/api/health') response = json({ ok: true });
      else if (path === '/api/auth/x/start') response = await startLogin(request, env);
      else if (path === '/api/auth/x/callback') response = await finishLogin(request, env);
      else if (path === '/api/auth/logout' && request.method === 'POST') response = logout(env);
      else if (path === '/api/me') {
        const user = await sessionUser(request, env);
        response = user
          ? json({ signedIn: true, handle: user.handle, displayName: user.display_name, avatarUrl: user.avatar_url })
          : json({ signedIn: false });
      }
      else if (path === '/api/me/delete' && request.method === 'POST') {
        // Self-serve erasure: the privacy story requires leaving to be as
        // easy as joining. Removes the account and everything derived.
        const user = await sessionUser(request, env);
        if (!user) response = json({ ok: false, reason: 'not-signed-in' }, 401);
        else {
          await env.DB.batch([
            env.DB.prepare('DELETE FROM chain_segments WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM sprint_entries WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM submissions WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM records WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
          ]);
          response = logout(env);
        }
      }
      else if (path === '/api/submit' && request.method === 'POST') response = await handleSubmit(request, env);
      else if (path === '/api/leaderboard') response = await edgeCached(request, ctx, BOARD_CACHE_SEC, () => handleLeaderboard(env));
      else if (path === '/api/sprint/current') response = await edgeCached(request, ctx, BOARD_CACHE_SEC, () => handleSprint(env));
      else if (path === '/api/profile') {
        const handle = url.searchParams.get('handle') || '';
        response = await edgeCached(request, ctx, BOARD_CACHE_SEC, () => handleProfile(env, handle));
      }
      else response = json({ ok: false, reason: 'not-found' }, 404);
    } catch (err) {
      response = json({ ok: false, reason: 'server-error' }, 500);
    }

    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    return response;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(drainPricing(env));
  },
};
