/* PaperTrench — background service worker.
 *
 * Responsibilities:
 *  - Open the dashboard.
 *  - Proxy AI chat calls to a user-configured OpenAI-compatible endpoint.
 *  - Orchestrate optional recording and frame capture.
 *  - Record session replays linking fills, frames, and screen recordings.
 */


if (typeof importScripts === 'function') {
  importScripts('replay.js', 'quote.js', 'resolver.js', 'onchain.js', 'rpc-pool.js', 'onchain-feed.js');
}
const RP = self.PTReplay;
const R = self.PaperTrenchResolver;
const FEED = self.PTOnchainFeed;

const DEFAULTS = {
  balanceStartSol: 10,
  presetsBuy: [0.1, 0.5, 1, 2],
  sellPcts: [25, 50, 75, 100],
  panelBuyEnabled: true,
  panelPresetsEnabled: true,
  feeBps: 100,
  slippageBps: 0,
  recordingEnabled: false,
  framesEnabled: true,
  autoReview: false,
  overlayEnabled: true,
  overlayHideWhenNoToken: true,
  overlayWidth: null,
  overlayHeight: null,
  tradeEffectsEnabled: true,
  tradeSoundsEnabled: true,
  profitAlertsEnabled: false,
  profitAlertPct: 10,
  averagePriceLinesEnabled: true,
  positionsBarEnabled: true,
  settingsRevision: 5,
  aiEndpoint: '',
  aiModel: '',
  aiApiKey: '',
  aiAllowLocalEndpoint: false,
};

const FRAME_CAP = 80;
const FRAME_INTERVAL_MS = 30_000;
let frameInterval = null;
let recActive = false;
let replayMutation = Promise.resolve();

const OLD_LOCAL_AI_ENDPOINT = 'http://127.0.0.1:8765/v1';

function migrateBackgroundSettings(settings) {
  const revision = Number(settings.settingsRevision) || 0;
  if (revision < 4) {
    // The default AI endpoint used to point at a local BYOK shim. Treat an
    // unchanged install as empty so the new validator does not immediately
    // block it, and require an explicit opt-in before local/private endpoints
    // are reachable from the background script.
    if (settings.aiEndpoint === OLD_LOCAL_AI_ENDPOINT) {
      settings.aiEndpoint = '';
    }
    settings.aiAllowLocalEndpoint = false;
    settings.settingsRevision = 4;
  }
  return settings;
}

function getSettings() {
  return new Promise((resolve) =>
    chrome.storage.local.get(['pt_settings'], (value) => resolve(migrateBackgroundSettings({ ...DEFAULTS, ...(value.pt_settings || {}) })))
  );
}

function getState() {
  return new Promise((resolve) => chrome.storage.local.get(['pt_state'], (value) => resolve(value.pt_state || null)));
}

function setState(state) {
  return new Promise((resolve) => chrome.storage.local.set({ pt_state: state }, resolve));
}

function getReplays() {
  return new Promise((resolve) => chrome.storage.local.get([RP.STORAGE_KEY], (value) => {
    resolve(RP.normalizeReplayList(value[RP.STORAGE_KEY]));
  }));
}

function setReplays(replays) {
  return new Promise((resolve) => chrome.storage.local.set({ [RP.STORAGE_KEY]: replays }, resolve));
}

function openDashboard() {
  chrome.runtime.openOptionsPage();
}

/* -------------------- recording orchestration -------------------- */

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DISPLAY_MEDIA'],
    justification: 'Record the trading tab while a paper position is open (user-enabled).',
  });
}

async function startRecording(tabId, symbol) {
  if (recActive) return;
  try {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({ type: 'recorder.begin', symbol });
    recActive = !!(response && response.active);
  } catch (error) {
    recActive = false;
    console.warn('recorder begin failed:', error.message);
  }
  broadcastRecStatus();
}

async function stopRecording(roundId) {
  let result = null;
  try {
    result = await chrome.runtime.sendMessage({ type: 'recorder.stop', roundId });
  } catch (error) {
    console.warn('recorder stop failed:', error.message);
  }
  recActive = false;
  broadcastRecStatus();

  const file = result && result.file ? result.file : null;
  if (file && roundId) {
    const state = await getState();
    if (state && Array.isArray(state.rounds)) {
      const round = state.rounds.find((item) => item.id === roundId);
      if (round) {
        round.recordingFile = file;
        // Recorded to IndexedDB, so the dashboard can play the video back
        // instead of falling back to still frames.
        round.recording = result.stored ? {
          id: roundId,
          file,
          startedAt: Number(result.startedAt) || 0,
          endedAt: Number(result.endedAt) || 0,
          size: Number(result.size) || 0,
        } : null;
        await setState(state);
      }
    }
  }
  return file;
}

function broadcastRecStatus() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'pt_rec_status', active: recActive }).catch(() => {});
    }
  });
}

/* -------------------- frame snapshots -------------------- */

async function snapFrame(kind, sessionValue) {
  const settings = await getSettings();
  if (!settings.framesEnabled) return;
  const session = sessionValue ? RP.normalizeSession(sessionValue) : null;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'jpeg', quality: 45 });
    const small = await downscaleDataUrl(dataUrl, 480);
    const { pt_frames = [] } = await chrome.storage.local.get(['pt_frames']);
    pt_frames.push({
      t: Date.now(),
      kind,
      sessionId: session?.sessionId || null,
      roundId: session?.roundId || null,
      symbol: session?.symbol || null,
      mint: session?.mint || null,
      dataUrl: small,
    });
    while (pt_frames.length > FRAME_CAP) pt_frames.shift();
    await chrome.storage.local.set({ pt_frames });
  } catch (error) {
    console.warn('frame capture failed:', error.message);
  }
}

async function downscaleDataUrl(dataUrl, width) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = width / bitmap.width;
    const canvas = new OffscreenCanvas(width, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const output = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.55 });
    const buffer = new Uint8Array(await output.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < buffer.length; index += chunk) {
      binary += String.fromCharCode.apply(null, buffer.subarray(index, index + chunk));
    }
    return 'data:image/jpeg;base64,' + btoa(binary);
  } catch (_) {
    return dataUrl;
  }
}

async function openPositions() {
  const state = await getState();
  return state && state.positions ? Object.values(state.positions) : [];
}

async function refreshFrameInterval() {
  const positions = await openPositions();
  const settings = await getSettings();
  if (positions.length && settings.framesEnabled && !frameInterval) {
    frameInterval = setInterval(async () => {
      const current = await openPositions();
      if (current[0]) await snapFrame('interval', current[0]);
    }, FRAME_INTERVAL_MS);
  } else if ((!positions.length || !settings.framesEnabled) && frameInterval) {
    clearInterval(frameInterval);
    frameInterval = null;
  }
}

/* -------------------- session replay bookkeeping -------------------- */

/**
 * Record the replay record for a paper session.
 *
 * This is pure local bookkeeping: it links a round's fills, chart frames, and
 * screen recording under one session id so the dashboard can play the trade
 * back. No network calls are involved.
 */
function recordReplay(sessionValue, roundValue = null) {
  const session = RP.normalizeSession(sessionValue || roundValue || {});
  replayMutation = replayMutation.catch(() => {}).then(async () => {
    if (!session.mint) return { skipped: true };
    let replays = await getReplays();
    try {
      if (roundValue) ({ replays } = RP.closeReplay(replays, session, roundValue));
      else ({ replays } = RP.upsertReplay(replays, session));
      await setReplays(replays);
      return { ok: true };
    } catch (error) {
      ({ replays } = RP.addReplayError(replays, session, error));
      await setReplays(replays);
      return { error: error.message };
    }
  });
  return replayMutation;
}

/* -------------------- AI proxy -------------------- */

function isForbiddenIPv4(a, b, c, d, allowLocal) {
  if (a === 0) return true;                                 // 0.0.0.0/8
  if (a === 10) return !allowLocal;                         // 10.0.0.0/8
  if (a === 127) return !allowLocal;                        // 127.0.0.0/8
  if (a === 169 && b === 254) return true;                  // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return !allowLocal;  // 172.16.0.0/12
  if (a === 192 && b === 168) return !allowLocal;           // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return !allowLocal; // 100.64.0.0/10 CGNAT
  if ((a === 192 && b === 0 && c === 0) ||                  // 192.0.0.0/24
      (a === 192 && b === 0 && c === 2) ||                  // 192.0.2.0/24 TEST-NET-1
      (a === 198 && b === 51 && c === 100) ||               // 198.51.100.0/24 TEST-NET-2
      (a === 203 && b === 0 && c === 113) ||                // 203.0.113.0/24 TEST-NET-3
      (a === 198 && (b === 18 || b === 19))) {             // 198.18.0.0/15 benchmark
    return !allowLocal;
  }
  if (a >= 224 && a <= 239) return true;                    // 224.0.0.0/4 multicast
  if (a >= 240) return true;                                // 240.0.0.0/4 + 255.255.255.255
  return false;
}

function isForbiddenIPv6(ip, allowLocal) {
  // The unspecified address resolves to loopback on many systems; block it
  // unconditionally just like 0.0.0.0/8.
  if (ip === '::') return true;
  if (ip === '::1') return !allowLocal;
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:') || lower.startsWith('::ffff:0:')) {
    const rest = lower.replace(/^::ffff(:0)?:/, '');
    if (rest.includes('.')) {
      const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(rest);
      if (ipv4) return isForbiddenIPv4(Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4]), allowLocal);
    }
    const parts = rest.split(':').filter(Boolean);
    if (parts.length) {
      const lastTwo = parts.slice(-2);
      const high = parseInt(lastTwo[0] || '0', 16);
      const low = parseInt(lastTwo[1] || '0', 16);
      return isForbiddenIPv4((high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255, allowLocal);
    }
  }
  if (/^fe[89ab][0-9a-f]{0,2}:/i.test(ip) || /^fe[89ab][0-9a-f]{0,2}$/i.test(ip)) return true;    // fe80::/10 link-local
  if (/^f[c-d][0-9a-f]{0,2}:/i.test(ip) || /^f[c-d][0-9a-f]{0,2}$/i.test(ip)) return !allowLocal;   // fc00::/7 unique local
  if (/^fe[c-f][0-9a-f]{0,2}:/i.test(ip) || /^fe[c-f][0-9a-f]{0,2}$/i.test(ip)) return !allowLocal; // fec0::/10 site-local (deprecated)
  if (/^ff[0-9a-f]{0,2}:/i.test(ip) || /^ff[0-9a-f]{0,2}$/i.test(ip)) return true;                  // ff00::/8 multicast
  return false;
}

function isForbiddenHost(host, allowLocal) {
  // Strip an optional trailing dot (FQDN form) so "localhost." is treated the
  // same as "localhost" by the literal and IP checks.
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower === 'localhost.localdomain' || lower.endsWith('.localhost')) {
    return !allowLocal;
  }
  if (lower.includes(':')) {
    const ip = lower.replace(/^\[|\]$/g, '');
    return isForbiddenIPv6(ip, allowLocal);
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (ipv4) {
    return isForbiddenIPv4(Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4]), allowLocal);
  }
  return false;
}

function isAllowedEndpoint(url, allowLocal = false) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return !isForbiddenHost(parsed.hostname, allowLocal);
  } catch (_) {
    return false;
  }
}

async function aiChat({ messages, maxTokens }) {
  const settings = await getSettings();
  const endpoint = (settings.aiEndpoint || '').replace(/\/+$/, '');
  if (!endpoint) return { error: 'No AI endpoint configured (open the dashboard → Settings)' };
  if (!isAllowedEndpoint(endpoint, settings.aiAllowLocalEndpoint)) {
    return { error: 'AI endpoint URL is not allowed. Enable local/private endpoints in Settings if you run a self-hosted endpoint, otherwise use a public endpoint.' };
  }
  const body = {
    model: settings.aiModel || 'default',
    messages,
    temperature: 0.3,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  try {
    const response = await fetch(endpoint + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.aiApiKey ? { Authorization: 'Bearer ' + settings.aiApiKey } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
    });
    if (!response.ok) return { error: `AI endpoint returned ${response.status}` };
    const json = await response.json();
    return { reply: json?.choices?.[0]?.message?.content || '' };
  } catch (error) {
    return { error: 'AI request failed: ' + error.message };
  }
}


async function aiModels() {
  const settings = await getSettings();
  const endpoint = (settings.aiEndpoint || '').replace(/\/+$/, '');
  if (!endpoint) return { models: [] };
  if (!isAllowedEndpoint(endpoint, settings.aiAllowLocalEndpoint)) {
    return { models: [], error: 'AI endpoint URL is not allowed. Enable local/private endpoints in Settings if you run a self-hosted endpoint, otherwise use a public endpoint.' };
  }
  try {
    const response = await fetch(endpoint + '/models', {
      headers: settings.aiApiKey ? { Authorization: 'Bearer ' + settings.aiApiKey } : {},
      redirect: 'error',
    });
    if (!response.ok) return { models: [] };
    const json = await response.json();
    return { models: (json.data || []).map((model) => model.id).filter(Boolean) };
  } catch (error) {
    return { models: [], error: error.message };
  }
}

async function autoReview(roundId) {
  const state = await getState();
  if (!state) return;
  const round = (state.rounds || []).find((item) => item.id === roundId);
  if (!round) return;
  const trades = (state.journal || []).filter((trade) => round.tradeIds.includes(trade.id));
  const prompt = buildRoundReviewPrompt(round, trades);
  const { reply, error } = await aiChat({ messages: prompt, maxTokens: 1800 });
  round.aiReview = {
    t: Date.now(),
    text: reply || ('AI review failed: ' + error),
    ok: !error,
  };
  await setState(state);
}

function buildRoundReviewPrompt(round, trades) {
  const lines = trades
    .sort((a, b) => a.ts - b.ts)
    .map((trade) => `${new Date(trade.ts).toISOString()} ${trade.side.toUpperCase()} ${trade.qty.toFixed(4)} ${trade.symbol} @ ${trade.priceNative} SOL (gross ${trade.solGross.toFixed(3)} SOL${trade.pnlSol !== undefined ? `, realized ${trade.pnlSol >= 0 ? '+' : ''}${trade.pnlSol.toFixed(4)}` : ''})`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You are a brutally honest but constructive Solana memecoin trading coach. Review this paper-trade round trip. Analyze entries, exits, sizing, and hold time against the P&L path, and name specific bad habits if present. Be concrete and short.',
    },
    {
      role: 'user',
      content:
        `Round trip on ${round.symbol} (${round.mint})\n` +
        `Opened: ${new Date(round.openedAt).toISOString()}  Closed: ${new Date(round.closedAt).toISOString()}  Held: ${(round.heldMs / 60000).toFixed(1)} min\n` +
        `Invested: ${round.investedSol.toFixed(4)} SOL  Returned: ${round.returnedSol.toFixed(4)} SOL\n` +
        `P&L: ${round.pnlSol >= 0 ? '+' : ''}${round.pnlSol.toFixed(4)} SOL (${round.pnlPct.toFixed(1)}%)\n` +
        `Peak unrealized P&L: +${round.peakPnlSol.toFixed(4)} SOL   Worst: ${round.troughPnlSol.toFixed(4)} SOL\n\n` +
        `Fills:\n${lines}` +
        '\n\nGive: (1) verdict, (2) what was done right, (3) what was done wrong, (4) one bad habit, and (5) one concrete fix for next time.',
    },
  ];
}

/* -------------------- message routing -------------------- */

const BASE58_RE = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/;
const MAX_MINTS_PER_BATCH = 100;

function isSolanaAddress(s) {
  return typeof s === 'string' && BASE58_RE.test(s);
}

function sanitizeMints(list) {
  if (!Array.isArray(list)) return null;
  const clean = list.filter(isSolanaAddress);
  return clean.length ? clean.slice(0, MAX_MINTS_PER_BATCH) : null;
}

function isValidTokenForRefresh(t) {
  if (!t || typeof t !== 'object') return false;
  if (!isSolanaAddress(t.mint)) return false;
  if (t.pairAddress && !isSolanaAddress(t.pairAddress)) return false;
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  (async () => {
    const settings = await getSettings();
    switch (message.type) {
      case 'pt_open_dashboard':
        openDashboard();
        sendResponse({ ok: true });
        break;

      case 'pt_trade_event': {
        const session = RP.normalizeSession(message.session || message.round || {});
        if (message.opened && settings.recordingEnabled) await startRecording(sender.tab?.id, session.symbol);
        await snapFrame(message.kind || message.trade?.side || 'fill', session);
        if (message.round && settings.recordingEnabled) await stopRecording(message.round.id);
        await recordReplay(session, message.round || null);
        await refreshFrameInterval();
        if (message.round && settings.autoReview && message.round.id) {
          autoReview(message.round.id).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      // Compatibility with PaperTrench 0.4 content scripts still alive in an
      // already-open tab while the extension service worker updates.
      case 'pt_round_opened': {
        const session = RP.normalizeSession(message.session || {
          mint: message.mint,
          symbol: message.symbol,
          openedAt: Date.now(),
        });
        if (settings.recordingEnabled) await startRecording(sender.tab?.id, session.symbol);
        await snapFrame('buy', session);
        await recordReplay(session);
        await refreshFrameInterval();
        sendResponse({ ok: true });
        break;
      }

      case 'pt_round_closed': {
        const session = RP.normalizeSession(message.session || message.round || {});
        if (settings.recordingEnabled) await stopRecording(message.round?.id);
        await snapFrame('sell', session);
        await recordReplay(session, message.round || null);
        await refreshFrameInterval();
        if (settings.autoReview && message.round?.id) autoReview(message.round.id).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case 'pt_snap_frame': {
        await snapFrame(message.kind || 'fill', message.session || message);
        await refreshFrameInterval();
        sendResponse({ ok: true });
        break;
      }



      case 'pt_settings_changed':
        await refreshFrameInterval();
        sendResponse({ ok: true });
        break;

      case 'pt_ai_chat':
        sendResponse(await aiChat({ messages: message.messages, maxTokens: message.maxTokens }));
        break;

      case 'pt_ai_models':
        sendResponse(await aiModels());
        break;

      case 'pt_rec_query':
        sendResponse({ active: recActive });
        break;

      case 'pt_recording_toggle':
        if (!message.enabled && recActive) await stopRecording(null);
        sendResponse({ ok: true });
        break;

      // Price resolution is done from the service worker so it is not subject to
      // the page origin's CORS or CSP. The content script supplies only mints
      // and addresses; the background decides which public APIs to call.
      case 'pt_resolve':
        if (!isSolanaAddress(message.address)) { sendResponse(null); break; }
        try { sendResponse(await R.resolve(message.address)); } catch (e) { sendResponse(null); }
        break;

      case 'pt_sol_usd':
        try { sendResponse(await R.solUsd()); } catch (e) { sendResponse(0); }
        break;

      case 'pt_refresh':
        if (!isValidTokenForRefresh(message.token)) { sendResponse(null); break; }
        try { sendResponse(await R.refresh(message.token)); } catch (e) { sendResponse(null); }
        break;

      case 'pt_batch_prices': {
        const mints = sanitizeMints(message.mints);
        if (!mints) { sendResponse({}); break; }
        try { sendResponse(await R.batchPrices(mints)); } catch (e) { sendResponse({}); }
        break;
      }

      // Begin streaming live pool state for the token on screen. Prices then
      // arrive from chain state at `processed` commitment instead of from an
      // aggregator running ~2-3s behind.
      case 'pt_onchain_watch': {
        if (!FEED || !isSolanaAddress(message.mint) || !isSolanaAddress(message.pool)) {
          sendResponse({ live: false });
          break;
        }
        try {
          // An empty rpcUrl is the normal case: the keyless public pool.
          const settings = await getSettings();
          FEED.configure({ rpcUrl: settings.rpcUrl || null });
          sendResponse({ live: await FEED.watch(message.mint, message.pool) });
        } catch (e) { sendResponse({ live: false }); }
        break;
      }

      case 'pt_onchain_unwatch':
        if (FEED && isSolanaAddress(message.mint)) FEED.unwatch(message.mint);
        sendResponse({ ok: true });
        break;

      // The authoritative price at click time. Null means no fresh on-chain
      // observation exists, and the caller must not invent one.
      case 'pt_onchain_quote':
        if (!FEED || !isSolanaAddress(message.mint)) { sendResponse(null); break; }
        sendResponse(FEED.currentQuote(message.mint));
        break;

      default:
        sendResponse({ error: 'unknown message type' });
    }
  })().catch((error) => sendResponse({ error: error.message }));

  return true;
});

chrome.runtime.onStartup.addListener(() => {
  refreshFrameInterval().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  refreshFrameInterval().catch(() => {});
});
refreshFrameInterval().catch(() => {});
