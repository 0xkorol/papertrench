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
const store = {
  get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
  set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
};

const SECTIONS = ['overview', 'journal', 'rounds', 'replay', 'leaderboard', 'coach', 'settings'];
let currentSection = 'overview';

async function init() {
  await loadAll();
  bindNav();
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
  setInterval(refreshIfChanged, 4000);
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
    // Live marks move while a position is open, so include them.
    positions.map((p) => `${p.mint}:${p.lastPriceNative}`).join(','),
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
 * True while the user is mid-interaction with the current section.
 *
 * Rebuilding under a focused input destroys what they are typing; rebuilding a
 * playing video restarts it. Neither is ever worth a refresh.
 */
function isUserBusy() {
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return true;
  if (currentSection === 'replay' && replayPlaying()) return true;
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
    refreshIfChanged().catch(() => {});
  });
}

async function loadAll() {
  const s = await store.get(['pt_state', 'pt_settings', 'pt_frames', RP.STORAGE_KEY]);
  settings = E.mergeSettings(s.pt_settings);
  state = s.pt_state || E.defaultState(settings);
  frames = s.pt_frames || [];
  replays = RP.normalizeReplayList(s[RP.STORAGE_KEY]);
  await loadRecordings();
  if (!selectedReplayId && replays[0]) selectedReplayId = replays[0].sessionId;
}

async function saveSettings() {
  await store.set({ pt_settings: settings });
}

async function saveState() {
  await store.set({ pt_state: state });
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
  if (id === 'rounds') {
    el.querySelectorAll('.review-btn').forEach((button) =>
      button.addEventListener('click', () => runReview(button.dataset.id)));
    el.querySelectorAll('.replay-btn').forEach((button) =>
      button.addEventListener('click', () => openReplay(button.dataset.session)));
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

  el.innerHTML = `
    <div class="grid3" style="margin-bottom:16px">
      ${statTile('Total return', `${stats.equityVsStart >= 0 ? '+' : ''}${fmt(stats.equityVsStart, 3)} SOL`, stats.equityVsStart >= 0 ? 'green' : 'red',
        settings.balanceStartSol ? `${stats.equityVsStart >= 0 ? '+' : ''}${((stats.equityVsStart / settings.balanceStartSol) * 100).toFixed(1)}% on ${fmt(settings.balanceStartSol, 2)} SOL` : '')}
      ${statTile('Best round', best ? `${best.pnlSol >= 0 ? '+' : ''}${fmt(best.pnlSol, 3)} SOL` : '—', 'green', best ? `${best.symbol} · ${best.pnlPct.toFixed(1)}%` : 'No closed rounds yet')}
      ${statTile('Worst round', worst ? `${fmt(worst.pnlSol, 3)} SOL` : '—', 'red', worst ? `${worst.symbol} · ${worst.pnlPct.toFixed(1)}%` : 'No closed rounds yet')}
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
 * Cumulative realized P&L per fill, plus live unrealized on open positions.
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
  const sorted = [...state.journal].sort((a, b) => a.ts - b.ts);
  const pts = [{ t: state.startedAt, eq: start }];
  let pnl = 0;
  for (const t of sorted) {
    if (t.side === 'sell') pnl += (t.pnlSol || 0);
    pts.push({ t: t.ts, eq: start + pnl });
  }
  let openPnl = 0;
  for (const mint of Object.keys(state.positions || {})) openPnl += E.unrealizedPnl(state.positions[mint]);
  pts.push({ t: Date.now(), eq: start + pnl + openPnl });

  if (sorted.length === 0) {
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
    const pct = p.costSol > 0 ? (pnl / p.costSol) * 100 : 0;
    const win = pnl >= 0;
    return `
      <div class="stat" style="align-items:center">
        <span style="min-width:0;color:var(--text)">
          <strong style="font-size:14px">${esc(p.symbol)}</strong>
          <span class="dim mono" style="display:block;font-size:10.5px;margin-top:2px">${esc(E.short(p.mint))} · ${esc(p.site)}</span>
        </span>
        <span style="text-align:right;white-space:nowrap">
          <span class="mono" style="font-size:12px">${fmt(p.qty, 2)} tokens</span>
          <span class="${win ? 'green' : 'red'}" style="display:block;margin-top:3px;font-weight:800;font-size:14px">
            ${win ? '+' : ''}${fmt(pnl)} SOL (${win ? '+' : ''}${pct.toFixed(1)}%)
          </span>
        </span>
      </div>`;
  }).join('');
}

function emptyState(title, sub) {
  return `<div class="empty"><strong>${esc(title)}</strong><span style="font-size:12px">${esc(sub || '')}</span></div>`;
}

/* ---------- journal ---------- */

function renderJournal(el) {
  const rows = (state.journal || []).map((t) => `
    <tr>
      <td><span class="${t.side === 'buy' ? 'side-buy' : 'side-sell'}">${t.side.toUpperCase()}</span></td>
      <td><strong>${esc(t.symbol)}</strong></td>
      <td class="dim">${esc(t.site)}</td>
      <td class="num">${fmt(t.qty, 4)}</td>
      <td class="num">${fmt(t.priceNative, 8)}</td>
      <td class="num">${fmt(t.solGross, 4)}</td>
      <td class="num dim">${fmt(t.solGross - (t.solNet || 0), 4)}</td>
      <td class="num ${t.pnlSol === undefined ? 'dim' : t.pnlSol >= 0 ? 'green' : 'red'}" style="font-weight:750">
        ${t.pnlSol !== undefined ? (t.pnlSol >= 0 ? '+' : '') + fmt(t.pnlSol) : '—'}
      </td>
      <td class="dim">${timeAgo(t.ts)}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="card"><h3>All fills <span class="tag">${(state.journal || []).length}</span></h3>
      <div class="log">
        <table>
          <thead><tr><th>Side</th><th>Token</th><th>Site</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Gross</th><th class="num">Fee</th><th class="num">P&L</th><th>When</th></tr></thead>
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
        <td>${r.aiReview ? '<span class="tag" style="color:var(--green);border-color:rgba(52,211,153,.3)">reviewed</span>' : '<button class="btn-sec review-btn" data-id="' + esc(r.id) + '">AI review</button>'}</td>
        <td>${replay ? `<button class="btn-sec replay-btn" data-session="${esc(replay.sessionId)}">▶ ${replay.checkpoints.length} moments</button>` : '<span class="dim">—</span>'}</td>
        <td class="dim" style="font-size:11px">${esc(r.recordingFile || '—')}</td>
      </tr>`;
  }).join('');
  el.innerHTML = `
    <div class="card"><h3>Closed round trips <span class="tag">${(state.rounds || []).length}</span></h3>
      <div class="log"><table>
        <thead><tr><th>Token</th><th>Site</th><th class="num">Held</th><th class="num">In</th><th class="num">Out</th><th class="num">P&L SOL</th><th class="num">%</th><th class="num">Peak/Worst</th><th>Exit</th><th>Thesis</th><th>Review</th><th>Replay</th><th>Recording</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="13">${emptyState('No closed round trips yet', 'Close a paper position to bank a round trip.')}</td></tr>`}</tbody>
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

async function runReview(roundId) {
  const b = document.querySelector(`button[data-id="${roundId}"]`);
  if (b) { b.disabled = true; b.textContent = 'Analyzing…'; }
  const round = (state.rounds || []).find((r) => r.id === roundId);
  if (!round) return;
  const trades = (state.journal || []).filter((t) => round.tradeIds.includes(t.id));
  const { pt_frames = [] } = await store.get(['pt_frames']);
  const roundFrames = pt_frames.filter((frame) =>
    frame.sessionId ? frame.sessionId === round.sessionId :
      frame.mint === round.mint && frame.t >= round.openedAt && frame.t <= round.closedAt
  );
  const messages = buildCoachMessages(round, trades, roundFrames);
  const resp = await chrome.runtime.sendMessage({ type: 'pt_ai_chat', messages, maxTokens: 2000 });
  round.aiReview = {
    t: Date.now(),
    text: resp?.reply || ('Error: ' + (resp?.error || 'unknown')),
    ok: !resp?.error,
  };
  await saveState();
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
      content: 'You are a no-BS Solana memecoin trading coach reviewing one paper-trade round trip. Be concrete, cite numbers, and name exactly one bad habit and one fix. If a pre-trade thesis is supplied, judge PROCESS against it: a profitable trade that broke its own plan is a process failure, and a losing trade that followed the plan is not. Keep it under 350 words.',
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
    const current = buildReplayView(currentReplay());
    if (replayCursor >= current.events.length - 1) stopReplayPlayback();
    else replayCursor += 1;
    updateReplayView(buildReplayView(currentReplay()));
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
    replayShell = null;
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
        ? `${fmt(item.trade.solGross, 3)} SOL @ ${fmt(item.trade.priceNative, 9)}${
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
      ? `${fmt(event.trade.solGross, 3)} SOL @ ${fmt(event.trade.priceNative, 9)}${
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
    return `${event.trade.side === 'buy' ? 'Paper buy' : 'Paper sell'} · ${fmt(event.trade.solGross, 3)} SOL @ ${fmt(event.trade.priceNative, 9)} SOL`;
  }
  if (event.frame) return `Chart frame · ${event.frame.kind || 'interval'}`;
  return `Moment · ${event.kind}`;
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
function renderLeaderboard(el) {
  const chain = Array.isArray(state.attestChain) ? state.attestChain : [];
  const stats = E.sessionStats(state, settings);
  const identity = settings.leaderboardIdentity || null;

  el.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h3>Verified record</h3>
        <div id="lb-verify" class="lb-verify">
          <div class="lb-badge">…</div>
          <div><div class="t">Checking your trade chain…</div><div class="s">Re-deriving your result from committed fills.</div></div>
        </div>
        <div class="stat" style="margin-top:14px"><span>Committed fills</span><span style="font-weight:750">${chain.length}</span></div>
        <div class="stat"><span>Claimed realized P&amp;L</span><span class="${stats.realizedPnlSol >= 0 ? 'green' : 'red'}" style="font-weight:750">${stats.realizedPnlSol >= 0 ? '+' : ''}${fmt(stats.realizedPnlSol, 3)} SOL</span></div>
        <div class="stat" id="lb-derived"><span>Derived from chain</span><span class="dim">…</span></div>
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
        <li><strong>Stated plainly:</strong> this is evidence, not proof. Anyone can run modified code locally, so final standings must be recomputed server-side from the chain — never from the number this app displays.</li>
      </ul>
    </div>`;
}

function renderStandingsPlaceholder(identity, stats) {
  // No leaderboard service is configured, so no remote standings are invented.
  return `
    <div class="lb-rank me">
      <span class="pos">—</span>
      <span class="lb-handle">${identity ? '@' + esc(identity.handle) : 'You (unlinked)'}
        <small>${stats.rounds} round trips · ${stats.winRate === null ? '—' : stats.winRate.toFixed(0) + '% win rate'}</small></span>
      <span class="${stats.realizedPnlSol >= 0 ? 'green' : 'red'}" style="font-weight:800">
        ${stats.realizedPnlSol >= 0 ? '+' : ''}${fmt(stats.realizedPnlSol, 3)} SOL
      </span>
    </div>
    <p class="dim" style="font-size:12px;line-height:1.6;margin:14px 0 0">
      No leaderboard server is configured yet, so no global standings are shown.
      Your chain is being committed locally in the meantime, so your record is
      already verifiable the moment ranking goes live — nothing needs to be
      reconstructed retroactively.
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
      await saveSettings();
      renderSection('leaderboard');
    });
  }
  const unlink = el.querySelector('#lb-unlink');
  if (unlink) {
    unlink.addEventListener('click', async () => {
      delete settings.leaderboardIdentity;
      await saveSettings();
      renderSection('leaderboard');
    });
  }

  const chain = Array.isArray(state.attestChain) ? state.attestChain : [];
  const box = el.querySelector('#lb-verify');
  const derived = el.querySelector('#lb-derived');
  if (!box) return;

  const result = await AT.verifyChain(chain);
  const stats = E.sessionStats(state, settings);
  const match = AT.claimMatchesChain(
    { realizedPnlSol: stats.realizedPnlSol }, chain, settings.balanceStartSol, 1e-6
  );

  const ok = result.valid && match.ok;
  box.className = 'lb-verify ' + (ok ? 'ok' : chain.length ? 'bad' : '');
  box.innerHTML = `
    <div class="lb-badge">${ok ? '✓' : chain.length ? '!' : '·'}</div>
    <div>
      <div class="t">${ok ? 'Chain intact' : chain.length ? 'Chain does not match local state' : 'No trades committed yet'}</div>
      <div class="s">${ok
        ? `${result.length} fills verified · displayed P&L matches the committed history`
        : chain.length
          ? `${result.problems.length} problem${result.problems.length === 1 ? '' : 's'} found · derived P&L differs by ${fmt(match.diff, 4)} SOL`
          : 'Your first paper fill will start the chain.'}</div>
    </div>`;

  if (derived) {
    const value = match.replayed.realizedPnlSol;
    derived.innerHTML = `<span>Derived from chain</span><span class="${value >= 0 ? 'green' : 'red'}" style="font-weight:750">${value >= 0 ? '+' : ''}${fmt(value, 3)} SOL</span>`;
  }
}

/* ---------- coach ---------- */

function renderCoach(el) {
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
        <div id="coach-session-out" style="margin-top:14px" class="review"></div>
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

async function runSessionReview() {
  const out = document.getElementById('coach-session-out');
  out.textContent = 'Analyzing session…';
  out.className = 'review';
  const summary = buildSummaryForCoach();
  if (!summary) { out.textContent = 'No closed round trips yet.'; return; }
  const messages = [
    { role: 'system', content: 'You are a Solana memecoin trading coach. Given a set of paper-trade round trips, identify recurring patterns and the #1 bad habit hurting the trader. Suggest one drill or rule to fix the habit. Be concise and specific.' },
    { role: 'user', content: `Here are all my round trips:\n${summary.roundText}\n\nWin avg: ${summary.avgWin.toFixed(1)}%, loss avg: ${summary.avgLoss.toFixed(1)}%, avg hold: ${summary.avgHold.toFixed(1)}m.\n\nWhat is my biggest bad habit, and what is one concrete rule to fix it?` },
  ];
  const resp = await chrome.runtime.sendMessage({ type: 'pt_ai_chat', messages, maxTokens: 1800 });
  out.textContent = resp?.reply || ('Error: ' + (resp?.error || 'unknown'));
  if (resp?.error) out.classList.add('error');
}

/* ---------- settings ---------- */

function renderSettings(el) {
  el.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h3>Wallet &amp; Trading</h3>
        <div class="field"><label for="set-balance">Starting paper balance (SOL)</label><input id="set-balance" type="number" min="0.1" step="0.1" value="${settings.balanceStartSol}"></div>
        <div class="field"><label for="set-fee">Fee bps per side (100 = 1%)</label><input id="set-fee" type="number" min="0" step="1" value="${settings.feeBps}"></div>
        <div class="field"><label for="set-slippage">Simulated slippage bps</label><input id="set-slippage" type="number" min="0" step="1" value="${settings.slippageBps}"><small>Extra price impact on fills. 0 fills at the live tick.</small></div>
        <div class="field"><label for="set-presets">Quick-buy presets (SOL)</label><input id="set-presets" type="text" value="${esc(settings.presetsBuy.join(', '))}"><small>Comma separated, shown as buttons in the overlay.</small></div>
        <div class="field"><label for="set-sellpcts">Quick-sell presets (%)</label><input id="set-sellpcts" type="text" value="${esc(settings.sellPcts.join(', '))}"></div>
      </div>
      <div class="card">
        <h3>AI &amp; Recording</h3>
        <div class="field"><label for="set-endpoint">AI endpoint (OpenAI-compatible)</label><input id="set-endpoint" type="text" value="${esc(settings.aiEndpoint)}"></div>
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
    </div>
    <div class="card" style="margin-top:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <button class="btn" id="save-settings">Save settings</button>
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
  document.getElementById('reset-all').addEventListener('click', async () => {
    if (!confirm('Wipe all paper positions, trades, round trips, screenshots, and session replays?')) return;
    state = E.resetState(settings);
    replays = [];
    frames = [];
    stopReplayPlayback();
    await store.set({ pt_state: state, pt_frames: [], [RP.STORAGE_KEY]: [] });
    chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
    renderSidebar();
    renderSection('overview');
  });
  document.getElementById('test-ai').addEventListener('click', async () => {
    const out = document.getElementById('ai-test-result');
    out.textContent = 'Testing…';
    const settingsNow = gatherSettingsFromForm();
    await store.set({ pt_settings: settingsNow });
    settings = settingsNow;
    const models = await chrome.runtime.sendMessage({ type: 'pt_ai_models' });
    if (models?.models?.length) out.textContent = `OK — ${models.models.length} model(s) found: ${models.models.slice(0, 3).join(', ')}`;
    else out.textContent = 'No models reachable. Check endpoint and that your BYOK shim is running.';
  });
}

function gatherSettingsFromForm() {
  const presets = document.getElementById('set-presets').value.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n) && n > 0);
  const sellPcts = document.getElementById('set-sellpcts').value.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n) && n > 0);
  return {
    ...settings,
    balanceStartSol: Number(document.getElementById('set-balance').value) || 10,
    feeBps: Number(document.getElementById('set-fee').value) || 0,
    slippageBps: Number(document.getElementById('set-slippage').value) || 0,
    presetsBuy: presets.length ? presets : [0.1, 0.5, 1, 2],
    sellPcts: sellPcts.length ? sellPcts : [25, 50, 75, 100],
    aiEndpoint: document.getElementById('set-endpoint').value.trim() || DEFAULTS.aiEndpoint,
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
  };
}

async function saveFromForm() {
  settings = gatherSettingsFromForm();
  await saveSettings();
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  document.getElementById('ai-test-result').textContent = 'Saved.';
}

/* ---------- helpers ---------- */

function fmt(n, dp = 4) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
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

init();
