/* PaperTrench — popup script.
 *
 * Self-contained on purpose: the popup only reads storage and formats numbers,
 * so it does not depend on engine.js being loaded first. That removes a whole
 * class of "PaperEngine is undefined" load-order failures.
 */

'use strict';

const DEFAULTS = { balanceStartSol: 10 };

function $(id) { return document.getElementById(id); }

$('dash').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('toggle').addEventListener('click', toggleOverlay);
$('reset').addEventListener('click', resetWallet);

function fmt(n, dp = 4) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
}

function freshState(settings) {
  return {
    version: 1,
    cashSol: settings.balanceStartSol,
    startedAt: Date.now(),
    positions: {},
    rounds: [],
    journal: [],
    stats: { totalBuys: 0, totalSells: 0, realizedPnlSol: 0, feesPaidSol: 0 },
  };
}

/** Equity = cash + mark-to-market value of every open position. */
function computeStats(state, settings) {
  const positions = Object.values(state.positions || {});
  const rounds = state.rounds || [];
  const openValue = positions.reduce((s, p) => s + (p.qty || 0) * (p.lastPriceNative || 0), 0);
  const equity = (state.cashSol || 0) + openValue;
  return {
    equitySol: equity,
    openPositions: positions.length,
    realizedPnlSol: rounds.reduce((s, r) => s + (r.pnlSol || 0), 0),
    rounds: rounds.length,
    equityVsStart: equity - settings.balanceStartSol,
  };
}

async function load() {
  try {
    const stored = await chrome.storage.local.get(['pt_state', 'pt_settings']);
    const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
    const state = stored.pt_state || freshState(settings);
    const stats = computeStats(state, settings);

    const up = stats.equityVsStart >= 0;

    $('equity').innerHTML = `${fmt(stats.equitySol, 2)} <small>SOL</small>`;
    $('equity').className = 'equity ' + (up ? 'green' : 'red');

    const deltaEl = $('delta');
    const pct = settings.balanceStartSol ? (stats.equityVsStart / settings.balanceStartSol) * 100 : 0;
    deltaEl.textContent = `${up ? '▲' : '▼'} ${up ? '+' : ''}${fmt(stats.equityVsStart, 3)} SOL (${up ? '+' : ''}${pct.toFixed(1)}%)`;
    deltaEl.className = 'delta ' + (up ? 'green' : 'red');

    $('cash').textContent = fmt(state.cashSol, 2);
    $('open').textContent = stats.openPositions;
    $('rounds').textContent = stats.rounds;

    const pnlEl = $('pnl');
    pnlEl.textContent = (stats.realizedPnlSol >= 0 ? '+' : '') + fmt(stats.realizedPnlSol, 3);
    pnlEl.className = 'v ' + (stats.realizedPnlSol >= 0 ? 'green' : 'red');

    const rounds = (state.rounds || []).slice(0, 6);
    $('recent').innerHTML = rounds.length
      ? rounds.map((r) => `
          <div class="row">
            <span><strong>${escapeHtml(r.symbol || '?')}</strong><span class="dim"> · ${((r.heldMs || 0) / 60000).toFixed(1)}m</span></span>
            <span class="${r.pnlSol >= 0 ? 'green' : 'red'}" style="font-weight:700">${r.pnlSol >= 0 ? '+' : ''}${fmt(r.pnlSol, 3)} SOL</span>
          </div>`).join('')
      : '<div class="row dim">No closed round trips yet</div>';
  } catch (err) {
    $('status').textContent = 'Error: ' + err.message;
    console.error('PaperTrench popup load failed', err);
  }
}

async function toggleOverlay() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'pt_toggle_overlay' });
    window.close();
  } catch (e) {
    $('status').textContent = 'No PaperTrench panel on this tab — reload the page first.';
  }
}

async function resetWallet() {
  if (!confirm('Reset the paper wallet and erase positions, trade history, frames, and session replays?')) return;
  const stored = await chrome.storage.local.get(['pt_settings']);
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  await chrome.storage.local.set({
    pt_state: freshState(settings),
    pt_frames: [],
    pt_replays: [],
  });
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  load();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

load();
