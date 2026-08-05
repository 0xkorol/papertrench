/* End-to-end integration over the real shipped scripts.
 *
 * This drives the actual user path as closely as this sandbox permits:
 * load engine/quote/sites/resolver exactly as the manifest does, resolve a
 * token from a real page URL using a recorded API payload, feed a bridge tick
 * through the shipped validator, and execute a paper round trip.
 *
 * No logic is re-implemented; every assertion runs against the shipped files.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const tokensPayload = JSON.parse(fs.readFileSync(path.join(FIX, 'tokens-bonk.json'), 'utf8'));

const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/**
 * Boot the extension's library scripts in manifest order inside one context,
 * with a page URL that a site adapter must recognise.
 */
function bootExtension(pageUrl, fetchImpl) {
  const url = new URL(pageUrl);
  const win = {
    addEventListener: () => {},
    location: { href: pageUrl, hostname: url.hostname, pathname: url.pathname, search: url.search },
  };
  win.window = win;

  const sandbox = {
    window: win,
    location: win.location,
    console,
    fetch: fetchImpl,
    URLSearchParams,
    URL,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    Set, Map, WeakSet, Promise, JSON, Math, Date, Number, String, Array, Object,
    Boolean, RegExp, Error, isNaN, parseInt, parseFloat,
  };
  const ctx = vm.createContext(sandbox);

  // Load the isolated-world library scripts in their manifest order.
  const entry = manifest.content_scripts.find((cs) => (cs.js || []).includes('content.js'));
  for (const file of entry.js) {
    // Consumers, not libraries: they need a live DOM/extension context and
    // install no globals. Covered by load.test.js and warmlinks.test.js.
    if (file === 'content.js' || file === 'warm-links.js') continue;
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  }
  return win;
}

function fixtureFetch(url) {
  if (String(url).includes('/tokens/')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => tokensPayload });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
}

test('a Padre token URL resolves to a real name and a trusted anchor price', async () => {
  const win = bootExtension(`https://trade.padre.gg/trade/${BONK_MINT}`, fixtureFetch);

  // 1. The site adapter must extract the contract address from the URL.
  const site = win.PaperTrenchSites.currentSite();
  const detected = site.detect();
  assert.ok(detected, 'the adapter must detect a token on a Padre token URL');
  assert.equal(detected.address, BONK_MINT, 'the CA must come from the URL');

  // 2. The resolver must turn that address into verified identity + anchor.
  const token = await win.PaperTrenchResolver.resolve(detected.address);
  assert.ok(token, 'the detected address must resolve');
  assert.ok(token.priceNative > 0, 'resolution must yield a trusted price');

  // 3. The header must show a real name, distinct from the address.
  const header = win.PaperQuote.headerFields(token);
  assert.notEqual(header.title, header.address, 'name and CA must be distinct fields');
  assert.equal(header.titleIsAddress, false, 'the title must never be the CA');
  assert.equal(header.pending, false, 'a resolved token is not pending');
  // The headline reads in market cap, the unit traders actually quote.
  assert.match(header.priceText, /^\$/);
  assert.ok(token.priceNative > 0,
    'and the SOL price is still held underneath so the token can be paper-traded');
});

test('the bogus 0.44 SOL page tick cannot reach the display or a fill', async () => {
  const win = bootExtension(`https://trade.padre.gg/trade/${BONK_MINT}`, fixtureFetch);
  const token = await win.PaperTrenchResolver.resolve(BONK_MINT);
  const trusted = token.priceNative;

  // Reproduce the exact observed defect: an unrelated 0.44 on the page.
  const verdict = win.PaperQuote.validateTick(token, {
    candidates: [{ value: 0.44, unit: 'native', key: 'price' }],
    source: 'ws',
  });

  assert.equal(verdict.accepted, false, '0.44 SOL must never be adopted');
  assert.equal(verdict.priceNative, trusted, 'the trusted price must be preserved');

  // The header therefore still shows the trusted price, not 0.44.
  const header = win.PaperQuote.headerFields(
    Object.assign({}, token, { priceNative: verdict.priceNative })
  );
  assert.ok(!header.priceText.startsWith('0.44'), 'the bogus price must not be displayed');
});

test('a genuine page tick refines the price and flows into a correct round trip', async () => {
  const win = bootExtension(`https://trade.padre.gg/trade/${BONK_MINT}`, fixtureFetch);
  const E = win.PaperEngine;
  const Q = win.PaperQuote;

  const token = await win.PaperTrenchResolver.resolve(BONK_MINT);
  const entryAnchor = token.priceNative;

  // A believable live move arrives over the page's own socket.
  const moved = entryAnchor * 1.5;
  const verdict = Q.validateTick(token, { candidates: [{ value: moved, unit: 'native' }] });
  assert.equal(verdict.accepted, true, 'an in-band tick must be accepted');
  token.priceNative = verdict.priceNative;

  // Trade it on a fresh wallet using ONLY the trusted price.
  const settings = E.defaultSettings();
  const state = E.defaultState(settings);
  assert.equal(state.journal.length, 0, 'the wallet must start empty');

  const spend = 1;
  const t0 = Date.now();
  E.buy(state, settings, {
    ts: t0, mint: token.mint, symbol: token.symbol, site: 'padre',
    priceNative: token.priceNative, priceUsd: token.priceUsd, solAmount: spend,
  });

  const pos = state.positions[token.mint];
  assert.ok(pos, 'the buy must open a position');
  assert.equal(pos.symbol, token.symbol, 'the position must carry the real ticker');

  const qty = pos.qty;
  const costBasis = pos.costSol;
  const exit = token.priceNative * 2;

  const res = E.sell(state, settings, { ts: t0 + 30000, mint: token.mint, qtyFraction: 1, priceNative: exit });

  // Expectation derived from inputs, not pasted.
  const grossOut = qty * exit;
  const netOut = grossOut - grossOut * (settings.feeBps / 10000);
  assert.ok(Math.abs(res.trade.pnlSol - (netOut - costBasis)) < 1e-9);
  assert.equal(state.rounds.length, 1, 'exactly one round trip must be booked');
  assert.ok(state.rounds[0].pnlSol > 0, 'a 2x must profit after fees');
  assert.equal(Object.keys(state.positions).length, 0, 'the position must be closed');
});

test('a pair-address URL (Photon style) also resolves to a real name', async () => {
  const pairPayload = JSON.parse(fs.readFileSync(path.join(FIX, 'pair-bonk.json'), 'utf8'));
  const pairAddr = pairPayload.pair.pairAddress;

  const win = bootExtension(`https://photon-sol.tinyastro.io/en/lp/${pairAddr}`, (url) => {
    if (String(url).includes('/pairs/solana/')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => pairPayload });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });

  const detected = win.PaperTrenchSites.currentSite().detect();
  assert.equal(detected.address, pairAddr);
  assert.equal(detected.kind, 'pair');

  const token = await win.PaperTrenchResolver.resolve(detected.address);
  assert.ok(token.priceNative > 0);

  const header = win.PaperQuote.headerFields(token);
  assert.equal(header.titleIsAddress, false, 'a pair URL must still show a real name');
  assert.notEqual(header.title, header.address);
});

test('an unresolvable address yields a pending header, never a fabricated price', async () => {
  const win = bootExtension(
    'https://trade.padre.gg/trade/NotARealTokenAddress1111111111111111111111',
    () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
  );

  const detected = win.PaperTrenchSites.currentSite().detect();
  const token = await win.PaperTrenchResolver.resolve(detected ? detected.address : 'x');
  assert.equal(token, null, 'an unknown address must not resolve');

  // The overlay's pre-resolution state must be explicitly pending.
  const header = win.PaperQuote.headerFields({ mint: 'NotARealTokenAddress1111111111111111111111', priceNative: null });
  assert.equal(header.pending, true);
  assert.doesNotMatch(header.priceText, /\d/, 'a pending header must show no number');
});
