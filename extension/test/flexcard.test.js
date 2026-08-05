/* The flex-card composer: Padre-style layout, backgrounds, customization.
 *
 * The crown jewel here is the branding lock. Every element of the card is
 * customizable EXCEPT its identity as a paper trade: the PAPER watermark and
 * the PaperTrench brand bar ("PaperTrench · paper trading — not financial
 * advice" + the site URL) must be drawn LAST, unconditionally, from a code
 * path that reads no flag. That is proven two ways:
 *
 *   1. Behaviourally — drawCard is driven through the FULL cross product of
 *      every customization flag (plus accents, backgrounds, media, open/
 *      closed, win/loss) and the branding must be painted, on top, in every
 *      single combination.
 *   2. By source contract — drawBranding receives only the context and its
 *      body references no model field, no pref, no flag; drawCard calls it
 *      unconditionally as its final act.
 *
 * The rest of the composer holds to the same honesty bar: USD sub-lines
 * exist only when every fill recorded a USD price (em-dash otherwise, never
 * a converted guess), a full gallery REFUSES uploads instead of silently
 * evicting, and prefs persist via the D-19 fresh-read/single-key discipline.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PC = require('../pnlcard.js');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const pnlJs = fs.readFileSync(path.join(ROOT, 'pnlcard.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/** Slice a top-level dashboard.js function (closes at column 0). */
function fnBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} must exist`);
  const end = source.indexOf('\n}', start);
  assert.ok(end !== -1, `${marker} must terminate`);
  return source.slice(start, end + 2);
}

/** Slice a pnlcard.js function (inside the IIFE, closes at 2-space indent). */
function iifeBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} must exist`);
  const end = source.indexOf('\n  }', start);
  assert.ok(end !== -1, `${marker} must terminate`);
  return source.slice(start, end + 4);
}

/** Record every canvas call so the draw itself can be asserted. */
function recordingContext() {
  const calls = [];
  const texts = [];
  const gradient = () => ({ addColorStop() {} });
  const handler = {
    get(target, prop) {
      if (prop === 'calls') return calls;
      if (prop === 'texts') return texts;
      if (prop === 'measureText') return (t) => { texts.push(String(t)); return { width: String(t).length * 10 }; };
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return (...args) => { calls.push({ fn: String(prop), args }); return gradient(); };
      }
      if (prop === 'canvas') return { width: PC.WIDTH, height: PC.HEIGHT };
      if (typeof target[prop] === 'function' || !(prop in target)) {
        return (...args) => {
          calls.push({ fn: String(prop), args });
          if (prop === 'fillText' || prop === 'strokeText') texts.push(String(args[0]));
          return undefined;
        };
      }
      return target[prop];
    },
    set() { return true; },
  };
  return new Proxy({}, handler);
}

const BRANDING_TEXTS = new Set([
  PC.WATERMARK_TEXT, PC.BRAND_TEXT, PC.BRAND_TAGLINE, PC.SITE_URL, 'P',
]);

/** Branding present AND painted after every piece of card content. */
function assertBrandingIntact(texts, label) {
  assert.ok(texts.includes(PC.WATERMARK_TEXT), `${label}: the PAPER watermark must be drawn`);
  assert.ok(texts.includes(PC.BRAND_TEXT), `${label}: the PaperTrench name must be drawn`);
  assert.ok(texts.some((t) => /not financial advice/i.test(t)), `${label}: the disclaimer must be drawn`);
  assert.ok(texts.includes(PC.SITE_URL), `${label}: the site URL must be drawn`);

  let lastContent = -1;
  let firstBranding = Infinity;
  texts.forEach((t, i) => {
    if (BRANDING_TEXTS.has(t)) firstBranding = Math.min(firstBranding, i);
    else lastContent = Math.max(lastContent, i);
  });
  if (lastContent !== -1) {
    assert.ok(firstBranding > lastContent,
      `${label}: branding must paint OVER the content (last), not under whatever hides it`);
  }
}

/** A real engine round with full USD data on every fill. */
function usdRound() {
  const settings = Object.assign(E.defaultSettings(), { feeBps: 0, balanceStartSol: 10 });
  const state = E.defaultState(settings);
  E.buy(state, settings, {
    ts: 1000, mint: MINT, symbol: 'BONK', site: 'padre',
    priceNative: 0.001, priceUsd: 0.15, solAmount: 1, mcap: 240000,
  });
  E.sell(state, settings, {
    ts: 61000, mint: MINT, qtyFraction: 1, priceNative: 0.002, priceUsd: 0.30, mcap: 480000,
  });
  return { round: state.rounds[0], journal: state.journal };
}

/** A real engine round whose fills carry NO USD prices. */
function nativeOnlyRound() {
  const settings = Object.assign(E.defaultSettings(), { feeBps: 0 });
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: 1000, mint: MINT, symbol: 'WIF', priceNative: 0.002, solAmount: 2 });
  E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.001 });
  return { round: state.rounds[0], journal: state.journal };
}

/* ================= the branding lock (behavioural) ================= */

const FLAGS = ['showSymbol', 'showInvested', 'showReturned', 'showPercent', 'showUsd', 'showDate', 'showAfter'];

test('BRAND LOCK: the full 2^7 flag cross product cannot remove the branding', () => {
  const { round, journal } = usdRound();
  const source = {
    ...round,
    investedUsd: PC.usdTotal(journal, 'buy', 'solGross'),
    returnedUsd: PC.usdTotal(journal, 'sell', 'solNet'),
    afterExit: { maxPct: 180, minPct: -12, samples: 9 },
  };

  for (let mask = 0; mask < (1 << FLAGS.length); mask++) {
    const prefs = {};
    FLAGS.forEach((flag, i) => { if (mask & (1 << i)) prefs[flag] = false; });
    const model = PC.cardModel(source, { prefs, handle: 'terp' });
    const ctx = recordingContext();
    assert.equal(PC.drawCard(ctx, model), true);
    assertBrandingIntact(ctx.texts, `flag mask ${mask.toString(2).padStart(7, '0')}`);
  }
});

test('BRAND LOCK: accents, backgrounds, media, loss, open — branding survives them all', () => {
  const { round } = nativeOnlyRound();
  const variants = [];
  for (const accent of [...Object.keys(PC.ACCENTS), 'not-a-color']) {
    variants.push({ prefs: { accent } });
  }
  for (const bg of PC.BACKGROUNDS) {
    variants.push({ prefs: { background: bg.id } });
  }
  variants.push({ prefs: {}, media: { naturalWidth: 1600, naturalHeight: 900 } });
  variants.push({
    prefs: Object.fromEntries(FLAGS.map((f) => [f, false])),
    media: { naturalWidth: 300, naturalHeight: 900 },
  });
  // An open position (no closedAt) with everything hidden.
  variants.push({
    source: { symbol: 'X', mint: MINT, investedSol: 1, pnlSol: -0.4 },
    prefs: Object.fromEntries(FLAGS.map((f) => [f, false])),
  });

  for (const [i, variant] of variants.entries()) {
    const model = PC.cardModel(variant.source || round, { prefs: variant.prefs });
    const ctx = recordingContext();
    assert.equal(PC.drawCard(ctx, model, variant.media), true);
    assertBrandingIntact(ctx.texts, `variant ${i}`);
  }
});

test('BRAND LOCK: a hand-built model with no show flags at all still gets branding', () => {
  // A caller that bypasses cardModel and hands drawCard a bare object gets
  // the full layout AND the branding — absent flags never mean "hide".
  const ctx = recordingContext();
  assert.equal(PC.drawCard(ctx, {
    symbol: 'RAW', multipleText: '2.00x', pnlPctText: '+100.0%', pnlSolText: '+1.000 SOL',
    pnlSolHeroText: '+1.00', investedText: '1.000 SOL', returnedText: '2.000 SOL',
    investedUsdText: '—', returnedUsdText: '—', pnlUsdText: '—',
    entryText: '—', exitText: '—', heldText: '0s', statusText: 'CLOSED',
    accent: PC.COLORS.green, watermark: 'PAPER', brand: 'PaperTrench',
  }), true);
  assertBrandingIntact(ctx.texts, 'bare model');
});

/* ================= the branding lock (source contract) ================= */

test('BRAND LOCK: drawBranding reads no model, no prefs, no flags — only constants', () => {
  const body = iifeBlock(pnlJs, 'function drawBranding(ctx) {');
  assert.doesNotMatch(body, /model/, 'drawBranding must not receive or read a model');
  assert.doesNotMatch(body, /prefs/, 'drawBranding must not read prefs');
  assert.doesNotMatch(body, /\bshow\b/, 'drawBranding must not consult visibility flags');
  assert.doesNotMatch(body, /\bif\s*\(/, 'drawBranding must have no conditional paths at all');
  assert.match(body, /fillText\(WATERMARK_TEXT/, 'the watermark comes from the module constant');
  assert.match(body, /strokeText\(WATERMARK_TEXT/, 'the watermark is stroked as well as filled');
  assert.match(body, /fillText\(BRAND_TEXT/, 'the brand name comes from the module constant');
  assert.match(body, /fillText\(BRAND_TAGLINE/, 'the disclaimer comes from the module constant');
  assert.match(body, /fillText\(SITE_URL/, 'the site URL comes from the module constant');
});

test('BRAND LOCK: drawCard calls drawBranding unconditionally, as its final act', () => {
  const body = iifeBlock(pnlJs, 'function drawCard(ctx, model, media) {');
  const callSites = body.match(/drawBranding\(ctx\);/g) || [];
  assert.equal(callSites.length, 1, 'exactly one branding call');
  assert.match(body, /\n    drawBranding\(ctx\);/,
    'the call sits at statement level — not nested inside any if/loop');
  assert.match(body, /drawBranding\(ctx\);\s*\n\s*ctx\.restore\(\);\s*\n\s*return true;/,
    'branding is the last thing drawn before the card is handed back');
});

test('BRAND LOCK: the brand line and URL are the doctrine strings', () => {
  assert.equal(PC.BRAND_TEXT, 'PaperTrench');
  assert.match(PC.BRAND_TAGLINE, /paper trading — not financial advice/);
  assert.equal(PC.SITE_URL, 'onlyterp.github.io/papertrench');
});

/* ================= customization flags ================= */

test('flags hide exactly their element — the P&L itself is not hideable', () => {
  const { round, journal } = usdRound();
  const source = {
    ...round,
    investedUsd: PC.usdTotal(journal, 'buy', 'solGross'),
    returnedUsd: PC.usdTotal(journal, 'sell', 'solNet'),
    afterExit: { maxPct: 180, minPct: -12, samples: 9 },
  };

  const allOff = PC.cardModel(source, { prefs: Object.fromEntries(FLAGS.map((f) => [f, false])) });
  const ctx = recordingContext();
  PC.drawCard(ctx, allOff);
  assert.ok(!ctx.texts.includes('BONK'), 'symbol off means no symbol');
  assert.ok(!ctx.texts.includes(allOff.multipleText), 'percent off hides the multiple chip');
  assert.ok(!ctx.texts.includes(allOff.investedText), 'invested column off');
  assert.ok(!ctx.texts.includes(allOff.returnedText), 'returned column off');
  assert.ok(!ctx.texts.includes(allOff.pnlPctText), 'percent column off');
  assert.ok(!ctx.texts.includes(allOff.dateText), 'date off');
  assert.ok(!ctx.texts.includes(allOff.afterText), 'after line off');
  assert.ok(!ctx.texts.some((t) => /^\([+-]?\$/.test(t)), 'USD subs off');
  assert.ok(ctx.texts.includes(allOff.pnlSolHeroText),
    'the SOL P&L is the card — no flag exists to hide it');
  assert.ok(ctx.texts.includes('◎'), 'the Solana glyph rides with the hero');

  const allOn = PC.cardModel(source, { prefs: {} });
  const ctx2 = recordingContext();
  PC.drawCard(ctx2, allOn);
  for (const expected of [
    'BONK', allOn.multipleText, allOn.investedText, allOn.returnedText,
    allOn.pnlPctText, allOn.dateText, allOn.afterText,
    allOn.investedUsdText, allOn.returnedUsdText, allOn.pnlUsdText,
  ]) {
    assert.ok(ctx2.texts.includes(expected), `default prefs draw everything: missing ${expected}`);
  }
});

test('hiding one stat column reflows the others rather than leaving a hole', () => {
  const { round } = usdRound();
  const model = PC.cardModel(round, { prefs: { showPercent: false } });
  const ctx = recordingContext();
  PC.drawCard(ctx, model);
  assert.ok(!ctx.texts.includes(model.pnlPctText));
  const invested = ctx.calls.find((c) => c.fn === 'fillText' && c.args[0] === model.investedText);
  const returned = ctx.calls.find((c) => c.fn === 'fillText' && c.args[0] === model.returnedText);
  assert.ok(invested && returned, 'the surviving columns are still drawn');
  // Two columns split the rail in half: the second starts at the midpoint.
  const railWidth = PC.WIDTH - 128;
  assert.equal(returned.args[1] - invested.args[1], railWidth / 2);
});

test('the accent recolors the trim only — win/loss colors stay semantic', () => {
  const { round: winRound } = usdRound();
  const { round: lossRound } = nativeOnlyRound();

  const blueWin = PC.cardModel(winRound, { prefs: { accent: 'blue' } });
  assert.equal(blueWin.trim, PC.ACCENTS.blue);
  assert.equal(blueWin.accent, PC.COLORS.green, 'a win stays green under any accent');

  const violetLoss = PC.cardModel(lossRound, { prefs: { accent: 'violet' } });
  assert.equal(violetLoss.trim, PC.ACCENTS.violet);
  assert.equal(violetLoss.accent, PC.COLORS.red, 'a loss stays red under any accent');

  const unknown = PC.cardModel(winRound, { prefs: { accent: 'chartreuse' } });
  assert.equal(unknown.trim, PC.COLORS.amber, 'an unknown accent falls back to brand amber');
});

/* ================= honest USD sub-lines ================= */

test('USD totals exist only when EVERY fill on the side recorded a USD price', () => {
  const { journal } = usdRound();
  // Rate is 150 $/SOL on both fills: 1 SOL in → $150; 2 SOL out → $300.
  assert.equal(PC.usdTotal(journal, 'buy', 'solGross'), 150);
  assert.equal(PC.usdTotal(journal, 'sell', 'solNet'), 300);

  const partial = [
    { side: 'buy', solGross: 1, priceNative: 0.001, priceUsd: 0.15 },
    { side: 'buy', solGross: 1, priceNative: 0.001, priceUsd: null },
  ];
  assert.equal(PC.usdTotal(partial, 'buy', 'solGross'), null,
    'one USD-less fill poisons the total — a partial sum silently changes what "invested" covers');
  assert.equal(PC.usdTotal([], 'buy', 'solGross'), null);
  assert.equal(PC.usdTotal(journal, 'sell', 'noSuchField'), null,
    'a missing SOL amount cannot be summed');
});

test('a round with USD data renders parenthesised subs; without, honest em-dashes', () => {
  const withUsd = usdRound();
  const model = PC.cardModel({
    ...withUsd.round,
    investedUsd: PC.usdTotal(withUsd.journal, 'buy', 'solGross'),
    returnedUsd: PC.usdTotal(withUsd.journal, 'sell', 'solNet'),
  });
  assert.equal(model.investedUsdText, '($150.00)');
  assert.equal(model.returnedUsdText, '($300.00)');
  assert.equal(model.pnlUsdText, '(+$150.00)', 'the P&L sub is derived from the two recorded totals');

  const without = nativeOnlyRound();
  const bare = PC.cardModel({
    ...without.round,
    investedUsd: PC.usdTotal(without.journal, 'buy', 'solGross'),
    returnedUsd: PC.usdTotal(without.journal, 'sell', 'solNet'),
  });
  assert.equal(bare.investedUsdText, '—', 'no USD data means an em-dash, never a guessed conversion');
  assert.equal(bare.returnedUsdText, '—');
  assert.equal(bare.pnlUsdText, '—');

  const ctx = recordingContext();
  PC.drawCard(ctx, bare);
  assert.ok(!ctx.texts.some((t) => /^\([+-]?\$/.test(t)),
    'a card without USD data must not paint a single converted dollar figure');
});

test('the dashboard feeds the card usdTotal, not a rate-of-the-day conversion', () => {
  const open = fnBlock(dashJs, 'function openShareCard(roundId)');
  assert.match(open, /investedUsd: PC\.usdTotal\(trades, 'buy', 'solGross'\)/);
  assert.match(open, /returnedUsd: PC\.usdTotal\(trades, 'sell', 'solNet'\)/);
  assert.doesNotMatch(open, /solUsdRate/,
    'the live SOL/USD rate must never back-fill a historical round');
});

/* ================= The After on the card ================= */

test('the After line repeats the observed record: ran → left on the table, dumped → dodged', () => {
  const base = { symbol: 'X', investedSol: 1, returnedSol: 2, pnlSol: 1, closedAt: 5000 };

  const ran = PC.cardModel({ ...base, afterExit: { maxPct: 180, minPct: -20, samples: 7 } });
  assert.equal(ran.afterText, '+180% after exit — left on the table');
  assert.equal(ran.afterColor, PC.COLORS.amber);

  const dumped = PC.cardModel({ ...base, afterExit: { maxPct: 10, minPct: -62, samples: 7 } });
  assert.equal(dumped.afterText, '-62% after exit — dodged');
  assert.equal(dumped.afterColor, PC.COLORS.green);

  const unobserved = PC.cardModel({ ...base, afterExit: { maxPct: 500, minPct: -90, samples: 0 } });
  assert.equal(unobserved.afterText, '', 'zero samples means nothing was observed — nothing is claimed');
  assert.equal(PC.cardModel(base).afterText, '', 'no afterExit record, no line');
});

/* ================= built-in backgrounds ================= */

test('4-6 procedural backgrounds ship, dark, with unique ids', () => {
  assert.ok(PC.BACKGROUNDS.length >= 4 && PC.BACKGROUNDS.length <= 6,
    `expected 4-6 built-ins, got ${PC.BACKGROUNDS.length}`);
  const ids = PC.BACKGROUNDS.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  for (const wanted of ['void', 'ember', 'deep', 'dusk', 'grid']) {
    assert.ok(ids.includes(wanted), `the ${wanted} background must exist`);
  }
  for (const bg of PC.BACKGROUNDS) {
    const ctx = recordingContext();
    assert.equal(PC.paintBackground(ctx, bg.id, 1200, 675), true);
    assert.ok(ctx.calls.some((c) => c.fn === 'fillRect'), `${bg.id} must actually paint`);
    assert.equal(ctx.texts.length, 0, `${bg.id} paints pixels, never text`);
  }
  assert.equal(PC.paintBackground(recordingContext(), 'no-such-bg', 1200, 675), false);
});

test('a selected built-in flows through the model and gets painted under the card', () => {
  const { round } = usdRound();
  const model = PC.cardModel(round, { prefs: { background: 'ember' } });
  assert.equal(model.background, 'ember');
  const ctx = recordingContext();
  PC.drawCard(ctx, model);
  assert.ok(ctx.calls.some((c) => c.fn === 'createRadialGradient'),
    'the ember glow must be painted');
  assertBrandingIntact(ctx.texts, 'ember background');

  assert.equal(PC.cardModel(round, { prefs: { background: 'upload:abc' } }).background, null,
    'an upload id is media, not a built-in — the painter must not guess');
  assert.equal(PC.cardModel(round, {}).background, null);
});

/* ================= gallery admission (behavioural) ================= */

test('a 2 MB+ image is refused with a visible reason; 2 MB exactly is admitted', () => {
  const big = PC.admitUpload({ size: 3 * 1024 * 1024, type: 'image/png', name: 'big.png' }, 0);
  assert.equal(big.ok, false);
  assert.match(big.reason, /3\.0 MB/, 'the refusal names the actual size');
  assert.match(big.reason, /2 MB/, 'the refusal names the limit');

  assert.equal(PC.admitUpload({ size: PC.MAX_UPLOAD_BYTES, type: 'image/png' }, 0).ok, true,
    'exactly at the limit is fine');
  assert.equal(PC.admitUpload({ size: 100, type: 'text/plain' }, 0).ok, false,
    'non-images are refused');
  assert.equal(PC.admitUpload(null, 0).ok, false);
  assert.equal(PC.admitUpload({ size: 0, type: 'image/png' }, 0).ok, false,
    'an empty file cannot be a background');
});

test('the 10-image cap REFUSES the eleventh — nothing is silently evicted', () => {
  const image = { size: 1024, type: 'image/png', name: 'ok.png' };
  assert.equal(PC.admitUpload(image, 9).ok, true, 'the tenth image fits');
  const full = PC.admitUpload(image, 10);
  assert.equal(full.ok, false, 'the eleventh is refused');
  assert.match(full.reason, /10\/10/, 'the refusal shows the full count');
  assert.match(full.reason, /delete/i, 'the refusal tells the user the honest way out');
  assert.match(full.reason, /Nothing is evicted/i, 'the no-eviction promise is stated');
});

test('the dashboard store enforces admission at the write, not just at the drop site', () => {
  const add = fnBlock(dashJs, 'async function cardBgAdd(file)');
  assert.match(add, /PC\.admitUpload\(file, cardUploads\.length\)/,
    'cardBgAdd re-checks admission before touching IndexedDB');
  assert.match(add, /if \(!verdict\.ok\) return \{ ok: false/,
    'a refused file never reaches the store');
  assert.match(dashJs, /const CARD_DB_NAME = 'pt-cardmedia';/);
  assert.match(dashJs, /const CARD_DB_STORE = 'backgrounds';/);
  assert.match(add, /addedAt: Date\.now\(\)/, 'records carry the documented shape');

  const adopt = fnBlock(dashJs, 'async function adoptCardUpload(chosen)');
  assert.match(adopt, /showCardMessage\(verdict\.reason\)/,
    'a refusal is shown to the user, not swallowed');
  const bind = fnBlock(dashJs, 'function bindShareCard()');
  assert.match(bind, /adoptCardUpload\(file\.files && file\.files\[0\]\)/,
    'the picker routes through the gallery');
  assert.match(bind, /adoptCardUpload\(event\.dataTransfer/,
    'the drop-zone keeps working AND persists through the gallery');
});

/* ================= prefs persistence (D-19 discipline) ================= */

test('cardPrefs persist via fresh-read + single-key lay, refused when storage is blind', () => {
  const persist = fnBlock(dashJs, 'async function persistCardPrefs()');
  assert.match(persist, /store\.get\(\['pt_settings'\]\)/,
    'D-19: the key is laid over freshly read settings, never the stale module copy');
  assert.match(persist, /if \(stored === null\) return;/,
    'D-15: an unreadable read refuses the write');
  assert.match(persist, /storageReadFailed/, 'the blind-write guard is consulted');
  assert.match(persist, /fresh\.cardPrefs = \{ \.\.\.cardPrefs \};[\s\S]*store\.set\(\{ pt_settings: fresh \}\)/,
    'exactly ONE key is laid over the fresh copy');

  const gather = fnBlock(dashJs, 'function gatherSettingsFromForm(');
  assert.ok(!gather.includes('cardPrefs'),
    'cardPrefs is not a form field — the fresh-read merge preserves it across settings saves');
});

test('cardPrefs survive a mergeSettings round trip — engine.js untouched', () => {
  const prefs = { showSymbol: false, showUsd: false, accent: 'blue', background: 'grid' };
  const merged = E.mergeSettings({ settingsRevision: 99, cardPrefs: prefs });
  assert.deepEqual(merged.cardPrefs, prefs,
    'unknown keys ride through mergeSettings unchanged (the onboardingDismissed pattern)');
  assert.equal(E.mergeSettings(undefined).cardPrefs, undefined,
    'absent key = all-on defaults; the engine never invents it');

  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  assert.ok(!engineSrc.includes('cardPrefs'),
    'absent-key defaults handle it — engine.js must not know the key exists');
});

test('an absent flag means SHOWN, so pre-feature settings render the full card', () => {
  const { round } = usdRound();
  const model = PC.cardModel(round, { prefs: {} });
  for (const key of Object.keys(model.show)) {
    assert.equal(model.show[key], true, `show.${key} must default on`);
  }
  const bind = fnBlock(dashJs, 'function bindShareCard()');
  assert.match(bind, /if \(input\.checked\) delete cardPrefs\[key\];/,
    'a re-checked flag deletes its key so stored prefs stay minimal and absent = on');
});

/* ================= copy action ================= */

test('Copy builds the ClipboardItem inside the gesture and falls back honestly', () => {
  const copy = fnBlock(dashJs, 'function copyCard()');
  assert.match(copy, /new ClipboardItem\(\{ 'image\/png': png \}\)/);
  assert.match(copy, /canvas\.toBlob/, 'the PNG comes from the canvas');
  assert.match(copy, /navigator\.clipboard\.write/);
  assert.match(copy, /new Promise/, 'the blob is a promise so the write stays inside the click gesture');
  assert.match(copy, /Copied ✓/, 'success gives button feedback');
  assert.match(copy, /2000/, 'the feedback resets after 2 s');
  const failures = copy.match(/showCardMessage\('([^']+)'\)/g) || [];
  assert.ok(failures.length >= 2, 'both failure paths (unsupported, refused) speak up');
  for (const failure of failures.filter((f) => !f.includes("''"))) {
    assert.match(failure, /Download/, 'every failure message points at the path that always works');
  }
});

/* ================= layout model ================= */

test('the hero is a signed SOL figure with the ◎ glyph beside it', () => {
  const { round } = usdRound();
  const model = PC.cardModel(round);
  assert.equal(model.pnlSolHeroText, '+1.00');
  const ctx = recordingContext();
  PC.drawCard(ctx, model);
  const glyph = ctx.calls.find((c) => c.fn === 'fillText' && c.args[0] === '◎');
  const hero = ctx.calls.find((c) => c.fn === 'fillText' && c.args[0] === '+1.00');
  assert.ok(glyph && hero, 'glyph and figure are both painted');
  assert.ok(hero.args[1] > glyph.args[1], 'the figure sits to the right of the glyph');

  const loss = PC.cardModel({ symbol: 'X', investedSol: 1, returnedSol: 0.5, pnlSol: -0.5, closedAt: 1 });
  assert.match(loss.pnlSolHeroText, /^-0\.50$/, 'a loss is signed, never dressed up');
});

test('the date is a fixed-format stamp derived from the round, not from render time', () => {
  const closedAt = Date.UTC(2026, 7, 5, 12, 0, 0);
  const model = PC.cardModel({ symbol: 'X', investedSol: 1, returnedSol: 2, pnlSol: 1, closedAt });
  const d = new Date(closedAt);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  assert.equal(model.dateText, `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`);
  assert.equal(PC.cardModel({ symbol: 'X', investedSol: 1, pnlSol: 1 }).dateText, '',
    'no timestamps, no date — never "today"');
});

/* ================= composer wiring ================= */

test('the composer carries the gallery, actions row, customize panel and message line', () => {
  assert.match(html, /id="card-gallery"/, 'the background strip exists');
  assert.match(html, /id="card-copy"/, 'the Copy action exists');
  assert.match(html, /id="card-customize"/, 'the Customize toggle exists');
  assert.match(html, /id="card-custom"/, 'the flag panel exists');
  assert.match(html, /id="card-msg"/, 'the honest message line exists');
  for (const flag of ['symbol', 'invested', 'returned', 'percent', 'usd', 'date', 'after']) {
    assert.match(html, new RegExp(`id="card-flag-${flag}"`), `checkbox for ${flag}`);
  }
  for (const accent of Object.keys(PC.ACCENTS)) {
    assert.match(html, new RegExp(`data-accent="${accent}"`), `swatch for ${accent}`);
  }
  assert.match(html, /max 2 MB/, 'the drop label states the limit up front');
  assert.doesNotMatch(dashJs, /card-clear/,
    'the old Clear button is gone — the Void thumbnail is the honest "none"');
  assert.match(dashJs, /Max 2 MB · \$\{cardUploads\.length\}\/\$\{PC\.MAX_UPLOADS\}/,
    'the upload tile mirrors the reference: limit and N/10 count');
});

test('the model is rebuilt per paint so toggles re-derive strings from the same round', () => {
  const paint = fnBlock(dashJs, 'function paintShareCard()');
  assert.match(paint, /PC\.cardModel\(cardSourceCurrent/,
    'paint derives the model from the stored engine source every time');
  assert.match(paint, /prefs: cardPrefs \|\| settings\.cardPrefs \|\| \{\}/,
    'the working prefs copy drives the flags');
});

/* ---------------- open-position sharing (the "still holding" flex) ------- */

test("an open position cards honestly: OPEN status, POSITION column, live value", () => {
  const model = PC.cardModel({
    mint: MINT, symbol: "PT", site: "padre",
    openedAt: 1_800_000_000_000, heldMs: 45 * 60_000,
    investedSol: 8.16, returnedSol: 5.85, pnlSol: -2.31, pnlPct: -28.31,
    entryPrice: 0.0000041, lastPriceNative: 0.0000029,
  }, {});
  assert.ok(model, "an open source must model");
  assert.equal(model.open, true);
  assert.match(model.pnlSolHeroText, /^-2\.31/);
  assert.equal(model.win, false);
  // The journey line must not claim an EXIT that has not happened.
  // (drawCard skips the EXIT segment when model.open — pinned below.)
  const pn = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "pnlcard.js"), "utf8");
  assert.match(pn, /!model\.open && model\.exitText/, "no EXIT segment on an open card");
  assert.match(pn, /model\.open \? .POSITION. : .RETURNED./, "the middle column reads POSITION while open");
});

test("the dashboard offers Share on live open positions", () => {
  const dash = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "dashboard.js"), "utf8");
  assert.match(dash, /share-open-btn/, "open-position rows carry a Share button");
  const fnStart = dash.indexOf("function openShareCardForPosition(");
  assert.ok(fnStart !== -1);
  const block = dash.slice(fnStart, dash.indexOf("\nfunction openShareCard(", fnStart));
  assert.match(block, /E\.unrealizedPnl\(pos\)/, "P&L is the engine live mark, never recomputed ad hoc");
  assert.match(block, /Number\.isFinite\(lastUsd\) && lastUsd > 0 \? qty \* lastUsd : null/,
    "USD value only from a genuinely recorded mark — no fabricated conversion");
});
