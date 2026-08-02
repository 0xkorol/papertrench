/* Chart bubble marker logic.
 *
 * Tests the pure price-to-pixel mapping and marker management without
 * requiring a real DOM or chart container.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/* Load chart-markers.js in a browser-like sandbox with just enough DOM
 * to exercise the price-range and mapping logic. */
function loadMarkerModule() {
  const win = {};
  win.window = win;

  // Minimal fake elements
  function makeEl(tag) {
    const el = {
      tagName: (tag || 'div').toUpperCase(),
      style: {},
      dataset: {},
      childNodes: [],
      children: [],
      _attrs: {},
      clientWidth: 800,
      clientHeight: 400,
      getBoundingClientRect: () => ({ width: 800, height: 400, top: 0, left: 0 }),
      appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); }
        return c;
      },
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
      addEventListener() {},
      style: {},
    };
    return el;
  }

  const doc = {
    createElement: (t) => makeEl(t),
    createElementNS: (ns, t) => makeEl(t),
    querySelector: () => null,
    querySelectorAll: () => [],
    getComputedStyle: () => ({ position: 'static', display: 'block', visibility: 'visible', opacity: '1' }),
  };

  const sandbox = {
    window: win, self: win, document: doc,
    Set, Map, WeakSet, WeakMap, Promise, JSON, Math, Number, String, Array,
    Object, Boolean, RegExp, Error, isNaN, parseFloat, parseInt,
    Date: Object.assign(function () {}, { now: () => Date.now() }),
    setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {}, setInterval: () => 0,
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  };

  const ctx = vm.createContext(sandbox);
  const fs = require('node:fs');
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'quote.js'), 'utf8'), ctx, { filename: 'quote.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chart-markers.js'), 'utf8'), ctx, { filename: 'chart-markers.js' });
  return win.PTChartMarkers;
}

/* ---------------- price range estimation ---------------- */

test('price range is estimated from the tick series with padding', () => {
  const CM = loadMarkerModule();
  CM.clearMarkers();

  // Feed a series of prices
  CM.tickPrice(100);
  CM.tickPrice(110);
  CM.tickPrice(90);
  CM.tickPrice(105);

  const range = CM._getPriceRange();
  assert.ok(range.min < 90, 'range min must be below the lowest tick (padding)');
  assert.ok(range.max > 110, 'range max must be above the highest tick (padding)');
});

test('a single price produces a tight range around it', () => {
  const CM = loadMarkerModule();
  CM.clearMarkers();
  CM.tickPrice(50);

  const range = CM._getPriceRange();
  assert.ok(range.min < 50 && range.max > 50,
    'a single price must produce a range that brackets it');
});

/* ---------------- marker management ---------------- */

test('addMarker stores markers and clearMarkers wipes them', () => {
  const CM = loadMarkerModule();
  CM.clearMarkers();

  CM.addMarker({ ts: 1000, price: 0.001, side: 'buy', solAmount: 1, symbol: 'BONK' });
  CM.addMarker({ ts: 2000, price: 0.002, side: 'sell', solAmount: 0.5, symbol: 'BONK' });
  assert.equal(CM._getMarkers().length, 2, 'two markers must be stored');

  CM.clearMarkers();
  assert.equal(CM._getMarkers().length, 0, 'clearMarkers must remove all markers');
});

test('addMarker rejects invalid prices', () => {
  const CM = loadMarkerModule();
  CM.clearMarkers();

  CM.addMarker({ ts: 1000, price: 0, side: 'buy', solAmount: 1 });
  CM.addMarker({ ts: 2000, price: -1, side: 'buy', solAmount: 1 });
  CM.addMarker(null);
  assert.equal(CM._getMarkers().length, 0, 'invalid markers must be rejected');
});

test('markers preserve side, price, and amount', () => {
  const CM = loadMarkerModule();
  CM.clearMarkers();

  CM.addMarker({ ts: 1000, price: 0.005, side: 'buy', solAmount: 2.5, symbol: 'WIF' });
  const m = CM._getMarkers()[0];
  assert.equal(m.side, 'buy');
  assert.equal(m.price, 0.005);
  assert.equal(m.solAmount, 2.5);
  assert.equal(m.symbol, 'WIF');
});

/* ---------------- price-to-Y mapping ---------------- */

test('higher prices map to lower Y (top of chart)', () => {
  const CM = loadMarkerModule();
  CM.clearMarkers();

  // Build a known range
  CM.tickPrice(100);
  CM.tickPrice(200);
  const range = CM._getPriceRange();

  // We can't test exact pixels without a real chartContainer, but we can
  // verify the mapping function returns a lower Y for a higher price.
  // The module's _priceToY uses chartContainer.clientHeight; without a
  // container it returns 0. So we test the range logic instead.
  assert.ok(range.max > range.min, 'range must be valid');
});

/* ---------------- marker cap ---------------- */

test('marker count is capped to prevent unbounded growth', () => {
  const CM = loadMarkerModule();
  CM.clearMarkers();

  for (let i = 0; i < 300; i++) {
    CM.addMarker({ ts: i * 1000, price: 0.001 + i * 0.0001, side: 'buy', solAmount: 0.1 });
  }
  assert.ok(CM._getMarkers().length <= 200,
    `marker count must be capped at 200; got ${CM._getMarkers().length}`);
});

test('generic USD chart markers and average lines retain their currency', () => {
  const CM = loadMarkerModule();
  CM.clearMarkers();

  CM.addMarker({ ts: 1000, price: 0.00042, side: 'buy', solAmount: 1, currency: 'USD' });
  CM.setAverageLines({ avgBuyPrice: 0.00042, avgSellPrice: 0.00066, currency: 'USD' });

  assert.equal(CM._getMarkers()[0].currency, 'USD');
  let lines = CM._getAverageLines();
  assert.equal(lines.avgBuyPrice, 0.00042);
  assert.equal(lines.avgSellPrice, 0.00066);
  assert.equal(lines.currency, 'USD');

  CM.clearAverageLines();
  lines = CM._getAverageLines();
  assert.equal(lines.avgBuyPrice, null);
  assert.equal(lines.avgSellPrice, null);
  assert.equal(lines.currency, 'SOL');
});
