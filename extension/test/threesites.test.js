/* GMGN, Padre and Axiom must all show bubbles and average lines.
 *
 * These are the three terminals the product is judged on. A marker that drifts
 * off its candle when the user pans is worse than no marker, so each site is
 * driven through its OWN chart API wherever one exists:
 *
 *   Padre  — TradingView getMarks + createOrderLine
 *   Axiom  — same TradingView library, discovered by widget shape
 *   GMGN   — React-held chart manager: createExecutionShape + createOrderLine
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
const sites = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

/* ---------------- all three sites are recognised ---------------- */

test('all three headline sites have a URL adapter', () => {
  for (const id of ['gmgn', 'padre', 'axiom']) {
    assert.match(sites, new RegExp(`id: '${id}'`), `${id} must have a site adapter`);
  }
});

/* ---------------- native chart routing ---------------- */

test('Padre and Axiom both take the native TradingView path', () => {
  assert.match(content, /NATIVE_TV_SITES = new Set\(\['padre', 'axiom'\]\)/,
    'Axiom loads the same TradingView library as Padre and must use the same path');
});

test('no chart decision is hardcoded to Padre alone any more', () => {
  assert.doesNotMatch(content, /site\.id === 'padre'/,
    'every native-chart branch must go through usesNativeChart() so Axiom is included');
  assert.doesNotMatch(content, /site\.id !== 'padre'/,
    'the generic fallback must not be defined as "not Padre"');
});

test('the TradingView widget is found by shape, not by one hardcoded global', () => {
  assert.match(bridge, /function findTradingViewWidget/,
    'the bridge must discover the widget rather than assume window.tvWidget');
  assert.match(bridge, /function looksLikeWidget/,
    'shape matching is what survives a site renaming its minified global');
  assert.doesNotMatch(bridge, /const widget = window\.tvWidget/,
    'no code path may depend on Padre naming its widget tvWidget');
});

/* ---------------- bubbles on every site ---------------- */

test('one code path draws a fill on whichever chart is in front of us', () => {
  assert.match(content, /function drawFillOnChart/,
    'fills must be drawn through a single routed helper');

  // A buy, a sell and a journal restore must all use it.
  const uses = content.match(/drawFillOnChart\(/g) || [];
  assert.ok(uses.length >= 4,
    `buy, sell and journal restore must all draw through it; found ${uses.length} uses`);
});

test('GMGN fills are drawn as native execution shapes on its own chart', () => {
  assert.match(content, /sendPadreMarker\('gmgn-marker'/,
    'GMGN fills must be sent to its native chart, not only to the SVG overlay');
  assert.match(bridge, /function addGmgnFillMarker/,
    'the bridge must implement a native GMGN fill marker');
  assert.match(bridge, /createExecutionShape/,
    'TradingView execution shapes are how a fill stays anchored to its candle');
});

test('a GMGN fill marker is positioned on the market-cap axis it actually uses', () => {
  assert.match(bridge, /const level = numberValue\(payload && payload\.mcap\)/,
    "GMGN's axis is market cap, so the marker must be placed by market cap");
});

test('GMGN markers are cleared with its lines so a token switch leaves nothing behind', () => {
  assert.match(bridge, /function clearGmgnFillMarkers/);
  assert.match(bridge, /gmgn-lines-clear'[\s\S]{0,220}clearGmgnFillMarkers\(\)/,
    'clearing GMGN chart state must remove markers as well as lines');
});

/* ---------------- average lines on every site ---------------- */

test('every headline site has a route for average price lines', () => {
  // Padre + Axiom via the shared native path.
  assert.match(content, /if \(usesNativeChart\(\)\) \{[\s\S]{0,600}sendPadreMarker\('paper-lines'/,
    'Padre and Axiom must draw native order lines');
  // GMGN via its own chart manager.
  assert.match(content, /sendPadreMarker\('gmgn-lines'/,
    'GMGN must draw native order lines through its chart manager');
  assert.match(bridge, /function syncGmgnAverageLines/);
});

test('average lines are labelled in market cap, the unit traders read', () => {
  assert.match(content, /PT Avg Buy \$\{Q\.formatMarketCap/);
  assert.match(content, /PT Avg Sell \$\{Q\.formatMarketCap/);
});

/* ---------------- status honesty ---------------- */

test('the status line names the actual site rather than always saying Padre', () => {
  assert.doesNotMatch(content, /`Padre · \$\{live\}/,
    'the status line must not hardcode Padre now that Axiom shares the path');
  // Wave 1 (F-B4): the footer names the site + the honest warnings only;
  // hook telemetry (feed/marks/lines) lives in the live-dot tooltip.
  assert.match(content, /\$\{site\.name\}\$\{feed\}\$\{rug\}/,
    'the connected site must be named honestly');
  assert.match(content, /liveDot\.title = detail/,
    'the hook detail must still exist — in the tooltip, not on screen');
});

/* ---------------- the fallback still exists ---------------- */

test('a site with no chart API still gets SVG markers rather than nothing', () => {
  assert.match(content, /if \(CM\) \{\s*\n\s*CM\.addMarker\(/,
    'Dexscreener, Birdeye and friends must still show fills via the overlay');
});
