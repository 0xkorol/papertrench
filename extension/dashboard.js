/* PaperTrench — dashboard/options page. */

'use strict';

const E = window.PaperEngine;
if (!E) {
  document.body.innerHTML =
    '<div style="padding:40px;color:#f85149;font-family:system-ui">' +
    'engine.js failed to load. Reload the extension at chrome://extensions.</div>';
  throw new Error('PaperEngine missing');
}

const RP = window.PTReplay;
if (!RP) throw new Error('PTReplay module missing');
const RC = window.PTRecordings;
if (!RC) throw new Error('PTRecordings store missing');
const AT = window.PTAttest;
if (!AT) throw new Error('PTAttest module missing');
const PC = window.PTPnlCard;
if (!PC) throw new Error('PTPnlCard module missing');

const DEFAULTS = E.DEFAULT_SETTINGS;
let settings = E.defaultSettings();
let state = E.defaultState(settings);
let frames = [];
let replays = [];
let selectedReplayId = null;
let replayCursor = 0;
let replayTimer = null;
let recordings = {};        // roundId -> stored recording (blob included)
const recordingUrls = {};   // roundId -> object URL, created lazily
let preferFrameOverVideo = false;
let lastFingerprint = '';
let replayShell = null;   // persistent replay DOM, so the video survives updates
let replayRaf = null;     // requestAnimationFrame handle for video-driven sync
// D-17: the session AI review lives in module state and is re-injected into
// the staged markup on every render. It used to be written into the live DOM
// only, so the next staged refresh (whose markup still held the empty box)
// wiped the answer seconds after it appeared.
let sessionReview = null; // { text, error }
// D-18: chain verification is memoized by a cheap fingerprint (length + head
// hash + the claim inputs). Without it every staged leaderboard render showed
// the "Checking…" placeholder again and re-ran SHA-256 over the WHOLE chain
// ~once a second — and an in-flight verify could land in a detached node.
let lbVerifyCache = null;      // { key, valid, problems, ok, diff, derivedPnlSol }
let lbVerifyInFlightKey = null;
/**
 * Storage access that fails soft — same contract as content.js's store helper:
 * get() resolves null when the read FAILED (chrome.runtime.lastError or a
 * throw) and {} when it succeeded but nothing is stored. Callers must never
 * treat a failed read as "empty wallet" — loadAll would fabricate a fresh
 * state and the next note/review save would persist that empty wallet over
 * the real one at seq+1 (D-15).
 *
 * set() rejects on failure so a lost write can be shown instead of being
 * silently swallowed (D-25).
 */
const store = {
  get: (keys) => new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (value) => {
        if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
        resolve(value || {});
      });
    } catch (_) { resolve(null); }
  }),
  set: (obj) => new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'storage write failed'));
          return;
        }
        resolve();
      });
    } catch (err) { reject(err); }
  }),
};
// D-15: true while the most recent storage read failed. The dashboard keeps
// rendering whatever it already holds and refuses every write until a later
// read succeeds — writing while blind is how a fabricated empty wallet
// overwrites the real one.
let storageReadFailed = false;

const SECTIONS = ['overview', 'calendar', 'journal', 'rounds', 'replay', 'leaderboard', 'coach', 'settings'];
let currentSection = 'overview';

async function init() {
  await loadAll();
  bindNav();
  bindShareCard();
  renderSidebar();
  renderSection(currentSection);
  // Seed the baseline so the first poll does not re-render an unchanged page.
  lastFingerprint = dataFingerprint();
  // Refresh on CHANGE, not on a timer.
  //
  // The previous build re-rendered the whole section every 5 seconds whether
  // anything had changed or not. Because renderSection() clears the section
  // first, that wiped scroll position, focus, half-typed settings, and the
  // replay's video element — the "constantly refreshing" behaviour.
  //
  // chrome.storage fires onChanged whenever the extension writes, so that is
  // the correct trigger. The interval that remains only refreshes derived
  // values (relative timestamps, live position marks) and is skipped entirely
  // when nothing is actually different.
  watchDashboardStorage();
  // D-28: live-derived values (open-position P&L, relative timestamps, the
  // sidebar equity) update IN PLACE after each change check — they never
  // rebuild a section, so scroll and hover survive the 800 ms heartbeat.
  setInterval(() => { refreshIfChanged().then(refreshLiveDerived).catch(() => {}); }, 4000);
}

/**
 * D-16: init() used to be fired unawaited with no catch — any throw (legacy
 * state shapes, a corrupt backup, a renderer bug) left a permanently blank
 * dashboard with no message at all. Failures now render a plain-DOM error
 * card: message plus a reload button, built without innerHTML so the error
 * path itself can never throw on odd content.
 */
function renderInitError(err) {
  try {
    console.error('PaperTrench dashboard failed to initialise', err);
    const card = document.createElement('div');
    card.id = 'init-error';
    card.style.cssText =
      'max-width:560px;margin:60px auto;padding:24px 26px;'
      + 'background:#12161E;border:1px solid rgba(255,95,86,.45);border-radius:14px;'
      + 'color:#EAEFF7;font-family:system-ui,sans-serif';
    const title = document.createElement('h2');
    title.textContent = 'Dashboard failed to load';
    title.style.cssText = 'margin:0 0 8px;font-size:16px';
    const message = document.createElement('p');
    message.textContent = (err && err.message) ? err.message : String(err);
    message.style.cssText = 'margin:0 0 14px;color:#8D97A9;font-size:13px;word-break:break-word';
    const reload = document.createElement('button');
    reload.textContent = 'Reload dashboard';
    reload.style.cssText =
      'padding:8px 14px;border:1px solid rgba(255,255,255,.2);border-radius:8px;'
      + 'background:rgba(255,255,255,.06);color:#EAEFF7;cursor:pointer';
    reload.addEventListener('click', () => location.reload());
    card.append(title, message, reload);
    document.body.appendChild(card);
  } catch (_) { /* the error path must never throw */ }
}


/**
 * A cheap signature of everything the dashboard renders.
 *
 * Comparing this avoids the expense of a deep diff while still catching real
 * changes: a new fill, a closed round, a settings edit, or a fresh replay
 * checkpoint all move at least one of these numbers.
 */
function dataFingerprint() {
  const positions = Object.values(state.positions || {});
  return [
    (state.journal || []).length,
    (state.rounds || []).length,
    positions.length,
    // D-28: position IDENTITY and SIZE only — never the live price mark.
    // lastPriceNative moves on every 800 ms heartbeat, so including it made
    // the fingerprint churn ~1/s and renderSection replaceChildren'd the
    // visible table constantly (scroll and hover reset each second). Live
    // P&L is painted in place by refreshLiveDerived() instead.
    positions.map((p) => `${p.mint}:${p.qty}`).join(','),
    // D-27: in-place round mutations (AI review, note, thesis, recording
    // refs) change no array length, so the fingerprint could not see them —
    // with D-13 fixed those writes land in storage but the dashboard never
    // repainted. Cheap per-round markers (timestamps/lengths) catch them.
    (state.rounds || []).map((r) => [
      r.aiReview ? (Number(r.aiReview.t) || 1) : 0,
      r.note && r.note.text ? `${Number(r.note.t) || 1}.${r.note.text.length}` : 0,
      r.thesis ? ((r.thesis.text || '').length + ((r.thesis.tags || []).length)) : 0,
      r.recordingFile || '',
      r.recording ? 1 : 0,
    ].join(':')).join(','),
    Number(state.cashSol).toFixed(6),
    frames.length,
    replays.length,
    replays.reduce((sum, r) => sum + (r.checkpoints ? r.checkpoints.length : 0), 0),
    Object.keys(recordings).length,
    JSON.stringify(settings),
  ].join('|');
}

/** Re-render only when something the user can see has actually changed. */
async function refreshIfChanged() {
  // Never yank the ground out from under an interaction.
  if (isUserBusy()) return;
  await loadAll();
  const next = dataFingerprint();
  if (next === lastFingerprint) return;
  lastFingerprint = next;
  renderSidebar();
  renderSection(currentSection);
}

/**
 * D-28: paint live-derived values IN PLACE — no section is ever rebuilt here.
 *
 * The heartbeat moves open-position marks every ~800 ms and relative
 * timestamps age every second; rebuilding a table for either reset scroll and
 * hover ~once a second. These updaters touch text nodes (and the sidebar,
 * which contains no interactive state) and nothing else.
 */
function refreshLiveDerived() {
  renderSidebar(); // has its own identical-markup guard
  updateOpenPositionMarks();
  updateRelativeTimes();
  // The curve's head point carries live unrealized P&L; a canvas redraw
  // destroys no DOM state.
  if (currentSection === 'overview') drawEquityCurve();
}

/** D-28: live open-position P&L — update the marked text nodes, never rebuild. */
function updateOpenPositionMarks() {
  document.querySelectorAll('[data-pos-row]').forEach((row) => {
    const p = (state.positions || {})[row.dataset.posRow];
    if (!p) return; // closed — the fingerprint change rebuilds the section
    const node = row.querySelector('[data-pos-pnl]');
    if (!node) return;
    const pnl = E.unrealizedPnl(p);
    // D-08: gross-invested basis, same as closed rounds.
    const pct = E.positionPnlPct(p);
    const win = pnl >= 0;
    node.classList.toggle('green', win);
    node.classList.toggle('red', !win);
    node.textContent = `${win ? '+' : ''}${fmt(pnl)} SOL (${win ? '+' : ''}${pct.toFixed(1)}%)`;
    const qtyNode = row.querySelector('[data-pos-qty]');
    if (qtyNode) qtyNode.textContent = `${fmt(p.qty, 2)} tokens`;
  });
}

/**
 * D-28: relative timestamps ("12s", "3m") are refreshed in place on the
 * change-check timer. Rendering them as churning markup made every staged
 * rebuild differ from the live DOM by nothing but the clock.
 */
function updateRelativeTimes() {
  document.querySelectorAll('[data-rel-ts]').forEach((node) => {
    const ts = Number(node.dataset.relTs);
    if (!(ts > 0)) return;
    const label = timeAgo(ts);
    if (node.textContent !== label) node.textContent = label;
  });
}

/**
 * True while the user is mid-interaction with the CURRENT section.
 *
 * Rebuilding under a focused input destroys what they are typing; rebuilding a
 * playing video restarts it. Neither is ever worth a refresh.
 *
 * D-34: busy is judged per section. Only the visible section is ever
 * rebuilt by a refresh, so only interactions INSIDE it may freeze it — a
 * focused replay scrubber must not freeze the journal, and a focused input
 * that lives outside the sections (the share-card modal) must not freeze
 * anything at all.
 */
function isUserBusy() {
  const section = document.getElementById(currentSection);
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)
      && section && section.contains(active)) return true;
  if (currentSection === 'replay' && replayPlaying()) return true;
  // D-20: an OPEN round-note editor counts as busy by its DOM presence,
  // focus or not. The focus-only check meant one click outside the textarea
  // let the next refresh destroy the editor and everything typed into it.
  if (currentSection === 'rounds' && section && section.querySelector('.note-input')) return true;
  // Settings is a form: rebuilding it would silently discard unsaved edits,
  // and nothing on that screen benefits from a background refresh anyway.
  if (currentSection === 'settings') return true;
  return false;
}

/**
 * React to extension writes immediately instead of waiting for a poll.
 *
 * This is what makes a fill appear in the journal the moment it happens while
 * still leaving the page completely still when nothing is going on.
 */
function watchDashboardStorage() {
  if (!chrome.storage || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = ['pt_state', 'pt_settings', 'pt_frames', RP.STORAGE_KEY]
      .some((key) => key in changes);
    if (!relevant) return;
    // D-28: heartbeat writes carry fresh live marks; paint them in place.
    refreshIfChanged().then(refreshLiveDerived).catch(() => {});
  });
}

async function loadAll() {
  const s = await store.get(['pt_state', 'pt_settings', 'pt_frames', RP.STORAGE_KEY]);
  if (s === null) {
    // D-15: the read FAILED — this is not "empty storage". Keep whatever is
    // already in memory, show a banner, and block writes until a read
    // succeeds. Fabricating a fresh wallet here and then saving a note would
    // persist an empty wallet over the real one.
    storageReadFailed = true;
    renderStorageErrorBanner();
    return;
  }
  storageReadFailed = false;
  renderStorageErrorBanner();
  settings = E.mergeSettings(s.pt_settings);
  state = s.pt_state || E.defaultState(settings);
  frames = s.pt_frames || [];
  replays = RP.normalizeReplayList(s[RP.STORAGE_KEY]);
  if (!selectedReplayId && replays[0]) selectedReplayId = replays[0].sessionId;

  // Videos are not needed to paint anything except Replay, and they come from
  // IndexedDB, which can be slow or unavailable. Awaiting them here meant a
  // stalled database left the ENTIRE dashboard blank, with no error to explain
  // it. Kick the load off without blocking the first paint, then repaint the
  // Replay view only if recordings actually arrived.
  loadRecordings()
    .then(() => {
      if (Object.keys(recordings).length && currentSection === 'replay') renderSection('replay');
    })
    .catch(() => {});
}

/**
 * D-15: a visible, plain-DOM banner while storage is unreadable, removed the
 * moment a read succeeds. Without it a failed read looked exactly like a
 * fresh wallet.
 */
function renderStorageErrorBanner() {
  let banner = document.getElementById('pt-storage-error');
  if (!storageReadFailed) { if (banner) banner.remove(); return; }
  if (banner) return;
  banner = document.createElement('div');
  banner.id = 'pt-storage-error';
  banner.textContent =
    'Storage read failed — showing the last data this page loaded. Saving is '
    + 'disabled until a read succeeds. Reload the dashboard if this persists.';
  banner.style.cssText =
    'background:rgba(255,95,86,.14);border-bottom:1px solid rgba(255,95,86,.45);'
    + 'color:#FFB3AE;padding:9px 26px;font-size:12.5px;font-weight:600';
  document.body.insertBefore(banner, document.body.firstChild);
}

async function saveSettings() {
  // D-15: never write over storage we could not read — the in-memory copy
  // may be a fabricated default or stale.
  if (storageReadFailed) {
    throw new Error('Storage is unreadable — settings were NOT saved. Reload the dashboard and try again.');
  }
  await store.set({ pt_settings: settings });
}

/**
 * D-22: every dashboard state write goes through mutate-with-retry.
 *
 * The old saveState() was a blind read-modify-write: the dashboard and a
 * trading tab both holding seq N would each write N+1 and the loser's change
 * simply vanished. This mirrors the philosophy of content.js's persistSoon
 * writer: read the FRESHEST stored state, apply the mutation to that copy,
 * bump seq exactly once, and re-check the stored seq immediately before
 * writing — if another writer bumped it in between, re-read and re-apply the
 * mutation on the newer state (bounded retries).
 *
 * `mutate(fresh)` receives the freshly read state and edits it in place; a
 * throw inside it aborts the save. On success the written state is adopted
 * as the module's own.
 */
async function mutateState(mutate, retries = 3) {
  const unreadable = () => new Error(
    'Storage is unreadable — the wallet was NOT saved. Reload the dashboard and try again.'
  );
  // D-15: never write over storage we could not read — persisting a
  // fabricated in-memory state is how a note-save destroys the real wallet.
  if (storageReadFailed) throw unreadable();
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const stored = await store.get(['pt_state']);
    if (stored === null) throw unreadable();
    const fresh = stored.pt_state;
    if (!fresh || typeof fresh !== 'object') {
      // A successful read with nothing stored: there is no wallet to
      // annotate, and writing one from here would fabricate it (D-15).
      throw new Error('No saved wallet found to update.');
    }
    const baseSeq = Number(fresh.seq) || 0;
    mutate(fresh);
    // Bump the write counter exactly once: every writer must advance seq, or
    // a lagging content tab (which only adopts when storage's seq is strictly
    // greater) clobbers this write with a stale copy.
    fresh.seq = baseSeq + 1;
    fresh.updatedAt = Date.now();
    // Conflict check: if another writer advanced seq between our read and
    // now, our base is stale — loop and re-apply the mutation on the newer
    // state instead of overwriting it.
    const check = await store.get(['pt_state']);
    if (check === null) throw unreadable();
    const checkSeq = Number(check.pt_state && check.pt_state.seq) || 0;
    if (checkSeq !== baseSeq) continue;
    await store.set({ pt_state: fresh });
    state = fresh;
    return fresh;
  }
  throw new Error('Another tab kept writing the wallet — the change was NOT saved. Try again.');
}

function bindNav() {
  document.querySelectorAll('nav button').forEach((b) => {
    b.addEventListener('click', () => {
      currentSection = b.dataset.section;
      if (currentSection !== 'replay') { stopReplayPlayback(); releaseReplayShell(); }
      document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
      SECTIONS.forEach((id) => document.getElementById(id).classList.toggle('hidden', id !== currentSection));
      renderSection(currentSection);
    });
  });
}

/**
 * Render a section without ever showing an empty frame.
 *
 * The old implementation blanked the element (`innerHTML = ''`) and then
 * rebuilt it. Between those two steps the browser could paint, so the section
 * visibly flashed empty. Sections are now built off-screen and swapped in one
 * operation — and if the resulting markup is identical to what is already on
 * screen, nothing is touched at all.
 *
 * The replay owns its own DOM lifecycle (it holds a live <video>), so it is
 * excluded from this path.
 */
function renderSection(id) {
  const el = document.getElementById(id);
  if (!el) return;

  if (id === 'replay') { renderReplay(el); return; }

  // Build into a detached element: nothing here is ever painted.
  const staged = document.createElement('div');
  if (id === 'overview') renderOverview(staged);
  else if (id === 'calendar') renderCalendar(staged);
  else if (id === 'journal') renderJournal(staged);
  else if (id === 'rounds') renderRounds(staged);
  else if (id === 'leaderboard') renderLeaderboard(staged);
  else if (id === 'coach') renderCoach(staged);
  else if (id === 'settings') renderSettings(staged);

  // Identical output means there is nothing to repaint.
  if (el.innerHTML === staged.innerHTML) return;

  // replaceChildren swaps in a single mutation, so no empty frame exists.
  if (typeof el.replaceChildren === 'function') el.replaceChildren(...staged.childNodes);
  else el.innerHTML = staged.innerHTML;
  rebindSection(id, el);
}


/**
 * Attach event handlers after a section's markup is live in the document.
 *
 * Sections are rendered into a detached element to avoid a visible empty
 * frame, which means handlers cannot be bound during render — the nodes are
 * not yet reachable from `document`.
 */
function rebindSection(id, el) {
  if (id === 'overview') {
    // The canvas needs real layout before it can be sized and drawn.
    drawEquityCurve();
    return;
  }
  if (id === 'calendar') { bindCalendar(el); return; }
  if (id === 'rounds') {
    el.querySelectorAll('.review-btn').forEach((button) =>
      button.addEventListener('click', () => runReview(button.dataset.reviewId)));
    el.querySelectorAll('.replay-btn').forEach((button) =>
      button.addEventListener('click', () => openReplay(button.dataset.session)));
    el.querySelectorAll('.share-btn').forEach((button) =>
      button.addEventListener('click', () => openShareCard(button.dataset.id)));
    el.querySelectorAll('.note-btn').forEach((button) =>
      button.addEventListener('click', () => editRoundNote(button)));
    return;
  }
  if (id === 'coach') {
    const run = el.querySelector('#coach-session');
    if (run) run.addEventListener('click', runSessionReview);
    return;
  }
  if (id === 'leaderboard') { bindLeaderboard(el); return; }
  if (id === 'settings') bindSettings();
}

/* ---------- sidebar ---------- */

function renderSidebar() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  const stats = E.sessionStats(state, settings);
  const up = stats.equityVsStart >= 0;
  const pct = settings.balanceStartSol ? (stats.equityVsStart / settings.balanceStartSol) * 100 : 0;
  const winRate = stats.winRate === null ? null : stats.winRate;

  const markup = `
    <div class="kpi hero">
      <div class="lab">Paper equity</div>
      <div class="num ${up ? 'green' : 'red'}">${fmt(stats.equitySol, 2)} <span style="font-size:13px;font-weight:700;opacity:.6">SOL</span></div>
      <div class="sub ${up ? 'green' : 'red'}">${up ? '▲' : '▼'} ${up ? '+' : ''}${fmt(stats.equityVsStart, 3)} SOL (${up ? '+' : ''}${pct.toFixed(1)}%)</div>
      ${equitySparkline()}
    </div>
    <div class="kpi">
      <div class="lab">Realized P&amp;L</div>
      <div class="num ${stats.realizedPnlSol >= 0 ? 'green' : 'red'}">${stats.realizedPnlSol >= 0 ? '+' : ''}${fmt(stats.realizedPnlSol, 3)}</div>
      <div class="sub">${stats.trades} fills · ${fmt(stats.feesPaidSol, 3)} SOL fees</div>
    </div>
    <div class="kpi">
      <div class="lab">Win rate</div>
      <div class="num">${winRate === null ? '—' : winRate.toFixed(0) + '%'}</div>
      ${winRateBar(stats)}
      <div class="sub">${stats.wins}W · ${stats.losses}L</div>
    </div>
    <div class="kpi">
      <div class="lab">Open / Rounds</div>
      <div class="num">${stats.openPositions} <span style="opacity:.35">/</span> ${stats.rounds}</div>
      <div class="sub ${stats.unrealizedSol >= 0 ? 'green' : 'red'}">${stats.unrealizedSol >= 0 ? '+' : ''}${fmt(stats.unrealizedSol, 3)} SOL unrealized</div>
    </div>
  `;
  // Writing identical markup still forces a repaint; skip it.
  if (sb.innerHTML !== markup) sb.innerHTML = markup;
}

/** Win/loss proportion bar — instant read on consistency. */
function winRateBar(stats) {
  const total = stats.wins + stats.losses;
  if (!total) return '';
  const w = (stats.wins / total) * 100;
  return `
    <div style="display:flex;height:4px;margin-top:8px;border-radius:99px;overflow:hidden;background:rgba(255,255,255,.08)">
      <div style="width:${w}%;background:var(--green)"></div>
      <div style="width:${100 - w}%;background:var(--red);opacity:.75"></div>
    </div>`;
}

/** Tiny equity trend in the sidebar, built from realized round results. */
function equitySparkline() {
  const rounds = [...(state.rounds || [])].reverse();
  if (rounds.length < 2) return '';
  let eq = settings.balanceStartSol;
  const pts = [eq];
  for (const r of rounds) { eq += Number(r.pnlSol) || 0; pts.push(eq); }

  const w = 100, h = 30, pad = 3;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || Math.abs(max) || 1;
  const step = w / (pts.length - 1);
  const y = (v) => pad + (h - pad * 2) * (1 - (v - min) / span);
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  const c = up ? '#34D399' : '#FF5F56';

  return `<svg class="spark-mini" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="kpiSpark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c}" stop-opacity=".3"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${d} L${w},${h} L0,${h} Z" fill="url(#kpiSpark)"/>
    <path d="${d}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/* ---------- overview ---------- */

function renderOverview(el) {
  const stats = E.sessionStats(state, settings);
  const best = [...(state.rounds || [])].sort((a, b) => b.pnlSol - a.pnlSol)[0];
  const worst = [...(state.rounds || [])].sort((a, b) => a.pnlSol - b.pnlSol)[0];

  // D-07: the Best/Worst tiles are coloured by the ACTUAL sign of the value
  // (a session of only losses has a negative "best" round, and vice versa),
  // and every value carries an explicit sign — the old Worst tile dropped it.
  el.innerHTML = `
    <div class="grid3" style="margin-bottom:16px">
      ${statTile('Total return', `${stats.equityVsStart >= 0 ? '+' : ''}${fmt(stats.equityVsStart, 3)} SOL`, stats.equityVsStart >= 0 ? 'green' : 'red',
        settings.balanceStartSol ? `${stats.equityVsStart >= 0 ? '+' : ''}${((stats.equityVsStart / settings.balanceStartSol) * 100).toFixed(1)}% on ${fmt(settings.balanceStartSol, 2)} SOL` : '')}
      ${statTile('Best round', best ? `${best.pnlSol >= 0 ? '+' : ''}${fmt(best.pnlSol, 3)} SOL` : '—', best && best.pnlSol < 0 ? 'red' : 'green', best ? `${best.symbol} · ${best.pnlPct >= 0 ? '+' : ''}${best.pnlPct.toFixed(1)}%` : 'No closed rounds yet')}
      ${statTile('Worst round', worst ? `${worst.pnlSol >= 0 ? '+' : ''}${fmt(worst.pnlSol, 3)} SOL` : '—', worst && worst.pnlSol >= 0 ? 'green' : 'red', worst ? `${worst.symbol} · ${worst.pnlPct >= 0 ? '+' : ''}${worst.pnlPct.toFixed(1)}%` : 'No closed rounds yet')}
    </div>
    <div class="grid2">
      <div class="card"><h3>Equity curve</h3><canvas class="chart" id="eq-canvas"></canvas></div>
      <div class="card"><h3>Recent round trips</h3><div id="rounds-mini"></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>Live open positions</h3><div id="open-pos"></div></div>
  `;
  const miniRounds = el.querySelector('#rounds-mini');
  if (miniRounds) miniRounds.innerHTML = renderMiniRounds();
  const openPos = el.querySelector('#open-pos');
  if (openPos) openPos.innerHTML = renderOpenPositions();
  // The canvas must be in the document before it can be measured and drawn.
}

function statTile(label, value, tone, sub) {
  return `
    <div class="card" style="padding:15px 16px">
      <div class="lab" style="font-size:9.5px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:var(--faint)">${esc(label)}</div>
      <div class="${tone}" style="margin-top:5px;font-size:23px;font-weight:800;letter-spacing:-0.6px">${esc(value)}</div>
      <div class="dim" style="margin-top:3px;font-size:11.5px">${esc(sub || '')}</div>
    </div>`;
}

/**
 * Equity curve, drawn crisply on a device-pixel-ratio-scaled canvas.
 *
 * D-01: the points come from E.equityCurvePoints, which debits buy-side fees
 * as the journal is walked. The old accumulation summed sell pnlSol alone —
 * net of sell fees but NOT buy fees — so the curve floated above true equity
 * by the cumulative buy fees, visibly disagreeing with the equitySol KPI on
 * the same screen. The final point now equals E.equitySol (cash + marked
 * positions) exactly.
 */
function drawEquityCurve() {
  const cvs = document.getElementById('eq-canvas');
  if (!cvs || typeof cvs.getContext !== 'function') return;
  const ctx = cvs.getContext('2d');
  if (!ctx) return;

  // Match the backing store to the CSS box so lines land on real pixels.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = cvs.clientWidth || 760;
  const cssH = cvs.clientHeight || 260;
  cvs.width = Math.round(cssW * dpr);
  cvs.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const start = Number(settings.balanceStartSol) || 0;
  const pts = E.equityCurvePoints(state, start);

  if ((state.journal || []).length === 0) {
    ctx.fillStyle = '#5A6273';
    ctx.textAlign = 'center';
    ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('No trades yet — your equity curve will appear here.', cssW / 2, cssH / 2);
    return;
  }

  const padL = 52, padR = 16, padT = 16, padB = 26;
  const xs = pts.map((p) => p.t);
  const ys = pts.map((p) => p.eq);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let lo = Math.min(...ys, start), hi = Math.max(...ys, start);
  const span = (hi - lo) || Math.abs(hi) * 0.04 || 1;
  lo -= span * 0.14; hi += span * 0.14;

  const X = (t) => padL + (cssW - padL - padR) * (x1 === x0 ? 1 : (t - x0) / (x1 - x0));
  const Y = (v) => padT + (cssH - padT - padB) * (1 - (v - lo) / (hi - lo));

  // horizontal grid + value labels
  ctx.font = '500 10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * (i / 4);
    const y = Y(v);
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
    ctx.fillStyle = '#5A6273';
    ctx.fillText(v.toFixed(2), padL - 9, y);
  }

  const profitable = pts[pts.length - 1].eq >= start;
  const stroke = profitable ? '#34D399' : '#FF5F56';

  // gradient area under the curve
  const grad = ctx.createLinearGradient(0, padT, 0, cssH - padB);
  grad.addColorStop(0, profitable ? 'rgba(52,211,153,0.30)' : 'rgba(255,95,86,0.30)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(X(pts[0].t), Y(pts[0].eq));
  for (const p of pts) ctx.lineTo(X(p.t), Y(p.eq));
  ctx.lineTo(X(pts[pts.length - 1].t), cssH - padB);
  ctx.lineTo(X(pts[0].t), cssH - padB);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // starting-balance reference
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = 'rgba(255,157,69,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, Y(start)); ctx.lineTo(cssW - padR, Y(start)); ctx.stroke();
  ctx.setLineDash([]);

  // the curve itself, with a soft glow
  ctx.shadowColor = profitable ? 'rgba(52,211,153,0.45)' : 'rgba(255,95,86,0.45)';
  ctx.shadowBlur = 11;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.t), Y(p.eq)) : ctx.lineTo(X(p.t), Y(p.eq))));
  ctx.stroke();
  ctx.shadowBlur = 0;

  // head marker
  const last = pts[pts.length - 1];
  ctx.fillStyle = stroke;
  ctx.beginPath(); ctx.arc(X(last.t), Y(last.eq), 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(X(last.t), Y(last.eq), 3.5, 0, Math.PI * 2); ctx.stroke();
}

function renderMiniRounds() {
  const rounds = (state.rounds || []).slice(0, 9);
  if (!rounds.length) return emptyState('No closed round trips yet', 'Complete a paper trade to see it here.');
  const peak = Math.max(...rounds.map((r) => Math.abs(r.pnlSol)), 1e-9);
  return rounds.map((r) => {
    const win = r.pnlSol >= 0;
    const w = Math.max(3, (Math.abs(r.pnlSol) / peak) * 100);
    return `
      <div class="stat" style="align-items:center">
        <span style="min-width:0;color:var(--text)">
          <strong>${esc(r.symbol)}</strong>
          <span class="dim" style="font-size:11px"> · ${(r.heldMs / 60000).toFixed(1)}m</span>
          <span style="display:block;margin-top:5px;height:3px;width:${w}%;border-radius:99px;background:${win ? 'var(--green)' : 'var(--red)'};opacity:.65"></span>
        </span>
        <span class="${win ? 'green' : 'red'}" style="font-weight:750;white-space:nowrap">
          ${win ? '+' : ''}${fmt(r.pnlSol, 3)} SOL
          <span style="display:block;font-size:10.5px;opacity:.7;font-weight:600">${win ? '+' : ''}${r.pnlPct.toFixed(1)}%</span>
        </span>
      </div>`;
  }).join('');
}

function renderOpenPositions() {
  const mints = Object.keys(state.positions || {});
  if (!mints.length) return emptyState('No open positions', 'Your live paper positions will appear here.');
  return mints.map((m) => {
    const p = state.positions[m];
    const pnl = E.unrealizedPnl(p);
    // D-08: percentage on the gross-invested basis — the same denominator
    // closed rounds use (engine closeRound: returned/investedSol − 1). The
    // old pnl/costSol (net-of-fee) basis made the % jump ~2×feeBps at the
    // moment of close with no price move.
    const pct = E.positionPnlPct(p);
    const win = pnl >= 0;
    // D-28: data-pos-row/-pnl/-qty mark the nodes refreshLiveDerived updates
    // in place on each heartbeat — the section itself is never rebuilt for a
    // price tick.
    return `
      <div class="stat" style="align-items:center" data-pos-row="${esc(p.mint)}">
        <span style="min-width:0;color:var(--text)">
          <strong style="font-size:14px">${esc(p.symbol)}</strong>
          <span class="dim mono" style="display:block;font-size:10.5px;margin-top:2px">${esc(E.short(p.mint))} · ${esc(p.site)}</span>
        </span>
        <span style="text-align:right;white-space:nowrap">
          <span class="mono" style="font-size:12px" data-pos-qty>${fmt(p.qty, 2)} tokens</span>
          <span class="${win ? 'green' : 'red'}" style="display:block;margin-top:3px;font-weight:800;font-size:14px" data-pos-pnl>${win ? '+' : ''}${fmt(pnl)} SOL (${win ? '+' : ''}${pct.toFixed(1)}%)</span>
        </span>
      </div>`;
  }).join('');
}

function emptyState(title, sub) {
  return `<div class="empty"><strong>${esc(title)}</strong><span style="font-size:12px">${esc(sub || '')}</span></div>`;
}

/* ---------- P&L calendar ----------
 *
 * The daily performance grid Axiom/Padre/GMGN show for real wallets, fed by
 * the paper journal instead. Layout follows theirs: Monday-start weeks, a
 * weekly-total column, and month navigation bounded by the journal's span.
 */

// The month currently on screen; null means "the month containing today".
let calendarView = null;

function monthIndex(y, m) { return y * 12 + m; }

function renderCalendar(el) {
  const range = E.pnlCalendarRange(state);
  const now = new Date();
  const requested = calendarView || { year: now.getFullYear(), month: now.getMonth() };
  const viewIdx = Math.max(
    monthIndex(range.min.year, range.min.month),
    Math.min(monthIndex(range.max.year, range.max.month), monthIndex(requested.year, requested.month))
  );
  const view = { year: Math.floor(viewIdx / 12), month: ((viewIdx % 12) + 12) % 12 };
  calendarView = view;

  const cal = E.pnlCalendar(state, view.year, view.month);
  const t = cal.totals;
  const isCurrentMonth = cal.todayDay !== null;
  const monthName = new Date(view.year, view.month, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  // D-33: the best/worst-day chip needs a SHORT month name. Deriving it by
  // splitting/slicing the long locale string breaks wherever the year comes
  // first (ja-JP, hu-HU render "2026…" → "202"); ask the locale directly.
  const monthShort = new Date(view.year, view.month, 1)
    .toLocaleDateString(undefined, { month: 'short' });
  const atMin = viewIdx <= monthIndex(range.min.year, range.min.month);
  const atMax = viewIdx >= monthIndex(range.max.year, range.max.month);
  const cls = (v) => (v > 0 ? 'green' : v < 0 ? 'red' : 'dim');
  const signed = (v) => `${v > 0 ? '+' : ''}${fmt(v, 2)}`;

  const summary = `
    <div class="cal-summary">
      <span>Realized <strong class="${cls(t.realizedSol)}">${signed(t.realizedSol)} SOL</strong></span>
      <span>Days <strong>${t.winDays}<span class="green">W</span> · ${t.lossDays}<span class="red">L</span>${t.flatDays ? ` · ${t.flatDays} flat` : ''}</strong></span>
      ${t.bestDay ? `<span>Best <strong class="green">${signed(t.bestDay.pnlSol)}</strong> <span class="dim">(${monthShort} ${t.bestDay.day})</span></span>` : ''}
      ${t.worstDay && t.worstDay.pnlSol < 0 ? `<span>Worst <strong class="red">${signed(t.worstDay.pnlSol)}</strong> <span class="dim">(${monthShort} ${t.worstDay.day})</span></span>` : ''}
      ${isCurrentMonth ? `<span>Open <strong class="${cls(cal.openPnlSol)}">${signed(cal.openPnlSol)} SOL</strong> <span class="dim">unrealized</span></span>` : ''}
    </div>`;

  const header = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .map((d) => `<div class="cal-head">${d}</div>`).join('') + '<div class="cal-head cal-week-head">Week</div>';

  const body = cal.weeks.map((week) => {
    const cells = week.days.map((c) => {
      if (!c) return '<div class="cal-day blank" aria-hidden="true"></div>';
      const tone = !c.hasTrades ? '' : c.realizedSol > 0 ? 'win' : c.realizedSol < 0 ? 'loss' : 'flat';
      const today = c.day === cal.todayDay ? ' today' : '';
      const tip = c.sells
        ? Object.entries(c.symbols).map(([s, p]) => `${s} ${signed(p)}`).join('  ·  ')
        : (c.buys ? 'Open entries only — nothing realized yet' : '');
      const parts = [];
      if (c.buys) parts.push(`${c.buys} buy${c.buys > 1 ? 's' : ''}`);
      if (c.sells) parts.push(`${c.sells} sell${c.sells > 1 ? 's' : ''}`);
      return `<div class="cal-day ${tone}${today}"${tip ? ` title="${esc(tip)}"` : ''}>
        <span class="cal-date">${c.day}</span>
        ${c.sells
          ? `<span class="cal-pnl">${signed(c.realizedSol)}</span>`
          : '<span class="cal-pnl cal-zero">0</span>'}
        ${parts.length ? `<span class="cal-trades">${parts.join(' · ')}</span>` : ''}
      </div>`;
    }).join('');
    const wk = week.hasTrades
      ? `<span class="${cls(week.totalSol)}">${signed(week.totalSol)}</span>`
      : '<span class="cal-week-empty">0</span>';
    return cells + `<div class="cal-week">${wk}</div>`;
  }).join('');

  el.innerHTML = `
    <div class="card">
      <h3>P&amp;L calendar
        <span class="cal-nav">
          <button class="cal-nav-btn" data-cal="-1" ${atMin ? 'disabled' : ''} aria-label="Previous month">‹</button>
          <span class="cal-month">${monthName}</span>
          <button class="cal-nav-btn" data-cal="1" ${atMax ? 'disabled' : ''} aria-label="Next month">›</button>
        </span>
      </h3>
      ${summary}
      ${(state.journal || []).length === 0
        ? '<div class="cal-summary"><span class="dim">No paper trades yet — your daily results will fill in as you buy and sell.</span></div>'
        : ''}
      <div class="cal-grid">${header}${body}</div>
    </div>`;
}

function bindCalendar(el) {
  el.querySelectorAll('.cal-nav-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const cur = calendarView || { year: new Date().getFullYear(), month: new Date().getMonth() };
      const next = cur.month + Number(button.dataset.cal);
      calendarView = { year: cur.year + Math.floor(next / 12), month: ((next % 12) + 12) % 12 };
      renderSection('calendar');
    });
  });
}

/* ---------- journal ---------- */

function renderJournal(el) {
  const rows = (state.journal || []).map((t) => `
    <tr>
      <td><span class="${t.side === 'buy' ? 'side-buy' : 'side-sell'}">${t.side.toUpperCase()}</span></td>
      <td><strong>${esc(t.symbol)}</strong></td>
      <td class="dim">${esc(t.site)}</td>
      <td class="num">${fmt(t.qty, 4)}</td>
      <td class="num">${mcapLevel(t)}</td>
      <td class="num">${fmt(t.solGross, 4)}</td>
      <td class="num dim">${fmt(t.solGross - (t.solNet || 0), 4)}</td>
      <td class="num ${t.pnlSol === undefined ? 'dim' : t.pnlSol >= 0 ? 'green' : 'red'}" style="font-weight:750">
        ${t.pnlSol !== undefined ? (t.pnlSol >= 0 ? '+' : '') + fmt(t.pnlSol) : '—'}
      </td>
      <td class="dim"><span data-rel-ts="${Number(t.ts) || 0}" title="${esc(formatDateTime(t.ts))}">${timeAgo(t.ts)}</span></td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="card"><h3>All fills <span class="tag">${(state.journal || []).length}</span></h3>
      <div class="log">
        <table>
          <thead><tr><th>Side</th><th>Token</th><th>Site</th><th class="num">Qty</th><th class="num">Market cap</th><th class="num">Gross</th><th class="num">Fee</th><th class="num">P&L</th><th>When</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="9">${emptyState('No fills yet', 'Paper trades will be journaled here.')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}

/* ---------- rounds ---------- */

function renderRounds(el) {
  const rows = (state.rounds || []).map((r) => {
    const replay = RP.findReplay(replays, r.sessionId || '');
    const win = r.pnlSol >= 0;
    // D-04: three buttons in this row share the round id; the AI-review
    // button carries its own data-review-id so runReview can never grab (and
    // disable) the notes button instead.
    // D-05: replay.checkpoints is initialised [] and written nowhere, so a
    // count-based label always read "▶ 0 moments". Plain "▶ Replay" — the
    // replay view itself shows the real fill/frame timeline.
    return `
      <tr data-id="${esc(r.id)}">
        <td><strong>${esc(r.symbol)}</strong><br><span class="dim mono" style="font-size:10.5px">${esc(E.short(r.mint))}</span></td>
        <td class="dim">${esc(r.site)}</td>
        <td class="num">${(r.heldMs / 60000).toFixed(1)}m</td>
        <td class="num">${fmt(r.investedSol, 4)}</td>
        <td class="num">${fmt(r.returnedSol, 4)}</td>
        <td class="num ${win ? 'green' : 'red'}" style="font-weight:800">${win ? '+' : ''}${fmt(r.pnlSol)}</td>
        <td class="num ${win ? 'green' : 'red'}">${win ? '+' : ''}${r.pnlPct.toFixed(1)}%</td>
        <td class="num" style="font-size:11.5px"><span class="green">+${fmt(r.peakPnlSol)}</span> <span class="dim">/</span> <span class="red">${fmt(r.troughPnlSol)}</span></td>
        <td>${renderExitCell(r)}</td>
        <td>${renderThesisCell(r)}</td>
        <td>${renderNoteCell(r)}</td>
        <td>${r.aiReview ? '<span class="tag" style="color:var(--green);border-color:rgba(52,211,153,.3)">reviewed</span>' : '<button class="btn-sec review-btn" data-review-id="' + esc(r.id) + '">AI review</button>'}</td>
        <td>${replay ? `<button class="btn-sec replay-btn" data-session="${esc(replay.sessionId)}">▶ Replay</button>` : '<span class="dim">—</span>'}</td>
        <td><button class="btn-sec share-btn" data-id="${esc(r.id)}">Share</button></td>
        <td class="dim" style="font-size:11px">${esc(r.recordingFile || '—')}</td>
      </tr>`;
  }).join('');
  el.innerHTML = `
    <div class="card"><h3>Closed round trips <span class="tag">${(state.rounds || []).length}</span></h3>
      <div class="log"><table>
        <thead><tr><th>Token</th><th>Site</th><th class="num">Held</th><th class="num">In</th><th class="num">Out</th><th class="num">P&L SOL</th><th class="num">%</th><th class="num">Peak/Worst</th><th>Exit</th><th>Thesis</th><th>Notes</th><th>Review</th><th>Replay</th><th>Share</th><th>Recording</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="15">${emptyState('No closed round trips yet', 'Close a paper position to bank a round trip.')}</td></tr>`}</tbody>
      </table></div>
    </div>`;
  // Handlers are attached in rebindSection() after the element is live.
}


/**
 * Whether the exit respected the plan the thesis declared.
 *
 * A win on a broken plan is flagged as luck, because rewarding it teaches the
 * wrong lesson — which is the entire reason for journaling a thesis up front.
 */

/** How much of the available move the exit actually captured. */
function renderExitCell(round) {
  const q = E.exitQuality(round);
  if (!q) return '<span class="dim">—</span>';
  const label = {
    excellent: ['excellent', 'var(--green)', 'rgba(52,211,153,.3)'],
    good: ['good', 'var(--green)', 'rgba(52,211,153,.25)'],
    early: ['sold early', 'var(--amber)', 'rgba(255,157,69,.35)'],
    'round-tripped': ['round-tripped', 'var(--red)', 'rgba(255,95,86,.35)'],
    'no-run': ['no run', 'var(--dim)', 'var(--line)'],
    'never-worked': ['never worked', 'var(--dim)', 'var(--line)'],
  }[q.verdict] || ['—', 'var(--dim)', 'var(--line)'];

  const title = q.capturedPct === null
    ? 'The position never went green.'
    : `Captured ${q.capturedPct.toFixed(0)}% of the peak · left ${fmt(q.leftOnTableSol, 3)} SOL on the table`;
  return `<span class="tag" style="color:${label[1]};border-color:${label[2]}" title="${esc(title)}">${label[0]}</span>`;
}

function renderThesisCell(round) {
  const grade = E.gradeThesis(round);
  if (!grade) return '<span class="dim">—</span>';
  if (grade.luckyWin) {
    return `<span class="tag" style="color:var(--amber);border-color:rgba(255,157,69,.35)" title="${esc(grade.notes.join(' '))}">lucky</span>`;
  }
  if (grade.followedPlan === true) {
    return `<span class="tag" style="color:var(--green);border-color:rgba(52,211,153,.3)" title="${esc(grade.notes.join(' '))}">on plan</span>`;
  }
  if (grade.followedPlan === false) {
    return `<span class="tag" style="color:var(--red);border-color:rgba(255,95,86,.3)" title="${esc(grade.notes.join(' '))}">off plan</span>`;
  }
  return `<span class="tag" title="${esc(grade.notes.join(' '))}">logged</span>`;
}

/**
 * Post-close notes: the thesis is written BEFORE the outcome, but plenty of
 * lessons only exist AFTER it. Every closed round can carry a retrospective
 * note, editable any time, and the AI coach reads it too.
 */
function renderNoteCell(round) {
  const editBtn = `<button class="btn-sec note-btn" data-id="${esc(round.id)}">${round.note && round.note.text ? 'Edit' : 'Add note'}</button>`;
  if (round.note && round.note.text) {
    return `<span class="round-note" title="${esc(round.note.text)}">${esc(round.note.text)}</span> ${editBtn}`;
  }
  return editBtn;
}

function editRoundNote(button) {
  const roundId = button.dataset.id;
  const cell = button.closest('td');
  const round = (state.rounds || []).find((r) => r.id === roundId);
  if (!cell || !round) return;

  cell.textContent = '';
  const input = document.createElement('textarea');
  input.className = 'note-input';
  input.rows = 3;
  input.placeholder = 'What did this trade teach you?';
  input.value = (round.note && round.note.text) || '';

  const actions = document.createElement('div');
  actions.className = 'note-actions';
  const save = document.createElement('button');
  save.className = 'btn';
  save.textContent = 'Save note';
  const cancel = document.createElement('button');
  cancel.className = 'btn-sec';
  cancel.textContent = 'Cancel';
  actions.append(save, cancel);
  cell.append(input, actions);
  input.focus();

  cancel.addEventListener('click', () => renderSection('rounds'));
  save.addEventListener('click', async () => {
    const text = input.value.trim();
    try {
      // D-22: mutate-with-retry. A fill can land while the note is being
      // written; mutateState re-reads the FRESHEST state inside its retry
      // loop and re-applies the note on it, so saving a note can never
      // clobber a trade (and a concurrent seq bump triggers a re-apply
      // instead of a lost write).
      await mutateState((fresh) => {
        const target = (fresh.rounds || []).find((r) => r.id === roundId);
        if (!target) throw new Error('round no longer exists');
        if (text) target.note = { text, t: Date.now() };
        else delete target.note;
      });
    } catch (err) {
      // D-15/D-25: keep the editor (and the typed text) on screen instead of
      // silently dropping the note when storage is unreadable/unwritable.
      save.textContent = 'Save failed — retry';
      return;
    }
    lastFingerprint = dataFingerprint();
    renderSidebar();
    renderSection('rounds');
  });
}

async function runReview(roundId) {
  // D-04: the notes/share buttons and the row itself share this round id via
  // data-id — a bare [data-id=...] selector grabbed the NOTES button and
  // disabled/relabelled that instead. The review button has its own
  // data-review-id attribute, so this can only ever hit the review button.
  const b = document.querySelector(`button.review-btn[data-review-id="${roundId}"]`);
  // D-21: any failure must re-enable the button, restore its label, and show
  // the error — an unhandled rejection used to leave it (well, the notes
  // button, per D-04) stuck at "Analyzing…" forever.
  const fail = (err) => {
    if (!b) return;
    b.disabled = false;
    b.textContent = 'AI review';
    const cell = b.closest('td');
    if (cell) {
      let out = cell.querySelector('.review-error');
      if (!out) {
        out = document.createElement('div');
        out.className = 'review-error red';
        out.style.cssText = 'margin-top:4px;font-size:11px;max-width:200px;white-space:normal';
        cell.appendChild(out);
      }
      out.textContent = 'Review failed: ' + ((err && err.message) ? err.message : String(err));
    }
  };
  if (b) { b.disabled = true; b.textContent = 'Analyzing…'; }
  const round = (state.rounds || []).find((r) => r.id === roundId);
  if (!round) { fail(new Error('round not found')); return; }
  try {
    const trades = (state.journal || []).filter((t) => round.tradeIds.includes(t.id));
    const { pt_frames = [] } = (await store.get(['pt_frames'])) || {};
    const roundFrames = pt_frames.filter((frame) =>
      frame.sessionId ? frame.sessionId === round.sessionId :
        frame.mint === round.mint && frame.t >= round.openedAt && frame.t <= round.closedAt
    );
    const messages = buildCoachMessages(round, trades, roundFrames);
    const resp = await chrome.runtime.sendMessage({ type: 'pt_ai_chat', messages, maxTokens: 2000 });
    // The AI call takes seconds, and a fill can land in storage while it runs.
    // D-22: mutateState annotates the FRESHEST state inside its retry loop —
    // and retries on a concurrent seq bump — so saving the review can never
    // clobber a trade the user made mid-review.
    await mutateState((fresh) => {
      const target = (fresh.rounds || []).find((r) => r.id === roundId);
      if (!target) throw new Error('round no longer exists');
      target.aiReview = {
        t: Date.now(),
        text: resp?.reply || ('Error: ' + (resp?.error || 'unknown')),
        ok: !resp?.error,
      };
    });
  } catch (err) {
    fail(err);
    return;
  }
  lastFingerprint = dataFingerprint();
  renderSection('rounds');
}

function buildCoachMessages(round, trades, roundFrames) {
  const fillText = trades.sort((a, b) => a.ts - b.ts).map((t) =>
    `${new Date(t.ts).toISOString()} ${t.side.toUpperCase()} ${t.qty.toFixed(4)} ${t.symbol} @ ${t.priceNative} SOL (gross ${t.solGross.toFixed(3)} SOL${t.pnlSol !== undefined ? `, realized ${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)}` : ''})`
  ).join('\n');
  const frameText = roundFrames.length
    ? `\n\nPaperTrench captured ${roundFrames.length} timestamped chart frames during this round.`
    : '';
  // The pre-trade thesis is the strongest review material available: it states
  // the intent, so the coach can judge process rather than just outcome.
  const grade = E.gradeThesis(round);
  const thesisText = round.thesis
    ? `Stated thesis (written before the outcome was known): ${round.thesis.text || '(no note)'}\n` +
      `Setup tags: ${(round.thesis.tags || []).join(', ') || 'none'}` +
      (round.thesis.plan ? ` · plan: ${round.thesis.plan}` : '') +
      (round.thesis.targetPct ? ` · target +${round.thesis.targetPct}%` : '') +
      (round.thesis.stopPct ? ` · stop -${round.thesis.stopPct}%` : '') +
      (grade ? `\nPlan outcome: ${grade.notes.join(' ') || 'no explicit target or stop'}` : '')
    : '';
  return [
    {
      role: 'system',
      content: 'You are a no-BS Solana memecoin trading coach reviewing one paper-trade round trip. Be concrete, cite numbers, and name exactly one bad habit and one fix. If a pre-trade thesis is supplied, judge PROCESS against it: a profitable trade that broke its own plan is a process failure, and a losing trade that followed the plan is not. If a post-trade note is supplied, engage with it directly — confirm it, correct it, or sharpen it. Keep it under 350 words.',
    },
    {
      role: 'user',
      content:
        `Review this round trip:\n\n` +
        `Token: ${round.symbol} (${round.mint}) on ${round.site}\n` +
        `Held: ${(round.heldMs / 60000).toFixed(1)} minutes\n` +
        `Invested: ${round.investedSol.toFixed(4)} SOL, returned: ${round.returnedSol.toFixed(4)} SOL\n` +
        `P&L: ${round.pnlSol >= 0 ? '+' : ''}${round.pnlSol.toFixed(4)} SOL (${round.pnlPct.toFixed(1)}%)\n` +
        `Peak unrealized P&L: +${round.peakPnlSol.toFixed(4)} SOL, worst: ${round.troughPnlSol.toFixed(4)} SOL\n\n` +
        `Fills:\n${fillText}${frameText}\n\n` +
        (thesisText ? `${thesisText}\n\n` : '') +
        (round.note && round.note.text ? `Post-trade note (written after the outcome): ${round.note.text}\n\n` : '') +
        `Output: Verdict, what was done right, what was done wrong, one bad habit, and one actionable fix for next time.`,
    },
  ];
}

/* ---------- session replay ---------- */

function openReplay(sessionId) {
  selectedReplayId = sessionId;
  replayCursor = 0;
  currentSection = 'replay';
  document.querySelectorAll('nav button').forEach((button) => {
    button.classList.toggle('active', button.dataset.section === 'replay');
  });
  SECTIONS.forEach((id) => document.getElementById(id).classList.toggle('hidden', id !== 'replay'));
  renderSection('replay');
}

/**
 * Pull stored recordings into memory, keyed by round.
 *
 * Only rounds that actually have a video are loaded, and IndexedDB failures
 * degrade to the frame-based view rather than breaking the dashboard.
 */
async function loadRecordings() {
  try {
    // list() returns metadata only. Video blobs are pulled lazily and cached,
    // so a refresh does not drag tens of megabytes out of IndexedDB each time.
    const stored = await RC.list();
    const next = {};
    for (const item of stored) {
      const cached = recordings[item.id];
      if (cached && cached.blob) { next[item.id] = cached; continue; }
      const full = await RC.get(item.id);
      if (full && full.blob) next[item.id] = full;
    }
    // Release object URLs for recordings that no longer exist.
    for (const id of Object.keys(recordingUrls)) {
      if (next[id]) continue;
      try { URL.revokeObjectURL(recordingUrls[id]); } catch (_) {}
      delete recordingUrls[id];
    }
    recordings = next;
  } catch (_) {
    recordings = {};
  }
}

/**
 * Playback control.
 *
 * When a recording exists the VIDEO is the clock: it plays at its natural rate
 * and a requestAnimationFrame loop maps its currentTime onto the timeline, so
 * the tape follows playback smoothly. Only when there is no video do we fall
 * back to stepping through events on a timer.
 */
function replayPlaying() {
  if (replayShell && replayShell.video) return !replayShell.video.paused && !replayShell.video.ended;
  return Boolean(replayTimer);
}

function stopReplayPlayback() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  if (replayShell && replayShell.video && !replayShell.video.paused) {
    try { replayShell.video.pause(); } catch (_) {}
  }
}

function toggleReplayPlayback() {
  const shell = replayShell;
  if (!shell) return;

  if (shell.video) {
    if (shell.video.paused || shell.video.ended) {
      if (shell.video.ended) { try { shell.video.currentTime = 0; } catch (_) {} }
      shell.video.play().catch(() => {});
    } else {
      shell.video.pause();
    }
    updateReplayView(buildReplayView(currentReplay()));
    return;
  }

  if (replayTimer) {
    stopReplayPlayback();
    renderReplay(shell.el);
    return;
  }
  const view = buildReplayView(currentReplay());
  if (replayCursor >= view.events.length - 1) replayCursor = 0;
  replayTimer = setInterval(() => {
    // D-26: replays can empty mid-playback (wallet reset from the popup).
    // Without this guard the tick called buildReplayView(undefined) and threw
    // a TypeError every 1.1 s forever.
    const replay = currentReplay();
    if (!replay) { stopReplayPlayback(); return; }
    const current = buildReplayView(replay);
    if (replayCursor >= current.events.length - 1) stopReplayPlayback();
    else replayCursor += 1;
    updateReplayView(buildReplayView(replay));
  }, 1100);
  updateReplayView(buildReplayView(currentReplay()));
}

function currentReplay() {
  return RP.findReplay(replays, selectedReplayId || '') || replays[0];
}

/**
 * Move the timeline. When a video is present the seek is expressed as a video
 * seek, keeping a single source of truth for "where are we".
 */
function seekReplay(index, opts) {
  const shell = replayShell;
  if (!shell) return;
  const view = buildReplayView(currentReplay());
  const next = Math.max(0, Math.min(index, view.events.length - 1));
  const event = view.events[next];

  if (shell.video && event && (opts && opts.fromUser)) {
    const offset = RC.offsetForMoment(view.recording, event.at);
    if (offset !== null) {
      try { shell.video.currentTime = offset; } catch (_) {}
      // The rAF loop will pick the cursor up from the video's own time.
      replayCursor = next;
      updateReplayView(buildReplayView(currentReplay()));
      return;
    }
  }

  if (opts && opts.fromUser && !shell.video) stopReplayPlayback();
  replayCursor = next;
  updateReplayView(buildReplayView(currentReplay()));
}

/** Attach the video and start following its playback clock. */
function attachReplayVideo(view) {
  const shell = replayShell;
  const video = shell.media.querySelector('[data-r="video"]');
  if (!video) return;
  shell.video = video;

  const startOffset = RC.offsetForMoment(view.recording, view.at);
  const seekInitial = () => {
    if (startOffset === null) return;
    try { video.currentTime = startOffset; } catch (_) {}
  };
  if (video.readyState >= 1) seekInitial();
  else video.addEventListener('loadedmetadata', seekInitial, { once: true });

  const onPlayState = () => updateReplayView(buildReplayView(currentReplay()));
  video.addEventListener('play', () => { startVideoSync(); onPlayState(); });
  video.addEventListener('pause', () => { stopVideoSync(); onPlayState(); });
  video.addEventListener('ended', () => { stopVideoSync(); onPlayState(); });
  // A manual scrub of the video's own control bar must move the tape too.
  video.addEventListener('seeked', () => syncCursorToVideo(true));
}

/**
 * Follow the video's clock with requestAnimationFrame.
 *
 * rAF is frame-aligned, so the highlight advances in step with the picture
 * instead of on an arbitrary interval that beats against the frame rate.
 */
function startVideoSync() {
  stopVideoSync();
  const step = () => {
    if (!replayShell || !replayShell.video) return;
    syncCursorToVideo(false);
    replayRaf = requestAnimationFrame(step);
  };
  replayRaf = requestAnimationFrame(step);
}

function stopVideoSync() {
  if (replayRaf) { cancelAnimationFrame(replayRaf); replayRaf = null; }
}

/** Map the video's current time onto the active event, cheaply. */
function syncCursorToVideo(force) {
  const shell = replayShell;
  if (!shell || !shell.video) return;
  const view = buildReplayView(currentReplay());
  if (!view.recording) return;

  const at = RC.momentForOffset(view.recording, shell.video.currentTime);
  if (at === null) return;

  const label = shell.media.querySelector('[data-r="videoAt"]');
  if (label) {
    label.textContent = `Synced to +${formatDuration(shell.video.currentTime * 1000)} · ${formatDateTime(at)}`;
  }

  const index = RC.activeEventIndex(view.events, at);
  const next = index < 0 ? 0 : index;
  // Only touch the DOM when the active event actually changes.
  if (!force && next === replayCursor) return;
  replayCursor = next;
  updateReplayView(buildReplayView(currentReplay()));
}

function detachReplayVideo() {
  stopVideoSync();
  if (replayShell) replayShell.video = null;
}

/** Free object URLs and timers when the replay shell goes away. */
function releaseReplayShell() {
  stopVideoSync();
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  replayShell = null;
}

function replayRound(replay) {
  return (state.rounds || []).find((round) =>
    (replay.roundId && round.id === replay.roundId) ||
    (replay.sessionId && round.sessionId === replay.sessionId)
  ) || null;
}

function replayTrades(replay) {
  const round = replayRound(replay);
  const ids = new Set(round?.tradeIds || []);
  return (state.journal || []).filter((trade) =>
    trade.sessionId ? trade.sessionId === replay.sessionId :
      ids.has(trade.id) || (trade.mint === replay.mint && trade.ts >= replay.openedAt && trade.ts <= (replay.closedAt || Date.now()))
  );
}

function replayFrames(replay) {
  return frames.filter((frame) =>
    frame.sessionId ? frame.sessionId === replay.sessionId :
      frame.mint === replay.mint && frame.t >= replay.openedAt && frame.t <= (replay.closedAt || Date.now())
  );
}

/**
 * Render the replay view.
 *
 * The shell is built ONCE per session and thereafter only the parts that
 * actually change are updated. Rebuilding innerHTML on every cursor move —
 * which is what the previous version did — destroyed and recreated the <video>
 * element each time, so the picture flashed, playback restarted, and scrubbing
 * felt like it was fighting the player.
 */
function renderReplay(el) {
  if (!replays.length) {
    // D-26: replays can empty while frame playback runs (wallet reset from
    // the popup). Nulling the shell alone left replayTimer firing
    // buildReplayView(undefined) every 1.1 s — stop playback and release the
    // shell (which clears the timer and the video-sync rAF) first.
    stopReplayPlayback();
    releaseReplayShell();
    el.innerHTML = `
      <div class="card">
        <h3>Session replay</h3>
        <div class="empty" style="padding:52px 24px">
          <div style="font-size:34px;line-height:1;margin-bottom:6px">⏱</div>
          <strong style="font-size:15px">No timestamped replay captured yet</strong>
          <span style="font-size:12.5px;max-width:440px;line-height:1.6">
            Your next paper position records every fill and chart frame — and the screen
            recording if you enable it — then plays the whole trade back as one timeline.
          </span>
          <button class="btn" id="replay-settings" style="margin-top:10px">Open settings</button>
        </div>
      </div>`;
    document.getElementById('replay-settings').addEventListener('click', () => {
      document.querySelector('nav button[data-section="settings"]').click();
    });
    return;
  }

  let replay = RP.findReplay(replays, selectedReplayId || '');
  if (!replay) replay = replays[0];
  selectedReplayId = replay.sessionId;

  const view = buildReplayView(replay);
  // Reuse the existing DOM whenever we are still on the same session, so the
  // video element survives and keeps playing.
  if (!replayShell || replayShell.root.parentNode !== el || replayShell.sessionId !== replay.sessionId) {
    mountReplayShell(el, replay, view);
  }
  updateReplayView(view);
}

/** Everything the replay needs for the current cursor position. */
function buildReplayView(replay) {
  // D-26: a missing replay (list emptied mid-playback) degrades to an empty
  // view instead of a TypeError — callers stop or render the empty state.
  if (!replay) {
    return { replay: null, round: null, events: [], event: null, at: 0, relatedFrame: null, recording: null };
  }
  const round = replayRound(replay);
  const trades = replayTrades(replay);
  const frames = replayFrames(replay);
  const events = RP.buildReplayEvents(replay, trades, frames);
  replayCursor = Math.max(0, Math.min(replayCursor, Math.max(0, events.length - 1)));
  const event = events[replayCursor] || null;
  const at = event ? Number(event.at) : Number(replay.openedAt);
  const framesSoFar = frames
    .filter((frame) => Number(frame.t) <= at)
    .sort((a, b) => Number(b.t) - Number(a.t));
  return {
    replay,
    round,
    events,
    event,
    at,
    // Never leak a future chart into an earlier replay moment.
    relatedFrame: event?.frame || framesSoFar[0] || null,
    recording: replayRecording(replay),
  };
}

/** Build the replay DOM once for a session and wire its permanent handlers. */
function mountReplayShell(el, replay, view) {
  releaseReplayShell();

  const heroPnl = view.round?.pnlSol ?? replay.result?.pnlSol;
  const hasHeroResult = heroPnl !== null && heroPnl !== undefined;

  el.innerHTML = `
    <div class="replay-layout">
      <div class="card replay-list-card">
        <h3>Timestamped sessions</h3>
        <div class="replay-session-list" data-r="sessions"></div>
      </div>
      <div class="replay-main">
        <div class="card replay-hero">
          <div>
            <h2>${esc(replay.symbol || E.short(replay.mint))} moment replay</h2>
            <div class="dim">${formatDateTime(replay.openedAt)} → ${replay.closedAt ? formatDateTime(replay.closedAt) : 'open now'} · ${esc(replay.mint)}</div>
          </div>
          <div class="replay-result ${hasHeroResult ? (Number(heroPnl) >= 0 ? 'green' : 'red') : 'dim'}">
            ${hasHeroResult ? `${Number(heroPnl) >= 0 ? '+' : ''}${fmt(heroPnl, 4)} SOL` : esc(replay.status.toUpperCase())}
          </div>
        </div>
        <div data-r="media"></div>
        <div class="card replay-controls">
          <div class="replay-now">
            <strong data-r="nowLabel"></strong>
            <span data-r="nowTime"></span>
          </div>
          <input data-r="scrubber" type="range" min="0" max="0" value="0" aria-label="Replay position">
          <div class="replay-actions">
            <button class="btn-sec" data-r="prev">←</button>
            <button class="btn" data-r="play" style="min-width:104px">▶ Play</button>
            <button class="btn-sec" data-r="next">→</button>
            <span class="dim" data-r="counter"></span>
          </div>
          <div class="replay-ticks" data-r="ticks"></div>
        </div>
        <div class="card"><h3>Session tape</h3><div class="tape" data-r="tape"></div></div>
        <div data-r="errors"></div>
      </div>
    </div>`;

  const q = (name) => el.querySelector(`[data-r="${name}"]`);
  replayShell = {
    root: el.firstElementChild,
    sessionId: replay.sessionId,
    el,
    sessions: q('sessions'),
    media: q('media'),
    nowLabel: q('nowLabel'),
    nowTime: q('nowTime'),
    scrubber: q('scrubber'),
    prev: q('prev'),
    play: q('play'),
    next: q('next'),
    counter: q('counter'),
    ticks: q('ticks'),
    tape: q('tape'),
    errors: q('errors'),
    tapeRows: [],
    tickEls: [],
    video: null,
    mediaKey: '',
    lastCursor: -1,
  };

  // Session list: static for the lifetime of the shell.
  replayShell.sessions.innerHTML = replays.map((item) => {
    const itemRound = replayRound(item);
    const result = itemRound || item.result || {};
    const hasResult = result.pnlSol !== null && result.pnlSol !== undefined;
    return `
      <button class="replay-session ${item.sessionId === replay.sessionId ? 'active' : ''}" data-session="${esc(item.sessionId)}">
        <span><strong>${esc(item.symbol || E.short(item.mint))}</strong><small>${formatDateTime(item.openedAt)} · ${esc(item.site || 'unknown')}</small></span>
        <span class="${hasResult ? (Number(result.pnlSol) >= 0 ? 'green' : 'red') : 'dim'}">${hasResult ? `${Number(result.pnlSol) >= 0 ? '+' : ''}${fmt(result.pnlSol, 3)} SOL` : (item.status === 'open' ? 'OPEN' : '—')}</span>
      </button>`;
  }).join('');

  replayShell.sessions.querySelectorAll('.replay-session').forEach((button) => {
    button.addEventListener('click', () => {
      stopReplayPlayback();
      selectedReplayId = button.dataset.session;
      replayCursor = 0;
      renderReplay(el);
    });
  });

  replayShell.scrubber.addEventListener('input', () => {
    seekReplay(Number(replayShell.scrubber.value), { fromUser: true });
  });
  replayShell.prev.addEventListener('click', () => seekReplay(replayCursor - 1, { fromUser: true }));
  replayShell.next.addEventListener('click', () => seekReplay(replayCursor + 1, { fromUser: true }));
  replayShell.play.addEventListener('click', toggleReplayPlayback);
}

/** Update only what changed for the current cursor. */
function updateReplayView(view) {
  if (!replayShell) return;
  const { events, event, replay } = view;
  const shell = replayShell;

  syncReplayMedia(view);

  shell.nowLabel.innerHTML = `${eventIcon(event)} ${esc(event ? eventLabel(event) : 'No captured events')}`;
  shell.nowTime.textContent = event
    ? `+${formatDuration(Math.max(0, event.at - replay.openedAt))} · ${formatDateTime(event.at)}`
    : '';
  shell.counter.textContent = `${events.length ? replayCursor + 1 : 0} / ${events.length}`;

  const max = Math.max(0, events.length - 1);
  if (Number(shell.scrubber.max) !== max) shell.scrubber.max = String(max);
  shell.scrubber.disabled = events.length < 2;
  if (Number(shell.scrubber.value) !== replayCursor) shell.scrubber.value = String(replayCursor);
  shell.prev.disabled = replayCursor <= 0;
  shell.next.disabled = replayCursor >= events.length - 1;
  shell.play.disabled = events.length < 2;
  shell.play.textContent = replayPlaying() ? '❚❚ Pause' : '▶ Play';

  syncTicks(events);
  syncTape(view);

  // Heavier context panels only rebuild when the moment actually changes.
  if (shell.lastCursor !== replayCursor) {
    shell.errors.innerHTML = (replay.errors || []).length
      ? `<div class="card replay-errors"><h3>Capture warnings</h3>${replay.errors.map((error) => `<p><strong>${formatDateTime(error.at)}</strong> ${esc(error.message)}</p>`).join('')}</div>`
      : '';
    shell.lastCursor = replayCursor;
  }
}

/** Timeline ticks are created once, then only their active class changes. */
function syncTicks(events) {
  const shell = replayShell;
  if (shell.tickEls.length !== events.length) {
    shell.ticks.innerHTML = events.map((item, index) =>
      `<button class="replay-tick ${esc(item.source)}" data-index="${index}" title="${esc(eventLabel(item))}" aria-label="${esc(eventLabel(item))}"></button>`
    ).join('');
    shell.tickEls = [...shell.ticks.children];
    shell.tickEls.forEach((node, index) => {
      node.addEventListener('click', () => seekReplay(index, { fromUser: true }));
    });
  }
  shell.tickEls.forEach((node, index) => {
    node.classList.toggle('active', index === replayCursor);
  });
}

/** Session tape rows are created once; only the highlight moves. */
function syncTape(view) {
  const shell = replayShell;
  const { events, replay } = view;

  if (shell.tapeRows.length !== events.length) {
    shell.tape.innerHTML = events.map((item, index) => {
      const offset = Math.max(0, item.at - replay.openedAt);
      const detail = item.trade
        ? `${fmt(item.trade.solGross, 3)} SOL @ ${fillLevel(item.trade)}${
            item.trade.pnlSol !== undefined && item.trade.pnlSol !== null
              ? ` · <span class="${item.trade.pnlSol >= 0 ? 'green' : 'red'}">${item.trade.pnlSol >= 0 ? '+' : ''}${fmt(item.trade.pnlSol, 3)} SOL</span>` : ''}`
        : item.frame ? 'chart frame captured'
        : 'context snapshot';
      return `
        <button class="tape-row" data-index="${index}">
          <span class="tape-time mono">+${formatDuration(offset)}</span>
          <span class="tape-icon">${eventIcon(item)}</span>
          <span class="tape-label">${esc(eventLabel(item))}</span>
          <span class="tape-detail dim mono">${detail}</span>
        </button>`;
    }).join('');
    shell.tapeRows = [...shell.tape.children];
    shell.tapeRows.forEach((node, index) => {
      node.addEventListener('click', () => seekReplay(index, { fromUser: true }));
    });
  }

  shell.tapeRows.forEach((node, index) => {
    const active = index === replayCursor;
    if (node.classList.contains('active') !== active) {
      node.classList.toggle('active', active);
      // Keep the current row in view without yanking the whole page.
      if (active) node.scrollIntoView({ block: 'nearest' });
    }
  });
}

/**
 * Mount the video (or frame) once per media source.
 *
 * The <video> element is only replaced when the underlying source changes, so
 * moving through the timeline never interrupts playback.
 */
function syncReplayMedia(view) {
  const shell = replayShell;
  const { recording, relatedFrame, replay } = view;
  const useVideo = Boolean(recording) && !(preferFrameOverVideo && relatedFrame);
  const key = useVideo ? `video:${recording.id}` : relatedFrame ? `frame:${relatedFrame.t}` : 'none';

  if (shell.mediaKey !== key) {
    detachReplayVideo();
    shell.mediaKey = key;

    if (useVideo) {
      shell.media.innerHTML = `
        <div class="card replay-video">
          <h3>Screen recording
            ${relatedFrame ? '<span class="replay-source-tabs" style="margin-left:auto"><button class="active" data-media="video">Video</button><button data-media="frame">Frame</button></span>' : ''}
          </h3>
          <video data-r="video" src="${esc(recordingUrl(recording))}" controls preload="metadata" playsinline></video>
          <div class="replay-video-meta">
            <span data-r="videoAt"></span>
            <span>${esc(recording.file || '')} · ${(Number(recording.size) / 1048576).toFixed(1)} MB</span>
          </div>
        </div>`;
      attachReplayVideo(view);
    } else if (relatedFrame) {
      shell.media.innerHTML = `
        <div class="card replay-frame">
          <h3>Chart at this moment${recording ? '<span class="replay-source-tabs" style="margin-left:auto"><button data-media="video">Video</button><button class="active" data-media="frame">Frame</button></span>' : ''}</h3>
          <img src="${relatedFrame.dataUrl}" alt="PaperTrench chart frame at ${formatDateTime(relatedFrame.t)}">
          <div class="dim">${formatDateTime(relatedFrame.t)} · ${esc(relatedFrame.kind || 'frame')}</div>
        </div>`;
    } else {
      shell.media.innerHTML = '';
    }

    shell.media.querySelectorAll('.replay-source-tabs button').forEach((button) => {
      button.addEventListener('click', () => {
        preferFrameOverVideo = button.dataset.media === 'frame';
        renderReplay(shell.el);
      });
    });
  } else if (!useVideo && relatedFrame) {
    // Same frame source, nothing to do.
  }

  const label = shell.media.querySelector('[data-r="videoAt"]');
  if (label && shell.video) {
    const offset = RC.offsetForMoment(recording, view.at);
    label.textContent = offset === null
      ? 'This moment falls outside the recorded window'
      : `Synced to +${formatDuration(offset * 1000)} · ${formatDateTime(view.at)}`;
  }
  void replay;
}

/**
 * Show what the trade actually looked like at the selected moment.
 *
 * A screen recording is far richer than a still, so when one exists for this
 * round it wins and is seeked to the moment being replayed. Frames remain the
 * fallback for rounds recorded without video.
 */
function renderMomentMedia(replay, event, relatedFrame) {
  const recording = replayRecording(replay);
  const at = event ? Number(event.at) : Number(replay.openedAt);

  if (recording && !(preferFrameOverVideo && relatedFrame)) {
    const offset = RC.offsetForMoment(recording, at);
    const inRange = offset !== null;
    return `
      <div class="card replay-video">
        <h3>
          Screen recording at this moment
          ${relatedFrame ? '<span class="replay-source-tabs" style="margin-left:auto"><button class="active" data-media="video">Video</button><button data-media="frame">Frame</button></span>' : ''}
        </h3>
        <video id="replay-video" src="${esc(recordingUrl(recording))}" controls preload="metadata"
               data-offset="${inRange ? offset.toFixed(2) : ''}"></video>
        <div class="replay-video-meta">
          <span>${inRange
            ? `Seeked to +${formatDuration(offset * 1000)} · ${formatDateTime(at)}`
            : 'This moment falls outside the recorded window'}</span>
          <span>${esc(recording.file || '')} · ${(Number(recording.size) / 1048576).toFixed(1)} MB</span>
        </div>
      </div>`;
  }

  if (!relatedFrame) return '';
  return `
    <div class="card replay-frame">
      <h3>Chart at this moment</h3>
      <img src="${relatedFrame.dataUrl}" alt="PaperTrench chart frame at ${formatDateTime(relatedFrame.t)}">
      <div class="dim">${formatDateTime(relatedFrame.t)} · ${esc(relatedFrame.kind || 'frame')}</div>
    </div>`;
}

/** The stored recording for a replay's round, if one was captured. */
function replayRecording(replay) {
  const round = replayRound(replay);
  const id = (round && round.id) || replay.roundId;
  if (!id) return null;
  return recordings[id] || null;
}

/** Object URLs are created once per recording and revoked on reload. */
function recordingUrl(recording) {
  if (!recording || !recording.blob) return '';
  if (!recordingUrls[recording.id]) {
    recordingUrls[recording.id] = URL.createObjectURL(recording.blob);
  }
  return recordingUrls[recording.id];
}

/**
 * A readable transcript of the session: every fill and checkpoint in order,
 * with the current moment highlighted. This is the "what actually happened"
 * companion to the scrubber — scannable without dragging anything.
 */
function renderReplayTape(events, cursor, replay) {
  if (!events.length) return '';
  const rows = events.map((event, index) => {
    const active = index === cursor;
    const offset = Math.max(0, event.at - replay.openedAt);
    const detail = event.trade
      ? `${fmt(event.trade.solGross, 3)} SOL @ ${fillLevel(event.trade)}${
          event.trade.pnlSol !== undefined && event.trade.pnlSol !== null
            ? ` · <span class="${event.trade.pnlSol >= 0 ? 'green' : 'red'}">${event.trade.pnlSol >= 0 ? '+' : ''}${fmt(event.trade.pnlSol, 3)} SOL</span>` : ''}`
      : event.frame ? 'chart frame captured'
      : 'context snapshot';
    return `
      <button class="tape-row${active ? ' active' : ''}" data-index="${index}">
        <span class="tape-time mono">+${formatDuration(offset)}</span>
        <span class="tape-icon">${eventIcon(event)}</span>
        <span class="tape-label">${esc(eventLabel(event))}</span>
        <span class="tape-detail dim mono">${detail}</span>
      </button>`;
  }).join('');
  return `<div class="card"><h3>Session tape</h3><div class="tape">${rows}</div></div>`;
}

/** A glyph per event type so the timeline reads at a glance. */
function eventIcon(event) {
  if (!event) return '';
  if (event.trade) return event.trade.side === 'buy'
    ? '<span class="green" style="font-size:12px">▲</span>'
    : '<span class="red" style="font-size:12px">▼</span>';
  if (event.frame) return '<span class="dim" style="font-size:12px">▣</span>';
  return '<span class="amber" style="font-size:12px">◆</span>';
}

function eventLabel(event) {
  if (!event) return 'Moment';
  if (event.source === 'papertrench' && event.trade) {
    return `${event.trade.side === 'buy' ? 'Paper buy' : 'Paper sell'} · ${fmt(event.trade.solGross, 3)} SOL @ ${fillLevel(event.trade)}`;
  }
  if (event.frame) return `Chart frame · ${event.frame.kind || 'interval'}`;
  return `Moment · ${event.kind}`;
}



/* ---------- shareable P&L card ---------- */

let cardMedia = null;      // the user's chosen background image/GIF
let cardModelCurrent = null;

/**
 * Open the share composer for one closed round.
 *
 * The card is drawn from the round the engine actually recorded, so the numbers
 * on a shared image are the same ones the journal holds — there is no separate
 * "display" figure that could drift from the real result.
 */
function openShareCard(roundId) {
  const round = (state.rounds || []).find((r) => r.id === roundId);
  if (!round) return;

  const trades = (state.journal || []).filter((t) => (round.tradeIds || []).includes(t.id));
  const buys = trades.filter((t) => t.side === 'buy');
  const sells = trades.filter((t) => t.side === 'sell');
  const weighted = (list, field) => {
    const qty = list.reduce((sum, t) => sum + (Number(t.qty) || 0), 0);
    if (!(qty > 0)) return null;
    const total = list.reduce(
      (sum, t) => sum + (Number(t.qty) || 0) * (Number(t[field]) || 0), 0
    );
    return total > 0 ? total / qty : null;
  };

  cardModelCurrent = PC.cardModel({
    ...round,
    entryPrice: weighted(buys, 'priceNative'),
    exitPrice: weighted(sells, 'priceNative'),
    // Quantity-weighted market cap at entry and exit — the figures the trade
    // actually gets described by when the card is shared.
    entryMcap: weighted(buys, 'mcap'),
    exitMcap: weighted(sells, 'mcap'),
  }, { handle: (settings.leaderboardIdentity || {}).handle || '' });

  if (!cardModelCurrent) return;
  document.getElementById('card-modal').classList.add('open');
  paintShareCard();
}

function paintShareCard() {
  const canvas = document.getElementById('card-canvas');
  if (!canvas || !cardModelCurrent) return;
  PC.drawCard(canvas.getContext('2d'), cardModelCurrent, cardMedia);
}

function closeShareCard() {
  document.getElementById('card-modal').classList.remove('open');
}

/** Wire the composer once, at startup — the modal lives outside the sections. */
function bindShareCard() {
  const modal = document.getElementById('card-modal');
  if (!modal) return;
  const drop = document.getElementById('card-drop');
  const file = document.getElementById('card-file');

  const loadFile = (chosen) => {
    if (!chosen) return;
    const url = URL.createObjectURL(chosen);
    const img = new Image();
    img.onload = () => { cardMedia = img; paintShareCard(); };
    // A broken/unsupported file must not wipe the card.
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  file.addEventListener('change', () => loadFile(file.files && file.files[0]));
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('hot'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('hot');
    loadFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
  });

  document.getElementById('card-clear').addEventListener('click', () => {
    cardMedia = null;
    paintShareCard();
  });
  document.getElementById('card-close').addEventListener('click', closeShareCard);
  modal.addEventListener('click', (event) => { if (event.target === modal) closeShareCard(); });

  document.getElementById('card-download').addEventListener('click', () => {
    const canvas = document.getElementById('card-canvas');
    if (!canvas || !cardModelCurrent) return;
    const link = document.createElement('a');
    link.download = `papertrench-${cardModelCurrent.symbol}-${cardModelCurrent.multipleText}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  });
}

/* ---------- leaderboard ---------- */

/**
 * Leaderboard.
 *
 * Paper-trading results are trivially forgeable, so this screen is built around
 * evidence rather than self-reported numbers. Every fill is committed to a
 * hash chain at the moment it happens; the panel re-derives the result from
 * that chain and shows the user exactly what a verifier would compute. If the
 * two disagree, stored state has been altered.
 */
/**
 * D-18: the cheap fingerprint chain verification is memoized by. Length plus
 * head hash pins the chain contents (each link commits to its predecessor),
 * and the claim inputs are included because claimMatchesChain depends on
 * them. SHA-256 over the whole chain only re-runs when this key changes.
 */
function lbVerifyKey(chain, stats) {
  const head = chain.length ? String(chain[chain.length - 1].hash || '') : '';
  return [
    chain.length,
    head,
    Number(stats.realizedPnlSol) || 0,
    Number(settings.balanceStartSol) || 0,
  ].join('|');
}

/**
 * The verify panel's markup for the CURRENT cache state, rendered
 * synchronously into the staged section. When the memoized result matches
 * the live chain the resolved verdict is painted directly — no "Checking…"
 * placeholder ever flickers back (D-18) — and a mismatch reads as one
 * coherent sentence instead of the absurd "0 problems found · derived P&L
 * differs by X SOL" (D-03).
 */
function lbVerifyView(chain, stats) {
  if (!chain.length) {
    return {
      cls: 'lb-verify',
      html: '<div class="lb-badge">·</div><div><div class="t">No trades committed yet</div><div class="s">Your first paper fill will start the chain.</div></div>',
      derivedHtml: '<span class="dim">—</span>',
    };
  }
  const cached = lbVerifyCache && lbVerifyCache.key === lbVerifyKey(chain, stats)
    ? lbVerifyCache : null;
  if (!cached) {
    return {
      cls: 'lb-verify',
      html: '<div class="lb-badge">…</div><div><div class="t">Checking your trade chain…</div><div class="s">Re-deriving your result from committed fills.</div></div>',
      derivedHtml: '<span class="dim">…</span>',
    };
  }
  const ok = cached.valid && cached.ok;
  const diffText = `${fmt(cached.diff, 4)} SOL`;
  let detail;
  if (ok) {
    detail = `${chain.length} fills verified · displayed P&L matches the committed history`;
  } else if (!cached.valid && !cached.ok) {
    detail = `${cached.problems} problem${cached.problems === 1 ? '' : 's'} found in the chain, and the P&L it derives differs from the displayed figure by ${diffText}`;
  } else if (!cached.valid) {
    detail = `${cached.problems} problem${cached.problems === 1 ? '' : 's'} found in the chain`;
  } else {
    detail = `every hash verifies, but the displayed realized P&L differs from the chain-derived result by ${diffText}`;
  }
  return {
    cls: 'lb-verify ' + (ok ? 'ok' : 'bad'),
    html: `<div class="lb-badge">${ok ? '✓' : '!'}</div><div><div class="t">${ok ? 'Chain intact' : 'Chain does not match local state'}</div><div class="s">${detail}</div></div>`,
    derivedHtml: `<span class="${cached.derivedPnlSol >= 0 ? 'green' : 'red'}" style="font-weight:750">${cached.derivedPnlSol >= 0 ? '+' : ''}${fmt(cached.derivedPnlSol, 3)} SOL</span>`,
  };
}

function renderLeaderboard(el) {
  const chain = Array.isArray(state.attestChain) ? state.attestChain : [];
  const stats = E.sessionStats(state, settings);
  const identity = settings.leaderboardIdentity || null;
  // Absolute P&L flatters big bankrolls, so every figure is shown alongside
  // the return ON the declared starting balance — the comparable number.
  const roiPct = settings.balanceStartSol > 0
    ? (stats.realizedPnlSol / settings.balanceStartSol) * 100
    : 0;
  const verify = lbVerifyView(chain, stats);

  el.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h3>Verified record</h3>
        <div id="lb-verify" class="${verify.cls}">${verify.html}</div>
        <div class="stat" style="margin-top:14px"><span>Committed fills</span><span style="font-weight:750">${chain.length}</span></div>
        <div class="stat"><span>Claimed realized P&amp;L</span><span class="${stats.realizedPnlSol >= 0 ? 'green' : 'red'}" style="font-weight:750">${stats.realizedPnlSol >= 0 ? '+' : ''}${fmt(stats.realizedPnlSol, 3)} SOL · ${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}% ROI</span></div>
        <div class="stat"><span>Declared starting bankroll</span><span style="font-weight:750">${fmt(settings.balanceStartSol, 2)} SOL</span></div>
        <div class="stat" id="lb-derived"><span>Derived from chain</span>${verify.derivedHtml}</div>
        <h4>Chain head</h4>
        <div class="lb-proof" id="lb-head">${chain.length
          ? esc(chain[chain.length - 1].hash)
          : '<span class="dim">Not started — your first paper fill anchors the chain.</span>'}</div>
      </div>

      <div class="card">
        <h3>Identity</h3>
        ${identity ? `
          <div class="stat"><span>Linked account</span><span style="font-weight:750">@${esc(identity.handle)}
            <span class="lb-x ${identity.verified ? 'verified' : ''}">${identity.verified ? 'verified' : 'unverified'}</span></span></div>
          <div class="stat"><span>Linked at</span><span class="dim">${formatDateTime(identity.linkedAt)}</span></div>
          <p class="dim" style="font-size:12px;line-height:1.55;margin:12px 0 0">
            Ranking is bound to this account, so competing under many identities costs
            a real, publicly visible X account each time.
          </p>
          <button class="btn-sec" id="lb-unlink" style="margin-top:12px">Unlink</button>
        ` : `
          <p class="dim" style="font-size:12.5px;line-height:1.6;margin-top:0">
            Link your X account to appear on the leaderboard. The handle is stored locally and
            submitted with your signed chain; a server verifies ownership before ranking you.
          </p>
          <div class="field">
            <label for="lb-handle">X handle</label>
            <input id="lb-handle" type="text" placeholder="yourhandle" autocomplete="off">
            <small>Without the @. Verification is completed by the leaderboard service.</small>
          </div>
          <button class="btn" id="lb-link">Link account</button>
        `}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Standings</h3>
      <div id="lb-standings">
        ${renderStandingsPlaceholder(identity, stats)}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>How ranking is kept honest</h3>
      <ul style="margin:0;padding-left:18px;color:var(--dim);font-size:12.5px;line-height:1.65">
        <li><strong>Ordering is provable.</strong> Each fill commits to the hash of the one before it, so a trade cannot be inserted, removed, or reordered afterwards.</li>
        <li><strong>Entries are pre-committed.</strong> A fill is hashed when it is made, before the outcome is known, so a winning entry cannot be backdated.</li>
        <li><strong>Prices are re-checkable.</strong> Every fill records mint, price and timestamp, so a verifier can re-fetch real price history and reject fills at prices that never existed.</li>
        <li><strong>Identity costs something.</strong> One ranked record per verified X account.</li>
        <li><strong>Bankroll travels with the record.</strong> Your declared starting balance is part of the committed data, so results are compared by return on bankroll — not by absolute SOL, which a bigger deposit would inflate for free.</li>
        <li><strong>Stated plainly:</strong> this is evidence, not proof. Anyone can run modified code locally, so final standings must be recomputed server-side from the chain — never from the number this app displays.</li>
      </ul>
    </div>`;
}

function renderStandingsPlaceholder(identity, stats) {
  // No leaderboard service is configured, so no remote standings are invented.
  const roiPct = settings.balanceStartSol > 0
    ? (stats.realizedPnlSol / settings.balanceStartSol) * 100
    : 0;
  return `
    <div class="lb-rank me">
      <span class="pos">—</span>
      <span class="lb-handle">${identity ? '@' + esc(identity.handle) : 'You (unlinked)'}
        <small>${stats.rounds} round trips · ${stats.winRate === null ? '—' : stats.winRate.toFixed(0) + '% win rate'} · ${fmt(settings.balanceStartSol, 2)} SOL bankroll</small></span>
      <span class="${stats.realizedPnlSol >= 0 ? 'green' : 'red'}" style="font-weight:800">
        ${stats.realizedPnlSol >= 0 ? '+' : ''}${fmt(stats.realizedPnlSol, 3)} SOL
        <small style="font-weight:700;opacity:.8">(${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}% ROI)</small>
      </span>
    </div>
    <p class="dim" style="font-size:12px;line-height:1.6;margin:14px 0 0">
      No leaderboard server is configured yet, so no global standings are shown.
      Your chain is being committed locally in the meantime, so your record is
      already verifiable the moment ranking goes live — nothing needs to be
      reconstructed retroactively. ROI is shown next to absolute P&amp;L because
      the starting bankroll is a free choice: +10 SOL on a 10 SOL bankroll is a
      different result than +10 SOL on 1,000, and rankings must compare like with like.
    </p>`;
}

/** Verify the chain and show the user exactly what a server would compute. */
async function bindLeaderboard(el) {
  const link = el.querySelector('#lb-link');
  if (link) {
    link.addEventListener('click', async () => {
      const input = el.querySelector('#lb-handle');
      const handle = (input.value || '').trim().replace(/^@+/, '');
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        input.focus();
        return;
      }
      settings.leaderboardIdentity = { handle, verified: false, linkedAt: Date.now() };
      // A refused save (storage unreadable, D-15) must not reject unhandled.
      try { await saveSettings(); } catch (err) { console.error('PaperTrench: identity save failed', err); }
      renderSection('leaderboard');
    });
  }
  const unlink = el.querySelector('#lb-unlink');
  if (unlink) {
    unlink.addEventListener('click', async () => {
      delete settings.leaderboardIdentity;
      try { await saveSettings(); } catch (err) { console.error('PaperTrench: identity save failed', err); }
      renderSection('leaderboard');
    });
  }

  const chain = Array.isArray(state.attestChain) ? state.attestChain : [];
  if (!chain.length) return;
  const stats = E.sessionStats(state, settings);
  const key = lbVerifyKey(chain, stats);
  // D-18: memoized — the render already painted the resolved verdict for
  // this exact chain, so there is nothing to hash again.
  if (lbVerifyCache && lbVerifyCache.key === key) return;
  // A verify for this same chain is already in flight; it re-renders on
  // landing, so starting another would only burn CPU.
  if (lbVerifyInFlightKey === key) return;
  lbVerifyInFlightKey = key;
  try {
    const result = await AT.verifyChain(chain);
    const match = AT.claimMatchesChain(
      { realizedPnlSol: stats.realizedPnlSol }, chain, settings.balanceStartSol, 1e-6
    );
    lbVerifyCache = {
      key,
      valid: result.valid,
      problems: result.problems.length,
      ok: match.ok,
      diff: match.diff,
      derivedPnlSol: match.replayed.realizedPnlSol,
    };
  } finally {
    lbVerifyInFlightKey = null;
  }
  // D-18: this await can outlive the markup it was bound to (a staged refresh
  // replaced the section, or the user navigated away). Never write into a
  // possibly-detached node — re-render from the cache instead, which paints
  // the resolved verdict synchronously. The rebind's cache hit above stops
  // any recursion.
  if (currentSection === 'leaderboard') renderSection('leaderboard');
}

/* ---------- coach ---------- */

function renderCoach(el) {
  // D-17: #coach-session-out is filled FROM module state (sessionReview), so
  // the answer is part of every staged render — a background refresh can no
  // longer wipe it seconds after it lands.
  const reviewed = (state.rounds || []).filter((r) => r.aiReview);
  const reviewedCount = reviewed.length;
  const summary = buildSummaryForCoach();
  const wins = (state.rounds || []).filter((r) => r.pnlSol > 0).length;
  const losses = (state.rounds || []).filter((r) => r.pnlSol <= 0).length;

  el.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h3>Session-level AI review</h3>
        <p class="dim" style="margin-top:0;font-size:12.5px;line-height:1.55">
          Analyzes every closed round trip together to surface the habits that repeat
          across trades rather than one-off outcomes.
        </p>
        <button class="btn" id="coach-session">Run session review</button>
        <div id="coach-session-out" style="margin-top:14px" class="review${sessionReview && sessionReview.error ? ' error' : ''}">${sessionReview ? esc(sessionReview.text) : ''}</div>
      </div>
      <div class="card">
        <h3>Session stats</h3>
        <div class="stat"><span>Round trips</span><span style="font-weight:750">${state.rounds.length}</span></div>
        <div class="stat"><span>With AI review</span><span style="font-weight:750">${reviewedCount}</span></div>
        <div class="stat"><span>Avg hold time</span><span style="font-weight:750">${avgHold()}m</span></div>
        <div class="stat"><span>Wins / Losses</span><span style="font-weight:750"><span class="green">${wins}</span> / <span class="red">${losses}</span></span></div>
      </div>
    </div>
    ${renderDisciplinePanel()}
    ${renderThesisPanel()}
    ${reviewedCount ? `
      <div class="card" style="margin-top:16px">
        <h3>Latest reviews</h3>
        ${reviewed.slice(0, 3).map((r) => `
          <div style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,.05)">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:6px">
              <strong>${esc(r.symbol)}</strong>
              <span class="${r.pnlSol >= 0 ? 'green' : 'red'}" style="font-weight:750">${r.pnlSol >= 0 ? '+' : ''}${fmt(r.pnlSol, 3)} SOL</span>
            </div>
            <div class="review ${r.aiReview.ok ? '' : 'error'}" style="font-size:12.5px;color:var(--dim)">${esc(r.aiReview.text)}</div>
          </div>`).join('')}
      </div>` : ''}
    <div class="card" style="margin-top:16px">
      <h3>Captured frames <span class="tag">${frames.length}</span></h3>
      <div class="frames">${frames.slice(-12).reverse().map((f) => `<img src="${f.dataUrl}" title="${esc(new Date(f.t).toLocaleTimeString() + ' · ' + (f.kind || '') + ' ' + (f.symbol || ''))}" />`).join('')
        || emptyState('No frames captured yet', 'Enable frame capture in Settings to give the coach visual context.')}</div>
    </div>
  `;

}


/** Journaling payoff: which setups you actually trade, and how they do. */

/**
 * The two habits that most often separate a learning trader from a consistent
 * one: exiting far below the peak, and oversizing a single trade.
 */
function renderDisciplinePanel() {
  const exits = E.exitStats(state);
  const risk = E.riskProfile(state, settings);
  if (!exits.count) return '';

  const captured = exits.avgCapturedPct;
  const tone = captured === null ? 'dim' : captured >= 60 ? 'green' : captured >= 35 ? 'amber' : 'red';

  return `
    <div class="grid2" style="margin-top:16px">
      <div class="card">
        <h3>Exit discipline</h3>
        <div class="stat">
          <span>Average of peak captured</span>
          <span class="${tone}" style="font-weight:750">${captured === null ? '—' : captured.toFixed(0) + '%'}</span>
        </div>
        <div class="stat">
          <span>Left on the table</span>
          <span class="${exits.leftOnTableSol > 0 ? 'amber' : 'dim'}" style="font-weight:750">${fmt(exits.leftOnTableSol, 3)} SOL</span>
        </div>
        <div class="stat">
          <span>Went green, closed red</span>
          <span class="${exits.roundTripped ? 'red' : 'green'}" style="font-weight:750">${exits.roundTripped}</span>
        </div>
        ${exits.roundTripped ? '<p class="dim" style="margin:10px 0 0;font-size:12px;line-height:1.55">Round-tripping a winner is the costliest habit on this list — the trade was profitable and the exit gave it back.</p>' : ''}
      </div>
      <div class="card">
        <h3>Position sizing</h3>
        <div class="stat"><span>Average size</span><span style="font-weight:750">${risk.avgSizePct === null ? '—' : risk.avgSizePct.toFixed(1) + '%'} <span class="dim">of starting book</span></span></div>
        <div class="stat"><span>Largest single trade</span><span style="font-weight:750">${risk.maxSizePct === null ? '—' : risk.maxSizePct.toFixed(1) + '%'}</span></div>
        <div class="stat"><span>Trades over 25%</span><span class="${risk.oversized ? 'red' : 'green'}" style="font-weight:750">${risk.oversized}</span></div>
        ${risk.oversized ? '<p class="dim" style="margin:10px 0 0;font-size:12px;line-height:1.55">Oversized entries make one bad read expensive enough to end a run. Consistent size is what makes a win rate meaningful.</p>' : ''}
      </div>
    </div>`;
}

function renderThesisPanel() {
  const stats = E.thesisStats(state);
  if (!stats.total) return '';

  if (!stats.withThesis) {
    return `
      <div class="card" style="margin-top:16px">
        <h3>Trade theses</h3>
        <div class="empty" style="padding:26px">
          <strong>No theses logged yet</strong>
          <span style="font-size:12px;max-width:460px;line-height:1.6">
            Write why you are taking a trade in the overlay while the position is open.
            Because it is captured before the outcome is known, it can be graded honestly afterwards.
          </span>
        </div>
      </div>`;
  }

  const rows = stats.tags.slice(0, 8).map((tag) => {
    const win = tag.avgPnlSol >= 0;
    return `
      <div class="stat" style="align-items:center">
        <span style="color:var(--text)"><strong>${esc(tag.tag)}</strong>
          <span class="dim" style="font-size:11px"> · ${tag.count} trade${tag.count === 1 ? '' : 's'}</span></span>
        <span style="text-align:right;white-space:nowrap">
          <span class="mono" style="font-size:12px">${tag.winRate.toFixed(0)}% win</span>
          <span class="${win ? 'green' : 'red'}" style="display:block;font-weight:750">
            ${win ? '+' : ''}${fmt(tag.avgPnlSol, 3)} SOL avg
          </span>
        </span>
      </div>`;
  }).join('');

  return `
    <div class="grid2" style="margin-top:16px">
      <div class="card">
        <h3>Setups traded</h3>
        ${rows}
      </div>
      <div class="card">
        <h3>Plan discipline</h3>
        <div class="stat"><span>Rounds with a thesis</span><span style="font-weight:750">${stats.withThesis} / ${stats.total} <span class="dim">(${stats.coverage.toFixed(0)}%)</span></span></div>
        <div class="stat"><span>Exited on plan</span><span class="green" style="font-weight:750">${stats.followedPlan}</span></div>
        <div class="stat"><span>Broke the plan</span><span class="red" style="font-weight:750">${stats.brokePlan}</span></div>
        <div class="stat"><span>Won anyway (luck)</span><span class="amber" style="font-weight:750">${stats.luckyWins}</span></div>
        ${stats.luckyWins ? '<p class="dim" style="margin:10px 0 0;font-size:12px;line-height:1.55">Profitable trades that broke their own plan are counted separately — repeating them is a habit, not an edge.</p>' : ''}
      </div>
    </div>`;
}

function buildSummaryForCoach() {
  const rounds = state.rounds || [];
  if (!rounds.length) return null;
  const wins = rounds.filter((r) => r.pnlSol > 0);
  const losses = rounds.filter((r) => r.pnlSol <= 0);
  const avgWin = wins.length ? wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length : 0;
  const avgHold = rounds.length ? rounds.reduce((s, r) => s + r.heldMs, 0) / rounds.length / 60000 : 0;
  const roundText = rounds.map((r) =>
    `- ${r.symbol}: ${r.pnlSol >= 0 ? '+' : ''}${r.pnlSol.toFixed(4)} SOL (${r.pnlPct.toFixed(1)}%), held ${(r.heldMs / 60000).toFixed(1)}m, peak +${r.peakPnlSol.toFixed(4)}, worst ${r.troughPnlSol.toFixed(4)}`
  ).join('\n');
  return {
    roundText,
    avgHold,
    avgWin,
    avgLoss,
  };
}

function avgHold() {
  const rounds = state.rounds || [];
  if (!rounds.length) return '—';
  return (rounds.reduce((s, r) => s + r.heldMs, 0) / rounds.length / 60000).toFixed(1);
}

/**
 * D-17: every stage of the session review goes through module state, and the
 * coach section is re-rendered FROM that state. The old flow wrote the answer
 * into the live DOM only; the next staged refresh (whose markup still held an
 * empty box) discarded it seconds after it rendered.
 */
function setSessionReview(text, error) {
  sessionReview = { text, error: Boolean(error) };
  if (currentSection === 'coach') renderSection('coach');
}

async function runSessionReview() {
  setSessionReview('Analyzing session…', false);
  const summary = buildSummaryForCoach();
  if (!summary) { setSessionReview('No closed round trips yet.', false); return; }
  const messages = [
    { role: 'system', content: 'You are a Solana memecoin trading coach. Given a set of paper-trade round trips, identify recurring patterns and the #1 bad habit hurting the trader. Suggest one drill or rule to fix the habit. Be concise and specific.' },
    { role: 'user', content: `Here are all my round trips:\n${summary.roundText}\n\nWin avg: ${summary.avgWin.toFixed(1)}%, loss avg: ${summary.avgLoss.toFixed(1)}%, avg hold: ${summary.avgHold.toFixed(1)}m.\n\nWhat is my biggest bad habit, and what is one concrete rule to fix it?` },
  ];
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'pt_ai_chat', messages, maxTokens: 1800 });
  } catch (err) {
    // D-21: a service-worker failure used to reject unhandled, leaving the
    // box stuck at "Analyzing session…" forever. Land it in the output.
    setSessionReview('Error: ' + ((err && err.message) ? err.message : String(err)), true);
    return;
  }
  setSessionReview(resp?.reply || ('Error: ' + (resp?.error || 'unknown')), Boolean(resp?.error));
}

/* ---------- settings ---------- */

function renderSettings(el) {
  // D-24: a corrupt backup can leave presetsBuy/sellPcts as non-arrays. An
  // unguarded .join() threw mid-render, leaving Settings blank AND unbound —
  // no working form left to repair the corruption with. Fall back to the
  // defaults at render time; nothing is written until the user saves.
  const sellPctsList = Array.isArray(settings.sellPcts) ? settings.sellPcts : DEFAULTS.sellPcts;
  const presetsBuyList = Array.isArray(settings.presetsBuy) ? settings.presetsBuy : DEFAULTS.presetsBuy;
  el.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h3>Wallet &amp; Trading</h3>
        <div class="field"><label for="set-balance">Starting paper balance (SOL)</label><input id="set-balance" type="number" min="0.1" step="0.1" value="${settings.balanceStartSol}"></div>
        <div class="field"><label for="set-fee">Fee bps per side (100 = 1%)</label><input id="set-fee" type="number" min="0" step="1" value="${settings.feeBps}"></div>
        <div class="field"><label for="set-slippage">Simulated slippage bps</label><input id="set-slippage" type="number" min="0" step="1" value="${settings.slippageBps}"><small>Extra price impact on fills. 0 fills at the live tick.</small></div>
        <div class="field"><label for="set-sellpcts">Quick-sell presets (%)</label><input id="set-sellpcts" type="text" value="${esc(sellPctsList.join(', '))}"></div>
      </div>
      <div class="card">
        <h3>Quick-buy (QB)</h3>
        <div class="field"><label for="set-presets">Quick-buy presets (SOL)</label><input id="set-presets" type="text" value="${esc(presetsBuyList.join(', '))}"><small>Comma separated, shown as buttons in the overlay.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-instant-buy" ${settings.instantBuyEnabled !== false ? 'checked' : ''}> One-click quick buy</label><small>Tapping a preset amount fires the buy immediately, like Axiom and Padre. Off makes presets only select the amount for the BUY button.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-list-quick-buy" ${settings.listQuickBuyEnabled !== false ? 'checked' : ''}> Screener row quick-buy chips</label><small>A "P" chip on every token row of Axiom Pulse, Padre Trenches and GMGN Trenches — buys the first preset amount without opening the chart.</small></div>
    <div class="field"><label for="set-list-quick-buy-size">Screener chip size <span id="val-list-quick-buy-size">${(settings.listQuickBuySize || 1).toFixed(2)}</span>x</label><input id="set-list-quick-buy-size" type="range" min="0.6" max="1.5" step="0.05" value="${Number(settings.listQuickBuySize || 1).toFixed(2)}"><small>Make the trench / pulse snipe chips larger or smaller to fit your screen density.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-panel-buy" ${settings.panelBuyEnabled !== false ? 'checked' : ''}> Buy section in the trade tab</label><small>Shows the quick-buy presets, custom amount and BUY button in the overlay. Off makes the trade tab view-only.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-panel-presets" ${settings.panelPresetsEnabled !== false ? 'checked' : ''}> Quick-buy preset buttons</label><small>The one-tap SOL amount buttons. Off keeps the custom amount and BUY button.</small></div>
      </div>
      <div class="card">
        <h3>AI &amp; Recording</h3>
        <div class="field"><label for="set-endpoint">AI endpoint (OpenAI-compatible)</label><input id="set-endpoint" type="text" value="${esc(settings.aiEndpoint)}" placeholder="https://api.openai.com/v1 or http://127.0.0.1:8765/v1"><small>Blank turns the AI coach off. Paste any OpenAI-compatible endpoint; if it runs on localhost or your LAN, also tick the local toggle below, then Save.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-ai-allow-local" ${settings.aiAllowLocalEndpoint ? 'checked' : ''}> Allow local/private AI endpoints</label><small>Enable only if you run a self-hosted (localhost, 127.0.0.1, or LAN) OpenAI-compatible shim. Off blocks SSRF to internal addresses.</small></div>
        <div class="field"><label for="set-model">AI model</label><input id="set-model" type="text" value="${esc(settings.aiModel || '')}" placeholder="endpoint default"><small>Optional override. Blank uses the endpoint's own default.</small></div>
        <div class="field"><label for="set-key">API key</label><input id="set-key" type="password" value="${esc(settings.aiApiKey || '')}" autocomplete="off" placeholder="optional"><small>Only needed if your BYOK setup requires a bearer token.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-rec" ${settings.recordingEnabled ? 'checked' : ''}> Record screen while a position is open</label><small>Chrome asks for screen permission once per session.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-frames" ${settings.framesEnabled ? 'checked' : ''}> Capture key frames on fills</label></div>
        <div class="field field-check"><label><input type="checkbox" id="set-autorev" ${settings.autoReview ? 'checked' : ''}> Auto-run AI review when a round closes</label></div>
      </div>
      <div class="card">
        <h3>Feedback &amp; alerts</h3>
        <div class="field field-check"><label><input type="checkbox" id="set-effects" ${settings.tradeEffectsEnabled ? 'checked' : ''}> Buy/sell screen effects</label><small>Confetti burst and a brief color flash on each fill.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-sounds" ${settings.tradeSoundsEnabled ? 'checked' : ''}> Trade sounds</label><small>Synthesized locally — no audio files, no network calls.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-profit-alerts" ${settings.profitAlertsEnabled ? 'checked' : ''}> Hidden-tab profit bells</label><small>Rings once per new profit threshold while the tab is in the background.</small></div>
        <div class="field"><label for="set-profit-alert-pct">Profit bell interval (%)</label><input id="set-profit-alert-pct" type="number" min="1" max="1000" step="1" value="${settings.profitAlertPct || 10}"><small>10 rings at +10%, +20%, +30%. Crossed levels never repeat.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-avg-lines" ${settings.averagePriceLinesEnabled ? 'checked' : ''}> Padre-style average price lines</label><small>Native “Avg. Fill Price” and “Avg. Exit Price” lines from your paper fills.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-positions-bar" ${settings.positionsBarEnabled !== false ? 'checked' : ''}> Positions bar</label><small>A top rail on every trading page showing all open paper positions and their live P&amp;L. Click a position to jump to its chart.</small></div>
      </div>
      <div class="card">
        <h3>Overlay</h3>
        <div class="field field-check"><label><input type="checkbox" id="set-overlay" ${settings.overlayEnabled !== false ? 'checked' : ''}> Enable overlay</label><small>Master switch for the PaperTrench panel. Off hides it on all pages.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-overlay-auto-hide" ${settings.overlayHideWhenNoToken !== false ? 'checked' : ''}> Hide overlay when no token is detected</label><small>The panel disappears on home pages and screeners, then pops back when you open a coin.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-focus-mode" ${settings.panelFocusMode === true ? 'checked' : ''}> Focus mode (Axiom-style)</label><small>Strips the banner, watermark, sparkline, thesis and last-close card from the trade tab — only token, price, balance and buy/sell controls remain. For distraction-free execution.</small></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <button class="btn" id="save-settings">Save settings</button>
      <span id="save-status" class="dim" style="font-size:12px" role="status"></span>
      <button class="btn-sec" id="test-ai">Test AI endpoint</button>
      <span id="ai-test-result" class="dim" style="font-size:12px"></span>
      <button class="btn-red" id="reset-all" style="margin-left:auto">Reset wallet &amp; history</button>
    </div>
  `;
  // Handlers are attached by rebindSection() once the markup is live in the
  // document; binding here would target the detached staging element.
}

/** Wire the settings form. Called after the section is in the document. */
function bindSettings() {
  document.getElementById('save-settings').addEventListener('click', saveFromForm);
  const sizeSlider = document.getElementById('set-list-quick-buy-size');
  const sizeVal = document.getElementById('val-list-quick-buy-size');
  if (sizeSlider && sizeVal) {
    sizeSlider.addEventListener('input', () => { sizeVal.textContent = Number(sizeSlider.value).toFixed(2); });
  }
  document.getElementById('reset-all').addEventListener('click', async () => {
    if (!confirm('Wipe all paper positions, trades, round trips, screenshots, and session replays?')) return;
    // D-38: honour the starting balance typed into the (possibly unsaved)
    // form — resetting to the stale saved value while the form shows another
    // number makes the fresh wallet and the form disagree. The accepted value
    // is persisted to settings as part of the reset so the reset balance and
    // the saved settings agree.
    const balanceInput = document.getElementById('set-balance');
    const formBalance = balanceInput ? Number(balanceInput.value) : NaN;
    const balanceChanged = Number.isFinite(formBalance) && formBalance >= 0.1
      && formBalance !== Number(settings.balanceStartSol);
    if (balanceChanged) settings = { ...settings, balanceStartSol: formBalance };
    // Inherit the current seq so a still-open trading tab (holding the
    // pre-reset wallet at a higher seq) adopts the reset instead of
    // resurrecting the old state with its next heartbeat write.
    state = E.resetState(settings, state.seq);
    replays = [];
    frames = [];
    stopReplayPlayback();
    // D-51: no extra seq bump here — engine resetState already advanced seq
    // past the inherited base; the engine owns that bump, and doubling it
    // here made the write counter lie about how many writes happened.
    state.updatedAt = Date.now();
    const write = { pt_state: state, pt_frames: [], [RP.STORAGE_KEY]: [] };
    if (balanceChanged) write.pt_settings = settings;
    try {
      await store.set(write);
    } catch (err) {
      const status = document.getElementById('save-status');
      if (status) status.textContent = 'Reset failed: ' + ((err && err.message) ? err.message : String(err));
      return;
    }
    chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
    renderSidebar();
    renderSection('overview');
  });
  document.getElementById('test-ai').addEventListener('click', async () => {
    const out = document.getElementById('ai-test-result');
    // D-29: a connectivity TEST must not persist anything — the old code
    // committed the entire unsaved form to storage as a side effect. The form
    // values now travel as overrides on the message; the background validates
    // them through the same isAllowedEndpoint gate as saved settings and
    // writes nothing.
    const settingsNow = gatherSettingsFromForm([]);
    if (!settingsNow.aiEndpoint) {
      out.textContent = 'AI coach is off — no endpoint set. Paste one above (and enable the local toggle for localhost/LAN), then Save.';
      return;
    }
    out.textContent = 'Testing…';
    let models;
    try {
      models = await chrome.runtime.sendMessage({
        type: 'pt_ai_models',
        overrides: {
          endpoint: settingsNow.aiEndpoint,
          apiKey: settingsNow.aiApiKey,
          model: settingsNow.aiModel,
          aiAllowLocalEndpoint: settingsNow.aiAllowLocalEndpoint,
        },
      });
    } catch (err) {
      out.textContent = 'Error: ' + ((err && err.message) ? err.message : String(err));
      return;
    }
    if (models?.error) out.textContent = `Error: ${models.error}`;
    else if (models?.models?.length) out.textContent = `OK — ${models.models.length} model(s) found: ${models.models.slice(0, 3).join(', ')}`;
    else out.textContent = 'No models reachable. Check the endpoint URL, that the service is running, and that the local toggle is on for localhost/LAN endpoints.';
  });
}

/**
 * Read the settings form, validating every numeric field.
 *
 * D-10/D-11/D-23/D-42: raw form values used to flow straight into the engine.
 * Negative fee bps MINT free SOL on every fill (engine.js applies feeBps
 * arithmetically), slippage ≥ 10000 collapses every sell quote and throws a
 * misleading "No live price available", sell presets over 100% render buttons
 * that lie, and `Number(v) || 10` silently turned an invalid (or 0) balance
 * into 10. Every coercion or rejection is appended to `notes` so the save
 * status can SAY what happened instead of silently altering the input.
 *
 * D-19: returns ONLY the keys this form controls — it must never spread the
 * module `settings` object in. That object is frozen at dashboard-load time
 * while the Settings tab is open (the tab counts as busy), so spreading it
 * baked every stale value in and Save reverted whatever the content script
 * had written meanwhile: panel position, bar position/hidden, overlay size,
 * auto-hide. The caller lays these keys over a FRESH storage read instead.
 * `base` supplies the saved fallback for a rejected balance.
 */
function gatherSettingsFromForm(notes = [], base = settings) {
  const clampInt = (id, min, max, fallback, label) => {
    const raw = document.getElementById(id).value;
    const n = Math.round(Number(raw));
    if (String(raw).trim() === '' || !Number.isFinite(n)) {
      notes.push(`${label} was not a number — using ${fallback}`);
      return fallback;
    }
    if (n < min) { notes.push(`${label} raised to the minimum ${min}`); return min; }
    if (n > max) { notes.push(`${label} capped at ${max}`); return max; }
    return n;
  };
  // Preset lists: positive, bounded, deduplicated where repeats are
  // meaningless, and capped at 8 (500 presets would mean 500 overlay buttons).
  const numberList = (id, max, label, { dedupe = false } = {}) => {
    const parts = document.getElementById(id).value.split(',').map((s) => s.trim()).filter(Boolean);
    let values = parts.map((s) => parseFloat(s)).filter((n) => Number.isFinite(n) && n > 0 && n <= max);
    if (dedupe) values = [...new Set(values)];
    if (values.length > 8) values = values.slice(0, 8);
    if (values.length !== parts.length) {
      notes.push(`${label}: kept ${values.length} of ${parts.length} entries (each must be > 0 and ≤ ${max}, max 8${dedupe ? ', no repeats' : ''})`);
    }
    return values;
  };

  // D-42/D-06: an invalid balance keeps the SAVED value and says so — it
  // must never silently become 10 (or anything else the user did not type).
  const savedBalance = Number(base.balanceStartSol) >= 0.1
    ? Number(base.balanceStartSol)
    : DEFAULTS.balanceStartSol;
  const balanceRaw = document.getElementById('set-balance').value;
  const balanceNum = Number(balanceRaw);
  let balanceStartSol = savedBalance;
  if (Number.isFinite(balanceNum) && balanceNum >= 0.1) balanceStartSol = balanceNum;
  else notes.push(`starting balance "${balanceRaw}" rejected (must be ≥ 0.1 SOL) — kept ${savedBalance}`);

  const presets = numberList('set-presets', 1000, 'quick-buy presets');
  const sellPcts = numberList('set-sellpcts', 100, 'quick-sell presets', { dedupe: true });
  if (!presets.length) notes.push('quick-buy presets were empty — defaults restored');
  if (!sellPcts.length) notes.push('quick-sell presets were empty — defaults restored');

  return {
    balanceStartSol,
    // D-11: integers 0..1000 only — a negative fee inverts the arithmetic.
    feeBps: clampInt('set-fee', 0, 1000, DEFAULTS.feeBps, 'fee bps'),
    // D-23: integers 0..2000 only — ≥ 10000 breaks every sell.
    slippageBps: clampInt('set-slippage', 0, 2000, DEFAULTS.slippageBps, 'slippage bps'),
    presetsBuy: presets.length ? presets : [0.1, 0.5, 1, 2],
    instantBuyEnabled: document.getElementById('set-instant-buy').checked,
    listQuickBuyEnabled: document.getElementById('set-list-quick-buy').checked,
    listQuickBuySize: Math.max(0.6, Math.min(1.5, Number(document.getElementById('set-list-quick-buy-size').value) || 1)),
    panelBuyEnabled: document.getElementById('set-panel-buy').checked,
    panelPresetsEnabled: document.getElementById('set-panel-presets').checked,
    sellPcts: sellPcts.length ? sellPcts : [25, 50, 75, 100],
    aiEndpoint: document.getElementById('set-endpoint').value.trim() || DEFAULTS.aiEndpoint,
    aiAllowLocalEndpoint: document.getElementById('set-ai-allow-local').checked,
    aiModel: document.getElementById('set-model').value.trim(),
    aiApiKey: document.getElementById('set-key').value.trim(),
    recordingEnabled: document.getElementById('set-rec').checked,
    framesEnabled: document.getElementById('set-frames').checked,
    autoReview: document.getElementById('set-autorev').checked,
    tradeEffectsEnabled: document.getElementById('set-effects').checked,
    tradeSoundsEnabled: document.getElementById('set-sounds').checked,
    profitAlertsEnabled: document.getElementById('set-profit-alerts').checked,
    profitAlertPct: Math.max(1, Number(document.getElementById('set-profit-alert-pct').value) || 10),
    averagePriceLinesEnabled: document.getElementById('set-avg-lines').checked,
    positionsBarEnabled: document.getElementById('set-positions-bar').checked,
    overlayEnabled: document.getElementById('set-overlay').checked,
    overlayHideWhenNoToken: document.getElementById('set-overlay-auto-hide').checked,
    panelFocusMode: document.getElementById('set-focus-mode').checked,
  };
}

let saveStatusTimer = null;

async function saveFromForm() {
  const notes = [];
  // D-47: the save flow reports into its OWN status element — it used to
  // write "Saved." into the AI-test output span and never clear it.
  const status = document.getElementById('save-status');
  const show = (text, isError) => {
    if (!status) return;
    status.textContent = text;
    status.style.color = isError ? 'var(--red)' : '';
    if (saveStatusTimer) { clearTimeout(saveStatusTimer); saveStatusTimer = null; }
    // The plain confirmation clears itself; failures and adjustment reports
    // stay put — the user has to be able to read what was changed.
    if (!isError && !notes.length) {
      saveStatusTimer = setTimeout(() => {
        if (status.textContent === text) status.textContent = '';
      }, 2500);
    }
  };
  // D-19: re-read pt_settings FRESH at save time and lay only the
  // form-controlled keys over that copy. The module `settings` object is
  // frozen at dashboard-load time while this tab is open (the Settings tab
  // counts as busy), so `{...stale, ...form}` silently reverted every
  // content-script settings write made meanwhile — the user's dragged panel
  // and bar positions, overlay size, bar hidden state, auto-hide.
  const stored = await store.get(['pt_settings']);
  if (stored === null) {
    show('Save failed: storage is unreadable — nothing was saved. Reload the dashboard and try again.', true);
    return;
  }
  const freshSettings = E.mergeSettings(stored.pt_settings);
  settings = { ...freshSettings, ...gatherSettingsFromForm(notes, freshSettings) };
  try {
    await saveSettings();
  } catch (err) {
    // D-25: a failed save used to be completely invisible — the "Saved."
    // write happened after the await and nothing caught the rejection.
    show('Save failed: ' + ((err && err.message) ? err.message : String(err)), true);
    return;
  }
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  show(notes.length ? 'Saved — adjusted: ' + notes.join(' · ') : 'Saved.', false);
}

/* ---------- helpers ---------- */

function fmt(n, dp = 4) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
}

/**
 * How a fill is described to a trader.
 *
 * Every fill records the market cap it happened at, and that is the figure
 * traders quote ("in at 240K"). The unit price is only shown when a fill
 * predates market-cap capture.
 */
function fillLevel(trade) {
  if (!trade) return '—';
  const mcap = Number(trade.mcap);
  if (mcap > 0) return PC.formatMarketCap(mcap) + ' MC';
  const price = Number(trade.priceNative);
  // Never render the "— SOL" corpse a missing price used to produce.
  return price > 0 ? PC.formatPrice(price) + ' SOL' : '—';
}

/**
 * D-32: the journal's "Market cap" column must only ever contain a market
 * cap. fillLevel()'s SOL-price fallback is right for prose labels ("bought
 * @ …"), but under a "Market cap" header a unit price reads as a (wildly
 * wrong) market cap — a fill without one renders a plain em-dash instead.
 */
function mcapLevel(trade) {
  const mcap = Number(trade && trade.mcap);
  return mcap > 0 ? PC.formatMarketCap(mcap) + ' MC' : '—';
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function formatDateTime(ms) {
  const value = Number(ms);
  return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : '—';
}

function formatUnix(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? formatDateTime(value * 1000) : '—';
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// D-16: catch boot failures — a bare init() left the page blank on any throw.
init().catch(renderInitError);
