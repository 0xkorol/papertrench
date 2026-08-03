/* PaperTrench — portfolio engine.
 *
 * Pure functions over a serializable state object. No DOM, no chrome APIs —
 * the content script and the dashboard both load this and drive it with
 * storage reads/writes.
 *
 * All prices in SOL (priceNative). USD values are derived per-trade with the
 * priceUsd captured at that moment.
 */
(() => {
  'use strict';

  const STORAGE_KEYS = {
    state: 'pt_state',
    settings: 'pt_settings',
    frames: 'pt_frames',
    replays: 'pt_replays',
  };
  const EPS = 1e-9;

  const DEFAULT_SETTINGS = {
    balanceStartSol: 10,
    presetsBuy: [0.1, 0.5, 1, 2],
    sellPcts: [25, 50, 75, 100],
    // One-click trading: a preset amount fires the buy immediately (Axiom /
    // Padre quick-buy behaviour) instead of only selecting it for the BUY
    // button. Off returns to the two-step select-then-confirm flow.
    instantBuyEnabled: true,
    // Paper quick-buy chip on every token row of the screener pages (Axiom
    // Pulse, Padre/GMGN Trenches), so a position can be opened without
    // loading the chart first. Fills at the first preset amount.
    listQuickBuyEnabled: true,
    // Scale factor for the screener row quick-buy chip. 1.0 is the default
    // compact size; users can make it larger on dense trench/pulse screens.
    listQuickBuySize: 1.0,
    // Master switch for the buy controls in the trade tab (presets, custom
    // amount, BUY button). Off makes the panel view-only for people who
    // never buy from the overlay.
    panelBuyEnabled: true,
    // The one-tap preset amount row inside the buy section. Can be hidden
    // on its own so traders who always type a custom amount keep the BUY
    // button.
    panelPresetsEnabled: true,
    feeBps: 100,          // 1% per side, roughly Padre/Axiom territory
    slippageBps: 0,       // extra simulated slippage, 0 = fill at tick price
    recordingEnabled: false,
    framesEnabled: true,  // capture page screenshots for the AI coach
    autoReview: false,    // auto-run AI review when a round trip closes
    overlayEnabled: true,
    // Hide the overlay on pages where no token is detected (e.g., a project's
    // home page or a screener without a selected token). It pops back the
    // moment the user opens a coin page.
    overlayHideWhenNoToken: true,
    // Last user-resized width/height of the trade tab, in pixels. null means
    // use the CSS default (336px by content height).
    overlayWidth: null,
    overlayHeight: null,
    // Feedback features. On by default so a fill is unmistakable; every one
    // of them can be switched off individually in Settings.
    tradeEffectsEnabled: true,
    tradeSoundsEnabled: true,
    profitAlertsEnabled: false,
    profitAlertPct: 10,
    averagePriceLinesEnabled: true,
    settingsRevision: 4,
    // Padre-style top rail listing every open paper position.
    positionsBarEnabled: true,
    // Saved left/top offsets for the draggable positions bar. null means the
    // bar should auto-measure against the host site header on first paint.
    positionsBarLeft: null,
    positionsBarTop: null,
    // Whether the positions bar is collapsed into its small POSITIONS tab.
    // Saved so "hide it once" sticks across pages, tabs and sessions instead
    // of the bar reappearing on every new page — the "it follows me
    // everywhere" complaint.
    positionsBarHidden: false,
    // AI backend (OpenAI-compatible). Empty by default; the user must set a
    // public endpoint or opt-in to local/private endpoints below.
    aiEndpoint: '',
    aiModel: '',
    aiApiKey: '',
    aiAllowLocalEndpoint: false,
    // Optional private Solana RPC. Empty means "use the built-in keyless
    // public pool", which is the default and needs no signup from anyone.
    // Public RPC limits are per IP, so the pool scales across every install.
    // Power users can paste their own endpoint here for extra headroom.
    rpcUrl: '',
  };

  function defaultSettings() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  // Bumped when a default changes in a way existing users should receive.
  // Stored settings normally win over defaults, so without this a user who
  // installed before the change would keep the old value forever.
  const SETTINGS_REVISION = 6;

  /**
   * Merge stored settings over defaults, applying one-time migrations.
   *
   * Revision 2 turned trade effects, sounds, and average price lines on. Those
   * were previously off by default, so an existing install has `false` saved
   * for them — not because the user chose it, but because that was the default.
   * The migration adopts the new defaults ONCE and records that it ran, so a
   * deliberate opt-out afterwards is never overridden.
   *
   * Revision 3 starts hiding the overlay on pages without a detected token.
   *
   * Revision 4 removes the insecure default local AI endpoint and adds an
   * explicit opt-in for local/private AI endpoints. Existing installs that still
   * carry the old default have it cleared, and local/private access defaults off.
   *
   * Revision 5 adds the trade-tab buy toggles (whole buy section, and the
   * preset row on its own), both on by default.
   *
   * Revision 6 persists the positions bar's collapsed/expanded state, so
   * hiding it once keeps it hidden everywhere.
   */
  const OLD_LOCAL_AI_ENDPOINT = 'http://127.0.0.1:8765/v1';
  function mergeSettings(stored) {
    const merged = Object.assign(defaultSettings(), stored || {});
    if (!stored) return merged;

    const revision = Number(stored.settingsRevision) || 0;
    if (revision < 2) {
      merged.tradeEffectsEnabled = DEFAULT_SETTINGS.tradeEffectsEnabled;
      merged.tradeSoundsEnabled = DEFAULT_SETTINGS.tradeSoundsEnabled;
      merged.averagePriceLinesEnabled = DEFAULT_SETTINGS.averagePriceLinesEnabled;
    }
    if (revision < 3) {
      merged.overlayHideWhenNoToken = DEFAULT_SETTINGS.overlayHideWhenNoToken;
    }
    if (revision < 4) {
      if (merged.aiEndpoint === OLD_LOCAL_AI_ENDPOINT) {
        merged.aiEndpoint = '';
      }
      merged.aiAllowLocalEndpoint = false;
    }
    if (revision < 5) {
      merged.panelBuyEnabled = DEFAULT_SETTINGS.panelBuyEnabled;
      merged.panelPresetsEnabled = DEFAULT_SETTINGS.panelPresetsEnabled;
    }
    if (revision < 6) {
      merged.positionsBarHidden = DEFAULT_SETTINGS.positionsBarHidden;
    }
    merged.settingsRevision = SETTINGS_REVISION;
    return merged;
  }

  function defaultState(settings = DEFAULT_SETTINGS) {
    return {
      version: 1,
      // Monotonic write counter bumped by the content script on every state
      // write. A fresh wallet starts at 0; a writer holding an older seq can
      // tell it has been overtaken and adopt instead of clobber.
      seq: 0,
      cashSol: settings.balanceStartSol,
      startedAt: Date.now(),
      positions: {},   // mint -> position
      rounds: [],      // closed round trips, newest first
      journal: [],     // every fill, newest first
      stats: { totalBuys: 0, totalSells: 0, realizedPnlSol: 0, feesPaidSol: 0 },
    };
  }

  /* ---------------- price helpers ---------------- */

  function applyBps(x, bps) { return x * (bps || 0) / 10000; }

  /** Effective buy price including simulated slippage. */
  function buyPrice(px, settings) { return px * (1 + applyBps(1, settings.slippageBps)); }
  /** Effective sell price including simulated slippage. */
  function sellPrice(px, settings) { return px * (1 - applyBps(1, settings.slippageBps)); }

  /* ---------------- fills ---------------- */

  function getPosition(state, mint) {
    return state.positions[mint] || null;
  }

  /**
   * Buy `solAmount` gross SOL of the token. Returns {trade, state} or throws.
   */
  function buy(state, settings, o) {
    const sol = Number(o.solAmount);
    const px = buyPrice(Number(o.priceNative), settings);
    if (!(sol > 0)) throw new Error('Buy amount must be > 0 SOL');
    if (!(px > 0)) throw new Error('No live price available');
    if (sol > state.cashSol + EPS) throw new Error(`Insufficient paper balance (${fmt(state.cashSol)} SOL left)`);

    const fee = applyBps(sol, settings.feeBps);
    const net = sol - fee;
    const qty = net / px;

    let pos = state.positions[o.mint];
    if (!pos) {
      pos = state.positions[o.mint] = {
        mint: o.mint,
        symbol: o.symbol || short(o.mint),
        name: o.name || o.symbol || '',
        site: o.site || 'unknown',
        pairAddress: o.pairAddress || null,
        sessionId: replaySessionId(o.mint, o.ts),
        thesis: null,
        qty: 0,
        costSol: 0,          // net SOL spent on the open stack
        investedSol: 0,      // gross SOL spent (incl. fees) on this round
        peakPnlSol: 0,
        troughPnlSol: 0,
        openedAt: o.ts,
        lastPriceNative: px,
        lastPriceUsd: o.priceUsd || null,
      };
    }
    // Upgrade a legacy open position in place so replays can still be attached
    // after the extension updates from an older version.
    if (!pos.sessionId) pos.sessionId = replaySessionId(pos.mint, pos.openedAt || o.ts);

    pos.qty += qty;
    pos.costSol += net;
    pos.investedSol += sol;
    pos.lastPriceNative = px;
    pos.lastPriceUsd = o.priceUsd || pos.lastPriceUsd;

    state.cashSol -= sol;
    state.stats.totalBuys += 1;
    state.stats.feesPaidSol += fee;

    const trade = {
      id: tradeId(o.ts),
      ts: o.ts,
      site: o.site || pos.site,
      mint: o.mint,
      symbol: pos.symbol,
      sessionId: pos.sessionId,
      side: 'buy',
      qty,
      priceNative: px,
      priceUsd: o.priceUsd || null,
      solGross: sol,
      feeSol: fee,
      solNet: net,
      mcap: o.mcap || null,
    };
    state.journal.unshift(trade);
    pruneJournal(state);
    return { trade, position: pos };
  }

  /**
   * Sell `qtyFraction` (0..1) of the current position. Returns {trade, state}.
   * Closing the whole stack also closes the round trip and appends to rounds.
   */
  function sell(state, settings, o) {
    const pos = state.positions[o.mint];
    if (!pos || pos.qty <= EPS) throw new Error('No open paper position in this token');
    if (!pos.sessionId) pos.sessionId = replaySessionId(pos.mint, pos.openedAt || o.ts);

    let qty = Number(o.qty);
    if (!(qty > 0)) {
      const frac = clamp(Number(o.qtyFraction), 0, 1);
      qty = pos.qty * frac;
    }
    qty = Math.min(qty, pos.qty);
    if (qty <= EPS) throw new Error('Sell quantity is zero');

    const px = sellPrice(Number(o.priceNative), settings);
    if (!(px > 0)) throw new Error('No live price available');

    const gross = qty * px;
    const fee = applyBps(gross, settings.feeBps);
    const net = gross - fee;

    const costShare = pos.costSol * (qty / pos.qty);
    const pnl = net - costShare;

    pos.qty -= qty;
    pos.costSol -= costShare;
    pos.lastPriceNative = px;
    pos.lastPriceUsd = o.priceUsd || pos.lastPriceUsd;

    state.cashSol += net;
    state.stats.totalSells += 1;
    state.stats.feesPaidSol += fee;
    state.stats.realizedPnlSol += pnl;

    const trade = {
      id: tradeId(o.ts),
      ts: o.ts,
      site: o.site || pos.site,
      mint: o.mint,
      symbol: pos.symbol,
      sessionId: pos.sessionId,
      side: 'sell',
      qty,
      priceNative: px,
      priceUsd: o.priceUsd || null,
      solGross: gross,
      feeSol: fee,
      solNet: net,
      pnlSol: pnl,
      mcap: o.mcap || null,
    };
    state.journal.unshift(trade);
    pruneJournal(state);

    let round = null;
    if (pos.qty <= Math.max(pos.investedSol, 1) * 1e-9 || pos.qty <= EPS) {
      round = closeRound(state, pos, o.ts);
      delete state.positions[o.mint];
    }
    return { trade, position: pos.qty > EPS ? pos : null, round };
  }

  function closeRound(state, pos, ts) {
    const sold = state.journal.filter((t) => t.mint === pos.mint && t.side === 'sell' && t.ts >= pos.openedAt);
    const returned = sold.reduce((s, t) => s + t.solNet, 0);
    const round = {
      id: 'r' + ts.toString(36) + Math.random().toString(36).slice(2, 7),
      mint: pos.mint,
      symbol: pos.symbol,
      name: pos.name || '',
      site: pos.site,
      pairAddress: pos.pairAddress || null,
      sessionId: pos.sessionId || replaySessionId(pos.mint, pos.openedAt),
      // Preserved with the result so the plan can be graded against what
      // actually happened.
      thesis: pos.thesis || null,
      openedAt: pos.openedAt,
      closedAt: ts,
      heldMs: ts - pos.openedAt,
      investedSol: pos.investedSol,
      returnedSol: returned,
      pnlSol: returned - pos.investedSol,
      pnlPct: pos.investedSol > 0 ? (returned / pos.investedSol - 1) * 100 : 0,
      peakPnlSol: pos.peakPnlSol,
      troughPnlSol: pos.troughPnlSol,
      tradeIds: state.journal.filter((t) => t.mint === pos.mint && t.ts >= pos.openedAt).map((t) => t.id),
      aiReview: null,
      recordingFile: null,
    };
    state.rounds.unshift(round);
    if (state.rounds.length > 500) state.rounds.length = 500;
    return round;
  }

  /* ---------------- marks / analytics ---------------- */

  /** Mark an open position to the latest tick. Tracks peak/trough P&L. */
  function markPosition(state, mint, priceNative, priceUsd) {
    const pos = state.positions[mint];
    if (!pos) return null;
    pos.lastPriceNative = priceNative;
    if (priceUsd) pos.lastPriceUsd = priceUsd;
    const unrealized = pos.qty * priceNative - pos.costSol;
    if (unrealized > pos.peakPnlSol) pos.peakPnlSol = unrealized;
    if (unrealized < pos.troughPnlSol) pos.troughPnlSol = unrealized;
    return { unrealized, pos };
  }

  function unrealizedPnl(pos) {
    return pos.qty * pos.lastPriceNative - pos.costSol;
  }

  function equitySol(state) {
    let eq = state.cashSol;
    for (const mint of Object.keys(state.positions)) {
      const p = state.positions[mint];
      eq += p.qty * (p.lastPriceNative || 0);
    }
    return eq;
  }

  function solUsdRate(state, settings) {
    for (const mint of Object.keys(state.positions)) {
      const p = state.positions[mint];
      if (p.lastPriceNative > 0 && p.lastPriceUsd > 0) return p.lastPriceUsd / p.lastPriceNative;
    }
    return null; // caller may override with live rate
  }

  function sessionStats(state, settings) {
    const wins = state.rounds.filter((r) => r.pnlSol > 0).length;
    const losses = state.rounds.filter((r) => r.pnlSol <= 0).length;
    const totalPnl = state.rounds.reduce((s, r) => s + r.pnlSol, 0);
    const eq = equitySol(state);
    return {
      rounds: state.rounds.length,
      wins,
      losses,
      winRate: state.rounds.length ? (wins / state.rounds.length) * 100 : null,
      realizedPnlSol: totalPnl,
      openPositions: Object.keys(state.positions).length,
      unrealizedSol: Object.values(state.positions).reduce((s, p) => s + unrealizedPnl(p), 0),
      equitySol: eq,
      equityVsStart: eq - settings.balanceStartSol,
      feesPaidSol: state.stats.feesPaidSol,
      trades: state.journal.length,
    };
  }

  /* ---------------- trade thesis ---------------- */

  const THESIS_MAX = 600;
  // A short, fixed vocabulary beats free text alone: it makes patterns
  // countable across many trades, which is the point of journaling.
  const THESIS_TAGS = [
    'narrative', 'volume-spike', 'chart-setup', 'insider-wallets',
    'social-buzz', 'dip-buy', 'momentum', 'fomo', 'revenge', 'gut',
  ];
  const THESIS_PLANS = ['scalp', 'swing', 'runner', 'scratch'];

  function clampText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  /**
   * Normalize a thesis written before a position is opened.
   *
   * Returns null when nothing meaningful was written, so an empty box never
   * becomes a fake journal entry.
   */
  function normalizeThesis(input, ts) {
    const raw = input && typeof input === 'object' ? input : { text: input };
    const text = clampText(raw.text, THESIS_MAX);
    const tags = Array.isArray(raw.tags)
      ? [...new Set(raw.tags.filter((tag) => THESIS_TAGS.includes(tag)))].slice(0, 6)
      : [];
    const plan = THESIS_PLANS.includes(raw.plan) ? raw.plan : null;
    const conviction = Number(raw.conviction);
    const target = Number(raw.targetPct);
    const stop = Number(raw.stopPct);

    if (!text && !tags.length && !plan) return null;

    return {
      text,
      tags,
      plan,
      conviction: conviction >= 1 && conviction <= 5 ? Math.round(conviction) : null,
      targetPct: target > 0 ? target : null,
      stopPct: stop > 0 ? stop : null,
      // Written BEFORE the outcome is known — that is what makes it evidence.
      at: Number(ts) || Date.now(),
    };
  }

  /** Attach a thesis to the open position for a mint. */
  function setThesis(state, mint, thesis, ts) {
    const position = state && state.positions && state.positions[mint];
    if (!position) return null;
    const normalized = normalizeThesis(thesis, ts);
    position.thesis = normalized;
    return normalized;
  }

  /**
   * Grade a completed round against the plan its thesis declared.
   *
   * This is the learning loop: it reports whether the exit respected the stated
   * target and stop, without pretending a profitable accident was good process.
   */
  function gradeThesis(round) {
    const thesis = round && round.thesis;
    if (!thesis) return null;

    const pnlPct = Number(round.pnlPct);
    const peakPct = Number(round.investedSol) > 0
      ? (Number(round.peakPnlSol) / Number(round.investedSol)) * 100
      : null;
    const troughPct = Number(round.investedSol) > 0
      ? (Number(round.troughPnlSol) / Number(round.investedSol)) * 100
      : null;

    const notes = [];
    let followedPlan = null;

    if (thesis.targetPct !== null) {
      if (pnlPct >= thesis.targetPct) {
        notes.push(`Hit the ${thesis.targetPct}% target.`);
        followedPlan = followedPlan === false ? false : true;
      } else if (peakPct !== null && peakPct >= thesis.targetPct) {
        notes.push(`Reached ${thesis.targetPct}% in-trade but exited at ${pnlPct.toFixed(1)}%.`);
        followedPlan = false;
      } else {
        notes.push(`Never reached the ${thesis.targetPct}% target.`);
      }
    }

    if (thesis.stopPct !== null) {
      if (troughPct !== null && troughPct <= -thesis.stopPct && pnlPct < -thesis.stopPct) {
        notes.push(`Held past the ${thesis.stopPct}% stop and closed at ${pnlPct.toFixed(1)}%.`);
        followedPlan = false;
      } else if (troughPct !== null && troughPct <= -thesis.stopPct) {
        notes.push(`Dipped through the ${thesis.stopPct}% stop but recovered before the exit.`);
      }
    }

    return {
      followedPlan,
      pnlPct,
      peakPct,
      troughPct,
      notes,
      // A win on a broken plan is still a process failure worth seeing.
      luckyWin: followedPlan === false && pnlPct > 0,
    };
  }

  /* ---------------- exit quality ---------------- */

  /**
   * How good was the exit, measured against what the trade actually offered?
   *
   * The single most common beginner pattern is selling far below the peak the
   * position reached, then buying the next thing. Peak and trough are recorded
   * live on every tick, so this compares the realized result against the best
   * and worst the position was ever worth — no hindsight data required.
   */
  function exitQuality(round) {
    if (!round) return null;
    const invested = Number(round.investedSol);
    if (!(invested > 0)) return null;

    const pnl = Number(round.pnlSol) || 0;
    const peak = Number(round.peakPnlSol) || 0;
    const trough = Number(round.troughPnlSol) || 0;

    // What fraction of the maximum available gain was actually captured?
    const captured = peak > 0 ? Math.max(0, Math.min(1, pnl / peak)) : null;
    const leftOnTable = peak > 0 ? Math.max(0, peak - pnl) : 0;

    let verdict;
    if (peak <= 0) {
      verdict = pnl >= 0 ? 'no-run' : 'never-worked';
    } else if (captured !== null && captured >= 0.8) {
      verdict = 'excellent';
    } else if (captured !== null && captured >= 0.5) {
      verdict = 'good';
    } else if (pnl > 0) {
      verdict = 'early';
    } else {
      verdict = 'round-tripped';
    }

    return {
      verdict,
      capturedPct: captured === null ? null : captured * 100,
      leftOnTableSol: leftOnTable,
      peakPct: (peak / invested) * 100,
      troughPct: (trough / invested) * 100,
      pnlPct: (pnl / invested) * 100,
      // A position that went green then closed red is the costliest habit.
      roundTripped: peak > 0 && pnl < 0,
    };
  }

  /** Session-wide exit discipline, so the pattern is visible across trades. */
  function exitStats(state) {
    const rounds = (state && state.rounds) || [];
    const graded = rounds.map(exitQuality).filter(Boolean);
    if (!graded.length) {
      return { count: 0, avgCapturedPct: null, leftOnTableSol: 0, roundTripped: 0, byVerdict: {} };
    }

    const withCapture = graded.filter((g) => g.capturedPct !== null);
    const byVerdict = {};
    for (const g of graded) byVerdict[g.verdict] = (byVerdict[g.verdict] || 0) + 1;

    return {
      count: graded.length,
      avgCapturedPct: withCapture.length
        ? withCapture.reduce((s, g) => s + g.capturedPct, 0) / withCapture.length
        : null,
      leftOnTableSol: graded.reduce((s, g) => s + g.leftOnTableSol, 0),
      roundTripped: graded.filter((g) => g.roundTripped).length,
      byVerdict,
    };
  }

  /**
   * Risk sizing: what fraction of the book went into a single trade?
   *
   * Oversizing is the fastest way a learning trader blows up, and it is
   * invisible without comparing position size to equity at entry.
   */
  function riskProfile(state, settings) {
    const rounds = (state && state.rounds) || [];
    if (!rounds.length) return { count: 0, avgSizePct: null, maxSizePct: null, oversized: 0 };

    const start = Number(settings && settings.balanceStartSol) || 0;
    if (!(start > 0)) return { count: 0, avgSizePct: null, maxSizePct: null, oversized: 0 };

    const sizes = rounds.map((r) => (Number(r.investedSol) || 0) / start * 100);
    return {
      count: sizes.length,
      avgSizePct: sizes.reduce((s, v) => s + v, 0) / sizes.length,
      maxSizePct: Math.max(...sizes),
      // A common rule of thumb: never risk more than a quarter of the book.
      oversized: sizes.filter((v) => v > 25).length,
    };
  }

  /** Aggregate thesis outcomes so recurring patterns become visible. */
  function thesisStats(state) {
    const rounds = (state && state.rounds) || [];
    const withThesis = rounds.filter((round) => round && round.thesis);
    const byTag = {};

    for (const round of withThesis) {
      for (const tag of round.thesis.tags || []) {
        const bucket = byTag[tag] || (byTag[tag] = { tag, count: 0, wins: 0, pnlSol: 0 });
        bucket.count += 1;
        if (Number(round.pnlSol) > 0) bucket.wins += 1;
        bucket.pnlSol += Number(round.pnlSol) || 0;
      }
    }

    const tags = Object.values(byTag)
      .map((bucket) => ({
        ...bucket,
        winRate: bucket.count ? (bucket.wins / bucket.count) * 100 : 0,
        avgPnlSol: bucket.count ? bucket.pnlSol / bucket.count : 0,
      }))
      .sort((a, b) => b.count - a.count || b.pnlSol - a.pnlSol);

    const graded = withThesis.map(gradeThesis).filter(Boolean);
    const followed = graded.filter((grade) => grade.followedPlan === true).length;
    const broken = graded.filter((grade) => grade.followedPlan === false).length;

    return {
      total: rounds.length,
      withThesis: withThesis.length,
      coverage: rounds.length ? (withThesis.length / rounds.length) * 100 : 0,
      followedPlan: followed,
      brokePlan: broken,
      luckyWins: graded.filter((grade) => grade.luckyWin).length,
      tags,
    };
  }

  /* ---------------- P&L calendar ----------------
   *
   * The daily performance view Axiom/Padre/GMGN popularized: a month grid
   * where each day shows the realized result of that day's trades. Their
   * backends bucket by the viewer's LOCAL day (Axiom passes the browser's
   * timezone offset to its API), so this does the same — days are local
   * calendar days, never UTC.
   *
   * Daily realized P&L is attributed per SELL (partial exits count on the
   * day they happen), which matches how those sites treat closes. Buys only
   * contribute counts and volume; they are not a result until closed.
   */

  /**
   * Build one month of calendar cells for the dashboard.
   *
   * @param {object} state portfolio state (journal + positions)
   * @param {number} year  full year, e.g. 2026
   * @param {number} month 0-based month index (Date convention)
   * @param {object} [opts] { now: ms } for deterministic tests
   */
  function pnlCalendar(state, year, month, opts) {
    const now = Number(opts && opts.now) || Date.now();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const days = [];
    for (let d = 1; d <= daysInMonth; d += 1) {
      days.push({
        day: d,
        hasTrades: false,
        realizedSol: 0,
        buys: 0,
        sells: 0,
        volumeBuySol: 0,
        volumeSellSol: 0,
        symbols: {},
      });
    }

    for (const t of (state && state.journal) || []) {
      const ts = Number(t.ts);
      if (!(ts > 0)) continue;
      const dt = new Date(ts);
      if (dt.getFullYear() !== year || dt.getMonth() !== month) continue;
      const cell = days[dt.getDate() - 1];
      cell.hasTrades = true;
      if (t.side === 'buy') {
        cell.buys += 1;
        cell.volumeBuySol += Number(t.solGross) || 0;
      } else if (t.side === 'sell') {
        cell.sells += 1;
        cell.volumeSellSol += Number(t.solGross) || 0;
        const pnl = Number(t.pnlSol) || 0;
        cell.realizedSol += pnl;
        const symbol = typeof t.symbol === 'string' && t.symbol ? t.symbol : '?';
        cell.symbols[symbol] = (cell.symbols[symbol] || 0) + pnl;
      }
    }

    // Monday-start week rows, the layout every one of those terminals uses.
    // fill() matters: bare new Array(n) creates HOLES, which .map() silently
    // skips — the blanks must be real elements or the whole grid shifts left.
    const leading = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0
    const cells = new Array(leading).fill(undefined).concat(days);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) {
      const row = cells.slice(i, i + 7);
      while (row.length < 7) row.push(undefined);
      weeks.push({
        days: row,
        totalSol: row.reduce((sum, c) => sum + (c ? c.realizedSol : 0), 0),
        hasTrades: row.some((c) => c && c.hasTrades),
      });
    }

    const totals = {
      realizedSol: 0,
      winDays: 0,
      lossDays: 0,
      flatDays: 0,
      tradeDays: 0,
      buys: 0,
      sells: 0,
      volumeBuySol: 0,
      volumeSellSol: 0,
      bestDay: null,
      worstDay: null,
    };
    for (const c of days) {
      totals.realizedSol += c.realizedSol;
      totals.buys += c.buys;
      totals.sells += c.sells;
      totals.volumeBuySol += c.volumeBuySol;
      totals.volumeSellSol += c.volumeSellSol;
      if (!c.hasTrades) continue;
      totals.tradeDays += 1;
      if (c.realizedSol > 0) totals.winDays += 1;
      else if (c.realizedSol < 0) totals.lossDays += 1;
      else totals.flatDays += 1;
      if (c.sells > 0) {
        if (!totals.bestDay || c.realizedSol > totals.bestDay.pnlSol) {
          totals.bestDay = { day: c.day, pnlSol: c.realizedSol };
        }
        if (!totals.worstDay || c.realizedSol < totals.worstDay.pnlSol) {
          totals.worstDay = { day: c.day, pnlSol: c.realizedSol };
        }
      }
    }

    let openPnlSol = 0;
    const positions = (state && state.positions) || {};
    for (const mint of Object.keys(positions)) openPnlSol += unrealizedPnl(positions[mint]);

    const nowDate = new Date(now);
    const todayDay = nowDate.getFullYear() === year && nowDate.getMonth() === month
      ? nowDate.getDate()
      : null;

    return { year, month, days, weeks, totals, openPnlSol, todayDay };
  }

  /**
   * Oldest and newest months the journal covers, for calendar navigation.
   * With no fills yet the range collapses to the current month.
   */
  function pnlCalendarRange(state) {
    let minTs = Infinity;
    for (const t of (state && state.journal) || []) {
      const ts = Number(t.ts);
      if (ts > 0 && ts < minTs) minTs = ts;
    }
    const now = new Date();
    const max = { year: now.getFullYear(), month: now.getMonth() };
    if (!isFinite(minTs)) return { min: { year: max.year, month: max.month }, max };
    const first = new Date(minTs);
    return { min: { year: first.getFullYear(), month: first.getMonth() }, max };
  }

  /**
   * Quantity-weighted average paper fill prices for the token's current round,
   * or its most recently closed round when no position remains. Padre's native
   * lines use USD, while native SOL averages are retained as a fallback.
   */
  function averageFillPrices(state, mint) {
    if (!state || !mint) return null;
    const journal = state.journal || [];
    const position = state.positions && state.positions[mint];
    let fills;

    if (position) {
      fills = journal.filter((t) => t.mint === mint && Number(t.ts) >= Number(position.openedAt));
    } else {
      const round = (state.rounds || []).find((r) => r.mint === mint);
      if (!round) return null;
      const ids = new Set(round.tradeIds || []);
      fills = journal.filter((t) => ids.has(t.id));
    }

    function weighted(side, priceKey) {
      let value = 0;
      let quantity = 0;
      for (const fill of fills) {
        if (fill.side !== side) continue;
        const qty = Number(fill.qty);
        const price = Number(fill[priceKey]);
        if (!(qty > 0) || !(price > 0)) continue;
        value += qty * price;
        quantity += qty;
      }
      return quantity > 0 ? value / quantity : null;
    }

    const buyQty = fills.filter((t) => t.side === 'buy').reduce((sum, t) => sum + (Number(t.qty) || 0), 0);
    const sellQty = fills.filter((t) => t.side === 'sell').reduce((sum, t) => sum + (Number(t.qty) || 0), 0);
    if (!(buyQty > 0) && !(sellQty > 0)) return null;

    return {
      avgBuyNative: weighted('buy', 'priceNative'),
      avgBuyUsd: weighted('buy', 'priceUsd'),
      avgSellNative: weighted('sell', 'priceNative'),
      avgSellUsd: weighted('sell', 'priceUsd'),
      buyQty,
      sellQty,
      fillCount: fills.length,
    };
  }

  /**
   * Return the realized result the overlay should show after the newest sell
   * for a token. A full exit uses the completed round-trip result; a partial
   * exit uses the realized P&L of that individual sell.
   */
  function latestClosedPnl(state, mint) {
    if (!state || !mint) return null;
    const sell = (state.journal || []).find((t) => t.mint === mint && t.side === 'sell');
    if (!sell) return null;

    const round = (state.rounds || []).find(
      (r) => r.mint === mint && Number(r.closedAt) === Number(sell.ts)
    );
    if (round) {
      return {
        kind: 'round',
        symbol: round.symbol || sell.symbol || '',
        closedAt: round.closedAt,
        pnlSol: Number(round.pnlSol) || 0,
        pnlPct: Number(round.pnlPct) || 0,
        returnedSol: Number(round.returnedSol) || 0,
        investedSol: Number(round.investedSol) || 0,
      };
    }

    const pnlSol = Number(sell.pnlSol) || 0;
    const returnedSol = Number(sell.solNet) || 0;
    // sell.pnlSol = net proceeds - cost basis closed by this sell.
    const closedCostSol = returnedSol - pnlSol;
    return {
      kind: 'partial',
      symbol: sell.symbol || '',
      closedAt: sell.ts,
      pnlSol,
      pnlPct: closedCostSol > 0 ? (pnlSol / closedCostSol) * 100 : 0,
      returnedSol,
      investedSol: closedCostSol,
    };
  }

  /**
   * Convert a positive unrealized P&L percentage into a 1-based alert level.
   * Example with a 10% interval: 9.9 -> 0, 10 -> 1, 27 -> 2.
   */
  function profitAlertLevel(pnlPct, intervalPct) {
    const pnl = Number(pnlPct);
    const interval = Number(intervalPct);
    if (!(pnl > 0) || !(interval > 0)) return 0;
    return Math.max(0, Math.floor((pnl + 1e-9) / interval));
  }

  /** Return the newly crossed level, or null when no new alert is due. */
  function crossedProfitAlert(previousLevel, pnlPct, intervalPct) {
    const previous = Math.max(0, Number(previousLevel) || 0);
    const current = profitAlertLevel(pnlPct, intervalPct);
    return current > previous ? current : null;
  }

  /** Reset everything back to a fresh wallet with the given settings. */
  function resetState(settings) {
    return defaultState(settings);
  }

  /* ---------------- misc ---------------- */

  function tradeId(ts) {
    return 't' + ts.toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function replaySessionId(mint, ts) {
    const cleanMint = String(mint || '').replace(/[^A-Za-z0-9]/g, '');
    const stamp = Math.max(0, Number(ts) || Date.now()).toString(36);
    const tail = cleanMint ? cleanMint.slice(0, 5) + cleanMint.slice(-4) : 'unknown';
    return `pts-${stamp}-${tail}`;
  }

  function pruneJournal(state) {
    if (state.journal.length > 2000) state.journal.length = 2000;
  }

  function short(addr) {
    return addr && addr.length > 10 ? addr.slice(0, 4) + '…' + addr.slice(-4) : (addr || '?');
  }

  const EPS_ = 1e-9;

  function fmt(n, dp = 4) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
  }

  function fmtUsd(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    return sign + '$' + Math.abs(Number(n)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  const _PaperEngine = {
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    defaultSettings,
    mergeSettings,
    SETTINGS_REVISION,
    defaultState,
    resetState,
    buy,
    sell,
    getPosition,
    markPosition,
    unrealizedPnl,
    equitySol,
    solUsdRate,
    sessionStats,
    pnlCalendar,
    pnlCalendarRange,
    averageFillPrices,
    exitQuality,
    exitStats,
    riskProfile,
    normalizeThesis,
    setThesis,
    gradeThesis,
    thesisStats,
    THESIS_TAGS,
    THESIS_PLANS,
    THESIS_MAX,
    latestClosedPnl,
    profitAlertLevel,
    crossedProfitAlert,
    replaySessionId,
    short,
    fmt,
    fmtUsd,
    clamp,
    EPS_,
  };

  if (typeof window !== 'undefined') {
    window.PaperEngine = _PaperEngine;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = _PaperEngine;
  }

})();
