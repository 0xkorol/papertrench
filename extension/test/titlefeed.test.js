/* Page-title market-cap signal.
 *
 * Terminals publish the live market cap in document.title, and a title change
 * fires the instant the site re-renders — no network, no polling. That makes it
 * the cheapest change signal available.
 *
 * The danger is treating it as truth. A competing extension parses this same
 * title and divides by a hardcoded 1e9 supply to infer a price, which is wrong
 * for any token whose supply is not exactly one billion. These tests pin the
 * rule that keeps the signal useful without letting it corrupt a fill.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadTitleFeed(doc) {
  const win = {};
  win.window = win;
  const ctx = vm.createContext({
    window: win, self: win,
    document: doc || undefined,
    MutationObserver: function (cb) {
      this.cb = cb;
      this.observe = () => {};
      this.disconnect = () => {};
    },
    Set, Map, Math, Number, String, Array, Object, Boolean, JSON,
    isFinite, parseFloat, parseInt,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'title-feed.js'), 'utf8'), ctx, {
    filename: 'title-feed.js',
  });
  return win.PTTitleFeed;
}

/* ---------------- parsing real titles ---------------- */

test('a real GMGN title yields its market cap', () => {
  const T = loadTitleFeed();
  // Captured live from gmgn.ai.
  const mcap = T.parseTitle('Bonk  $255.83M | GMGN.AI | The Fastest Multi-Chain Meme Trading Terminal', 'gmgn');
  assert.equal(mcap, 255830000);
});

test('magnitude suffixes across the whole memecoin range', () => {
  const T = loadTitleFeed();
  assert.equal(T.parseTitle('WIF $412K | Photon', 'padre'), 412000);
  assert.equal(T.parseTitle('MC: $1.2M — Photon', 'photon'), 1200000);
  assert.equal(T.parseTitle('JUP $2.5B | Axiom', 'axiom'), 2500000000);
  assert.equal(T.parseTitle('PEPE $89,400 | Padre', 'padre'), 89400);
});

test('a title with no market cap yields nothing rather than a guess', () => {
  const T = loadTitleFeed();
  for (const title of ['GMGN.AI', '', 'Loading…', 'Padre', null, undefined]) {
    assert.equal(T.parseTitle(title, 'gmgn'), null, `"${title}" must not produce a number`);
  }
});

test('a stray small dollar figure is not mistaken for a market cap', () => {
  const T = loadTitleFeed();
  // A unit price in the title must never be read as a cap.
  assert.equal(T.parseTitle('BONK $0.000039 | GMGN', 'gmgn'), null,
    'a sub-$100 figure is not a market cap');
});

/* ---------------- the guard that matters ---------------- */

test('a title figure is refused when there is no on-chain anchor to check it against', () => {
  const T = loadTitleFeed();
  assert.equal(T.validate(255830000, null), null,
    'without chain state there is nothing to validate against');
  assert.equal(T.validate(255830000, 0), null);
});

test('a title figure consistent with chain state is accepted', () => {
  const T = loadTitleFeed();
  const anchor = 255830000;
  assert.equal(T.validate(258000000, anchor), 258000000, 'a normal move must pass');
  assert.equal(T.validate(anchor * 2.5, anchor), anchor * 2.5, 'a violent but real move must pass');
});

test('a price/market-cap mix-up is rejected instead of corrupting the display', () => {
  const T = loadTitleFeed();
  const anchor = 255830000;
  // This is the exact failure mode of dividing a scraped figure by a
  // hardcoded supply: the result is off by orders of magnitude.
  assert.equal(T.validate(0.0000039, anchor), null, 'a unit price must never pass as a cap');
  assert.equal(T.validate(anchor * 1000, anchor), null, 'an absurd jump must be rejected');
});

test('the accept band is tight enough to catch a supply-assumption error', () => {
  const T = loadTitleFeed();
  // A token with 1e15 supply parsed with a 1e9 assumption is off by 1e6.
  const anchor = 255830000;
  assert.equal(T.validate(anchor / 1e6, anchor), null,
    'a wrong-supply figure must never be accepted');
});

/* ---------------- observer wiring ---------------- */

test('a title change emits a validated market cap without any network call', () => {
  let titleValue = 'Bonk  $255.83M | GMGN.AI';
  const titleNode = {};
  const doc = {
    get title() { return titleValue; },
    querySelector: () => titleNode,
  };
  const T = loadTitleFeed(doc);

  const seen = [];
  T.onMarketCap((mcap) => seen.push(mcap));
  T.start('gmgn', () => 255830000);

  assert.deepEqual(seen, [255830000], 'the initial title must be read immediately');
});

test('a title the anchor disagrees with never reaches a listener', () => {
  const doc = {
    get title() { return 'Bonk  $12 | GMGN.AI'; },
    querySelector: () => ({}),
  };
  const T = loadTitleFeed(doc);

  const seen = [];
  T.onMarketCap((mcap) => seen.push(mcap));
  T.start('gmgn', () => 255830000);

  assert.deepEqual(seen, [], 'an implausible title figure must be dropped silently');
});

/* ---------------- the mistake we are not making ---------------- */

test('the title feed never derives a token price from an assumed supply', () => {
  const src = fs.readFileSync(path.join(ROOT, 'title-feed.js'), 'utf8');
  // The dangerous pattern is DIVIDING by an assumed supply, not the magnitude
  // suffix map (where 1e9 legitimately means "B").
  assert.doesNotMatch(src, /TOTAL_SUPPLY/,
    'a hardcoded total supply has no correct use here');
  assert.doesNotMatch(src, /\/\s*(TOTAL_SUPPLY|1e9\b|1000000000)/,
    'inferring price by dividing by an assumed supply is wrong for any token that is not exactly 1e9');
  assert.doesNotMatch(src, /priceNative|priceUsd\s*=/,
    'the title signal must never produce a fill price');
});

test('fills are priced from chain state, never from the title', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  // The action-time quote must consult the chain, not the title cache.
  assert.match(content, /R\.onchainQuote\(startMint\)/,
    'a fill must ask the chain for its price');
  assert.doesNotMatch(content, /titleMcap[^)]*priceNative\s*=/,
    'the title signal must never be turned into a fill price');
});
