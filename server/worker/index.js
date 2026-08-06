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
import { windowEntry } from '../core/window.js';
import { awarded } from '../core/achievements.js';
import * as duel from '../core/duel.js';
import { sessionUser, startLogin, finishLogin, logout } from './auth.js';
import { makeGetCandles } from './candles.js';

const SEG_SIZE = 500;
const SUBMITS_PER_HOUR = 6;
const DUELS_PER_HOUR = 10;
const CANDLE_BUDGET_PER_RUN = 25;
// How long a record that made no pricing progress steps aside for.
const PRICING_BACKOFF_MS = 5 * 60 * 1000;
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
    'SELECT head, chain_len, starting_sol FROM records WHERE user_id = ?').bind(user.id).first();
  const previous = previousRow
    ? { head: previousRow.head, chainLen: previousRow.chain_len,
        startingSol: previousRow.starting_sol }
    : null;

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
  // Badges are chain-derived, so they are computed here rather than on every
  // profile view. The verification-dependent one ('unbroken') can only be
  // earned once re-pricing finishes, so this runs again at that point.
  const badges = awarded({
    chain: payload.chain, startingSol: start, chainLen: payload.chain.length,
    pricingStatus: 'pending', coverage: 0,
  });
  await storeChain(env, user.id, payload.chain);
  await env.DB.prepare(`
    INSERT INTO records (user_id, head, chain_len, starting_sol, status, claim_mismatch,
                         stats_json, badges_json, pricing_json, pricing_progress_json,
                         submitted_at, verified_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?, NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      head = excluded.head, chain_len = excluded.chain_len,
      starting_sol = excluded.starting_sol, status = 'pending',
      claim_mismatch = excluded.claim_mismatch, stats_json = excluded.stats_json,
      badges_json = excluded.badges_json,
      pricing_json = NULL, pricing_progress_json = NULL,
      submitted_at = excluded.submitted_at, verified_at = NULL`)
    .bind(user.id, payload.head, payload.chain.length, start,
      result.claimMismatch ? 1 : 0, JSON.stringify(result.stats),
      JSON.stringify(badges), now)
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

  // Refresh this player's slice of every duel they are in whose window has not
  // been settled. Computing it here — once per submission — is what keeps a
  // duel page from re-walking two lifetime chains on every view. `submitted_at`
  // rides along because it, not the entry, decides whether this may settle.
  const duels = await env.DB.prepare(`
    SELECT id, start_ts, end_ts FROM duels
    WHERE settled_at IS NULL AND accepted_at IS NOT NULL
      AND (challenger_id = ? OR opponent_id = ?)`).bind(user.id, user.id).all();
  for (const duel of duels.results) {
    const duelEntry = windowEntry(payload.chain, start,
      { startTs: duel.start_ts, endTs: duel.end_ts });
    await env.DB.prepare(`
      INSERT INTO duel_entries (duel_id, user_id, entry_json, submitted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(duel_id, user_id) DO UPDATE SET
        entry_json = excluded.entry_json, submitted_at = excluded.submitted_at`)
      .bind(duel.id, user.id, JSON.stringify(duelEntry), now)
      .run();
  }

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
           r.status, r.stats_json, r.badges_json, r.chain_len,
           r.verified_at, r.submitted_at
    FROM records r JOIN users u ON u.id = r.user_id
    WHERE r.status != 'rejected'
    ORDER BY r.submitted_at DESC LIMIT 500`).all();
  const entries = rows.results
    .map((row) => {
      const stats = JSON.parse(row.stats_json);
      const badges = row.badges_json ? JSON.parse(row.badges_json) : [];
      return {
        handle: row.handle,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        status: row.status,
        chainLen: row.chain_len,
        verifiedAt: row.verified_at,
        stats,
        // Only the ids and tiers ride on the board; full evidence lives on
        // the profile, where there is room to show why each was earned.
        badges: badges.map((b) => ({ id: b.id, name: b.name, tier: b.tier.name })),
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
            badges_json, pricing_json, submitted_at, verified_at
     FROM records WHERE user_id = ?`)
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
      badges: record.badges_json ? JSON.parse(record.badges_json) : [],
      pricing: record.pricing_json ? JSON.parse(record.pricing_json) : null,
      submittedAt: record.submitted_at,
      verifiedAt: record.verified_at,
    } : null,
    sprints: sprints.results.map((row) => ({ weekId: row.week_id, entry: JSON.parse(row.entry_json) })),
  });
}

/* ---------------- activity feed ----------------
 *
 * The verifier's real work, streamed to the site: chains accepted, records
 * verified, submissions rejected. It exists because "we check everything" is
 * a claim, and watching the checks happen is evidence.
 *
 * One deliberate asymmetry: POSITIVE events carry the handle (those users
 * chose a public board), REJECTIONS never do. An automated verdict — which can
 * fire on thin candle data as easily as on fraud — must not publicly brand a
 * named person a cheat. The event and its reason are shown; the name is not.
 */
async function handleActivity(env) {
  const [subs, verifications] = await Promise.all([
    env.DB.prepare(`
      SELECT s.outcome, s.chain_len, s.created_at, u.handle
      FROM submissions s JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC LIMIT 40`).all(),
    env.DB.prepare(`
      SELECT u.handle, r.status, r.chain_len, r.pricing_json, r.verified_at
      FROM records r JOIN users u ON u.id = r.user_id
      WHERE r.verified_at IS NOT NULL
      ORDER BY r.verified_at DESC LIMIT 25`).all(),
  ]);

  const events = [];
  for (const row of subs.results) {
    const accepted = row.outcome === 'accepted';
    events.push({
      kind: accepted ? 'accepted' : 'rejected',
      // Rejections are anonymous on purpose — see the note above.
      handle: accepted ? row.handle : null,
      detail: accepted ? `chain of ${row.chain_len} links re-hashed, book replayed` : row.outcome,
      ts: row.created_at,
    });
  }
  for (const row of verifications.results) {
    const pricing = row.pricing_json ? JSON.parse(row.pricing_json) : null;
    events.push({
      kind: row.status === 'verified' ? 'verified' : row.status,
      handle: row.status === 'rejected' ? null : row.handle,
      detail: pricing
        ? `${pricing.counts.ok} fills re-priced against market history` +
          (pricing.counts.noData ? ` · ${pricing.counts.noData} without public candle data` : '')
        : 'verification complete',
      ts: row.verified_at,
    });
  }
  events.sort((a, b) => b.ts - a.ts);
  return json({ events: events.slice(0, 40) });
}

/* ---------------- duels ---------------- */

// Unambiguous alphabet: no O/0/I/1, because these codes get read aloud on
// streams and retyped from screenshots.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function duelCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return 'TRENCH-' + code;
}

/** A duel row plus both players, in the shape core/duel.js consumes. */
async function loadDuel(env, code) {
  const row = await env.DB.prepare(`
    SELECT d.*, c.handle AS c_handle, o.handle AS o_handle,
           cr.status AS c_status, orr.status AS o_status,
           ce.entry_json AS c_entry, ce.submitted_at AS c_submitted,
           oe.entry_json AS o_entry, oe.submitted_at AS o_submitted
    FROM duels d
    JOIN users c ON c.id = d.challenger_id
    LEFT JOIN users o ON o.id = d.opponent_id
    LEFT JOIN records cr ON cr.user_id = d.challenger_id
    LEFT JOIN records orr ON orr.user_id = d.opponent_id
    LEFT JOIN duel_entries ce ON ce.duel_id = d.id AND ce.user_id = d.challenger_id
    LEFT JOIN duel_entries oe ON oe.duel_id = d.id AND oe.user_id = d.opponent_id
    WHERE d.code = ?`).bind(String(code || '').toUpperCase()).first();
  if (!row) return null;

  const player = (handle, userId, status, entryJson, submittedAt) => ({
    handle, userId, status: status || 'pending',
    entry: entryJson ? JSON.parse(entryJson) : null,
    submittedAt: submittedAt || 0,
  });

  return {
    row,
    duel: {
      code: row.code, createdAt: row.created_at, acceptedAt: row.accepted_at,
      settledAt: row.settled_at, startTs: row.start_ts, endTs: row.end_ts,
      challengerId: row.challenger_id,
    },
    challenger: player(row.c_handle, row.challenger_id, row.c_status, row.c_entry, row.c_submitted),
    opponent: row.opponent_id
      ? player(row.o_handle, row.opponent_id, row.o_status, row.o_entry, row.o_submitted)
      : null,
  };
}

/** The public view, persisting the result the first time it becomes decidable
 * so a settled duel reads the same forever after. */
async function duelView(env, loaded) {
  const now = Date.now();
  if (loaded.row.settled_at) {
    const view = duel.view(loaded.duel, loaded.challenger, loaded.opponent, now);
    view.result = loaded.row.result_json ? JSON.parse(loaded.row.result_json) : view.result;
    view.status = duel.STATUS.SETTLED;
    return view;
  }
  const view = duel.view(loaded.duel, loaded.challenger, loaded.opponent, now);
  if (view.result && view.result.decided) {
    await env.DB.prepare(
      'UPDATE duels SET settled_at = ?, winner_handle = ?, result_json = ? WHERE id = ?')
      .bind(now, view.result.winner, JSON.stringify(view.result), loaded.row.id)
      .run();
  }
  return view;
}

async function handleDuelCreate(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  if (!(await allowRate(env, 'duel:' + user.id, DUELS_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  let body = {};
  try { body = await request.json(); } catch {}
  const durationMs = duel.clampDuration(Number(body.durationHours) * 3600000);
  const now = Date.now();
  const code = duelCode();
  await env.DB.prepare(`
    INSERT INTO duels (code, challenger_id, duration_ms, created_at) VALUES (?, ?, ?, ?)`)
    .bind(code, user.id, durationMs, now).run();
  return json({
    ok: true, code, durationMs,
    expiresAt: now + duel.INVITE_TTL_MS,
    url: env.SITE_ORIGIN + '/duel.html?code=' + code,
  });
}

async function handleDuelJoin(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  let body = {};
  try { body = await request.json(); } catch {}
  const loaded = await loadDuel(env, body.code);
  if (!loaded) return json({ ok: false, reason: 'not-found' }, 404);

  const now = Date.now();
  const problem = duel.joinProblem(loaded.duel, user.id, now);
  if (problem) return json({ ok: false, reason: problem }, 409);

  const window = duel.duelWindow(now, loaded.row.duration_ms);
  // Guarded by the same open-state predicate the check above used, so two
  // people racing the same invite cannot both become the opponent.
  const claim = await env.DB.prepare(`
    UPDATE duels SET opponent_id = ?, accepted_at = ?, start_ts = ?, end_ts = ?
    WHERE id = ? AND opponent_id IS NULL`)
    .bind(user.id, now, window.startTs, window.endTs, loaded.row.id)
    .run();
  if (!claim.meta || claim.meta.changes !== 1) {
    return json({ ok: false, reason: 'already-accepted' }, 409);
  }
  return json({ ok: true, code: loaded.row.code, window });
}

async function handleDuelGet(env, code) {
  const loaded = await loadDuel(env, code);
  if (!loaded) return json({ ok: false, reason: 'not-found' }, 404);
  return json(await duelView(env, loaded));
}

async function handleDuelsMine(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  const rows = await env.DB.prepare(
    `SELECT code FROM duels WHERE challenger_id = ? OR opponent_id = ?
     ORDER BY created_at DESC LIMIT 20`).bind(user.id, user.id).all();
  const duels = [];
  for (const row of rows.results) {
    const loaded = await loadDuel(env, row.code);
    if (loaded) duels.push(await duelView(env, loaded));
  }
  return json({ duels });
}

/* ---------------- pricing cron ---------------- */

async function drainPricing(env) {
  const now = Date.now();
  // Oldest pending record that is not backing off. Without the stall filter a
  // single record whose candles cannot be fetched would sit at the head of the
  // queue forever and no other record would ever be verified.
  const row = await env.DB.prepare(
    `SELECT user_id, starting_sol, pricing_progress_json FROM records
     WHERE status = 'pending'
       AND COALESCE(json_extract(pricing_progress_json, '$.stalledUntil'), 0) <= ?
     ORDER BY submitted_at ASC LIMIT 1`).bind(now).first();
  if (!row) return;
  const chain = await loadChain(env, row.user_id);
  if (!chain.length) return;

  const budget = { used: 0, max: CANDLE_BUDGET_PER_RUN };
  const progress = row.pricing_progress_json ? JSON.parse(row.pricing_progress_json) : null;
  const before = progress && Number(progress.cursor) > 0 ? Number(progress.cursor) : 0;
  let result;
  try {
    result = await priceRecord({ chain }, makeGetCandles(env, budget), progress, {
      // A lookup can cost up to three external calls (pool resolve, token
      // candle, SOL candle), so the per-run lookup cap is a third of the
      // call budget. Passing it is what makes priceChain pause cleanly at a
      // resumable cursor instead of running into the budget's own throw.
      maxLookups: Math.max(1, Math.floor(CANDLE_BUDGET_PER_RUN / 3)),
    });
  } catch (err) {
    return; // nothing verified this run; the next cron tick retries
  }

  if (!result.done) {
    // A run that priced nothing new is stalling on something outside our
    // control. Back it off so the queue keeps moving, but keep every verdict
    // already earned.
    const stalled = result.cursor <= before;
    await env.DB.prepare('UPDATE records SET pricing_progress_json = ? WHERE user_id = ?')
      .bind(JSON.stringify({
        cursor: result.cursor,
        verdicts: result.verdicts,
        stalledUntil: stalled ? now + PRICING_BACKOFF_MS : 0,
      }), row.user_id)
      .run();
    return;
  }
  // Re-award badges now that verification has a verdict: 'unbroken' is only
  // earnable by a record whose every fill actually survived re-pricing.
  const badges = awarded({
    chain, startingSol: row.starting_sol, chainLen: chain.length,
    pricingStatus: result.verdict.status, coverage: result.verdict.coverage,
  });
  await env.DB.prepare(`
    UPDATE records SET status = ?, pricing_json = ?, pricing_progress_json = NULL,
                       badges_json = ?, verified_at = ? WHERE user_id = ?`)
    .bind(result.verdict.status, JSON.stringify(result.verdict),
      JSON.stringify(badges), Date.now(), row.user_id)
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
            env.DB.prepare('DELETE FROM duel_entries WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM duels WHERE challenger_id = ? OR opponent_id = ?')
              .bind(user.id, user.id),
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
      else if (path === '/api/activity') response = await edgeCached(request, ctx, 20, () => handleActivity(env));
      // Duels are live and per-viewer, so they are never edge-cached.
      else if (path === '/api/duel/create' && request.method === 'POST') response = await handleDuelCreate(request, env);
      else if (path === '/api/duel/join' && request.method === 'POST') response = await handleDuelJoin(request, env);
      else if (path === '/api/duel/mine') response = await handleDuelsMine(request, env);
      else if (path === '/api/duel') response = await handleDuelGet(env, url.searchParams.get('code') || '');
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
