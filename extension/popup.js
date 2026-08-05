/* PaperTrench — popup script.
 *
 * Self-contained on purpose: the popup only reads storage and formats numbers,
 * so it does not depend on engine.js being loaded first. That removes a whole
 * class of "PaperEngine is undefined" load-order failures.
 */

'use strict';

const DEFAULTS = { balanceStartSol: 10, overlayEnabled: true, overlayHideWhenNoToken: true };

function $(id) { return document.getElementById(id); }

$('dash').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('toggle').addEventListener('click', toggleOverlay);
$('reset').addEventListener('click', resetWallet);
$('backup').addEventListener('click', backupWallet);
$('restore').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', restoreWallet);
$('overlay-window').addEventListener('click', openStreamOverlay);

function fmt(n, dp = 4) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
}

function freshState(settings) {
  return {
    version: 1,
    seq: 0,
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
  // D-02: realized P&L is the engine's per-sell accumulator, which credits
  // partial exits the moment they happen — the same definition the dashboard
  // sidebar, calendar, journal, and the attest chain replay use. The old
  // rounds-only sum showed +0 here while the calendar showed the banked
  // partial. Legacy states can miss the accumulator; the journal's per-sell
  // pnlSol entries are the same definition and back-fill it.
  let realized = Number((state.stats || {}).realizedPnlSol);
  if (!Number.isFinite(realized)) {
    realized = (state.journal || []).reduce(
      (s, t) => s + (t.side === 'sell' ? (Number(t.pnlSol) || 0) : 0), 0
    );
  }
  return {
    equitySol: equity,
    openPositions: positions.length,
    realizedPnlSol: realized,
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

    $('toggle').textContent = settings.overlayEnabled !== false
      ? 'Disable overlay'
      : 'Enable overlay';

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
  // Try to flip the active tab's master overlay switch. If the content script
  // is not running, update storage directly so the next page load respects it.
  if (tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'pt_toggle_overlay' });
      window.close();
      return;
    } catch (_) {}
  }
  const stored = await chrome.storage.local.get(['pt_settings']);
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  const newSettings = { ...settings, overlayEnabled: !settings.overlayEnabled };
  await chrome.storage.local.set({ pt_settings: newSettings });
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  // D-30: the button label ("Enable overlay"/"Disable overlay") is rendered
  // by load() from stored settings; without re-running it the label kept
  // describing the state this click just flipped away from.
  await load();
  $('status').textContent = tab
    ? 'Updated — the overlay will respond once you reload this page.'
    : 'Updated.';
}

/** Chromeless window sized for the card layout — OBS window-captures it. */
function openStreamOverlay() {
  chrome.windows.create({
    url: chrome.runtime.getURL('overlay.html'),
    type: 'popup',
    width: 440,
    height: 560,
  });
  window.close();
}

async function resetWallet() {
  if (!confirm('Reset the paper wallet and erase positions, trade history, frames, and session replays?')) return;
  const stored = await chrome.storage.local.get(['pt_settings', 'pt_state']);
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  // Inherit the current seq: a reset written at seq 0 looks OLDER than the
  // state a still-open trading tab holds, and its next heartbeat write
  // resurrects the pre-reset wallet.
  const baseSeq = (stored.pt_state && Number(stored.pt_state.seq)) || 0;
  const fresh = freshState(settings);
  fresh.seq = baseSeq + 1;
  await chrome.storage.local.set({
    pt_state: fresh,
    pt_frames: [],
    pt_replays: [],
  });
  // The confirm text promises recordings are erased too; the background owns
  // the IndexedDB store (DEFECT D-36).
  chrome.runtime.sendMessage({ type: 'pt_clear_recordings' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  load();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------- backup / restore -------------------------
 * Unpacked extensions key their data by install folder. Re-downloading a
 * release into a NEW folder therefore looks like a fresh install and the
 * wallet disappears. Backup/Restore makes that a two-click recovery: the
 * snapshot carries every storage key, versioned so future formats can be
 * migrated on import.
 */
const BACKUP_KEYS = ['pt_state', 'pt_settings', 'pt_frames', 'pt_replays'];

async function backupWallet() {
  const stored = await chrome.storage.local.get(BACKUP_KEYS);
  const backup = {
    app: 'papertrench-backup',
    format: 1,
    exportedAt: new Date().toISOString(),
    data: stored,
  };
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `papertrench-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  // DEFECT D-41: screen recordings live in IndexedDB (tens of MB) and are
  // deliberately NOT exported. The status line must say so — silently
  // implying "everything is in the file" is an overpromise the user only
  // discovers after the original machine is gone.
  $('status').textContent = 'Backup downloaded — note that screen recordings stay on this machine and are not in the file.';
}

async function restoreWallet(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = ''; // allow re-selecting the same file later
  if (!file) return;
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch (_) {
    $('status').textContent = 'That file is not valid JSON.';
    return;
  }
  // Accept both the versioned envelope and a bare {pt_state, ...} snapshot,
  // but refuse anything that does not look like our own export.
  const data = backup && backup.app === 'papertrench-backup' ? backup.data : backup;
  if (!data || typeof data !== 'object' || !data.pt_state || typeof data.pt_state !== 'object') {
    $('status').textContent = 'Not a PaperTrench backup — nothing was restored.';
    return;
  }
  const rounds = Array.isArray(data.pt_state.rounds) ? data.pt_state.rounds.length : 0;
  if (!confirm(`Restore this backup? It replaces your current wallet (${rounds} closed rounds in the backup).`)) return;
  const write = {};
  for (const key of BACKUP_KEYS) if (data[key] !== undefined) write[key] = data[key];
  // The backup's own seq is meaningless in this browser: any open trading tab
  // holding a higher write counter would treat the restored wallet as stale
  // and overwrite it on its next heartbeat — resurrecting the wallet the user
  // just replaced. Land the restore strictly ahead of everything alive, the
  // same way resetWallet does.
  const current = await chrome.storage.local.get(['pt_state']);
  const liveSeq = Number(current.pt_state && current.pt_state.seq) || 0;
  const backupSeq = Number(write.pt_state.seq) || 0;
  write.pt_state.seq = Math.max(liveSeq, backupSeq) + 1;
  await chrome.storage.local.set(write);
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  $('status').textContent = 'Backup restored.';
  load();
}

load();
