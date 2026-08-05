/* Honest chart marker rail (the non-native fallback).
 *
 * The old SVG overlay fabricated its own geometry: a price range invented
 * from observed ticks with out-of-range levels GLUED to the chart edge
 * (C-02), single fills at exact mid-height (C-03), X positions by
 * rank-in-array instead of time (C-04) — precise labels on made-up
 * positions, with zero pan/zoom awareness. The tests that pinned that
 * behavior (price-range estimation, priceToY mapping) are deliberately
 * REPLACED here: the honest rail lists fills and average LEVELS pinned to
 * the chart edge and claims no Y position at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/* Load chart-markers.js in a browser-like sandbox with just enough DOM
 * to exercise the rail's lifecycle: a swappable fake chart container (for
 * the C-11 detach/re-find contract), recorded MutationObserver instances
 * (for the C-24 self-write filter), an optional body + elementFromPoint
 * (for the O-23/C-25 corner dock), a deterministic clock, and a flush()
 * that runs the debounced render. */
function loadMarkerHarness(opts = {}) {
  const win = {};
  win.window = win;
  win.innerWidth = 1280;
  win.innerHeight = 800;

  // Minimal fake elements
  function makeEl(tag) {
    const el = {
      nodeType: 1,
      tagName: (tag || 'div').toUpperCase(),
      style: {},
      dataset: {},
      childNodes: [],
      children: [],
      _attrs: {},
      className: '',
      textContent: '',
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
    };
    return el;
  }

  let containerVisible = Boolean(opts.withContainer);
  let container = makeEl('div');
  container.className = 'chart-container';

  let elementFromPoint = null; // installable per test (corner-dock probes)

  const doc = {
    createElement: (t) => makeEl(t),
    createElementNS: (ns, t) => makeEl(t),
    querySelector: () => null,
    querySelectorAll: (sel) => (containerVisible && String(sel).includes('chart') ? [container] : []),
    contains: (n) => containerVisible && n === container,
    getComputedStyle: () => ({ position: 'static', display: 'block', visibility: 'visible', opacity: '1' }),
  };
  if (opts.withBody) {
    doc.body = makeEl('body');
  }
  Object.defineProperty(doc, 'elementFromPoint', {
    get() { return elementFromPoint || undefined; },
    configurable: true,
  });

  const intervals = new Map();
  let intervalSeq = 0;
  const pendingTimeouts = [];
  const observers = [];
  let now = 1_800_000_000_000;

  const sandbox = {
    window: win, self: win, document: doc,
    Set, Map, WeakSet, WeakMap, Promise, JSON, Math, Number, String, Array,
    Object, Boolean, RegExp, Error, isNaN, parseFloat, parseInt,
    Date: Object.assign(function () {}, { now: () => now }),
    getComputedStyle: () => ({ position: 'static', display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: (fn) => { pendingTimeouts.push(fn); return pendingTimeouts.length; },
    clearTimeout: () => {},
    setInterval: (fn) => { const id = ++intervalSeq; intervals.set(id, fn); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    MutationObserver: function (callback) {
      this.callback = callback;
      this.target = null;
      this.observe = (target) => { this.target = target; };
      this.disconnect = () => { this.target = null; };
      observers.push(this);
    },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'quote.js'), 'utf8'), ctx, { filename: 'quote.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chart-markers.js'), 'utf8'), ctx, { filename: 'chart-markers.js' });
  return {
    CM: win.PTChartMarkers,
    get container() { return container; },
    doc,
    intervals,
    observers,
    showContainer: () => { containerVisible = true; },
    /** C-11: the site replaced its chart node — old one detached, fresh one live. */
    swapContainer: () => {
      const fresh = makeEl('div');
      fresh.className = 'chart-container';
      container = fresh;
      containerVisible = true;
      return fresh;
    },
    setElementFromPoint: (fn) => { elementFromPoint = fn; },
    advance: (ms) => { now += ms; },
    flush: () => { for (const fn of pendingTimeouts.splice(0)) fn(); },
  };
}

function loadMarkerModule() {
  return loadMarkerHarness().CM;
}

/** All text rendered inside a fake element subtree. */
function textOf(el) {
  if (!el) return '';
  let out = String(el.textContent || '');
  for (const child of el.children || []) out += ' ' + textOf(child);
  return out;
}

function railsIn(parent) {
  return (parent.children || []).filter((c) => c._attrs && c._attrs.id === 'papertrench-chart-overlay');
}

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

/* ---------------- C-02/C-03/C-04: the fabricated positioning is GONE ------ */

test('C-02/C-03/C-04: no fabricated price/time positioning remains — the rail lists, it does not place', () => {
  const src = fs.readFileSync(path.join(ROOT, 'chart-markers.js'), 'utf8');
  // The plotting machinery is deleted, not merely unused: a price-to-pixel
  // mapping without the host chart's own scale is a fabrication. (Match code
  // shapes, not the comments that describe the deleted behavior.)
  assert.doesNotMatch(src, /function (priceToY|timeToX|updatePriceRange)/,
    'the invented coordinate mapping must be deleted (C-02/C-03/C-04)');
  assert.doesNotMatch(src, /priceRange\s*=/,
    'no fabricated price range may be maintained');

  const CM = loadMarkerModule();
  assert.equal(CM._priceToY, undefined, 'no Y mapping may be exposed');
  assert.equal(CM._timeToX, undefined, 'no X mapping may be exposed');
  assert.equal(CM._getPriceRange, undefined, 'no fabricated range may be exposed');
});

test('fills orders of magnitude apart render as equal rail rows, not positioned bubbles', () => {
  const h = loadMarkerHarness({ withContainer: true });
  h.CM.initChartMarkers();
  // With the old fabricated range these two would have been glued to
  // opposite chart edges at invented heights.
  h.CM.addMarker({ ts: 1000, price: 0.0000001, side: 'buy', solAmount: 1, currency: 'USD' });
  h.CM.addMarker({ ts: 2000, price: 100, side: 'sell', solAmount: 0.5, currency: 'USD' });
  h.flush();

  const rail = railsIn(h.container).pop();
  assert.ok(rail, 'the rail must mount inside the chart container');
  const rows = rail.children.filter((c) => c.className === 'pt-rail-fill');
  assert.equal(rows.length, 2, 'each fill is one listed row');
  for (const row of rows) {
    assert.equal(row._attrs.cy, undefined, 'a row carries no fabricated Y coordinate');
    assert.equal(row._attrs.cx, undefined, 'a row carries no fabricated X coordinate');
  }
  assert.match(textOf(rows[0]), /S/, 'newest fill (the sell) is listed first');
});

test('C-27/C-28: no character-count width estimates remain (layout-engine sizing)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'chart-markers.js'), 'utf8');
  assert.doesNotMatch(src, /length \* 6\.2|length \* 6\.5|\.length \* \d/,
    'label/tooltip widths must not be estimated from character counts');
  assert.match(src, /width:max-content/,
    'rows and chips must size themselves through the layout engine');
});

/* ---------------- C-10: value-based render guard ---------------- */

test('C-10: a changed average level repaints even when the marker count is unchanged', () => {
  const h = loadMarkerHarness({ withContainer: true });
  h.CM.initChartMarkers();
  h.CM.setAverageLines({ avgBuyPrice: 100, currency: 'USD' });
  h.flush();
  assert.match(textOf(railsIn(h.container).pop()), /100/,
    'the first level must be on the rail');

  // A cross-tab fill moves the average without changing the local marker
  // count — exactly what the old count-based guard skipped, silently
  // keeping the pre-fill level on screen.
  const renders = h.CM._getRenderCount();
  h.CM.setAverageLines({ avgBuyPrice: 150 });
  h.flush();
  assert.ok(h.CM._getRenderCount() > renders, 'the value change must render');
  assert.match(textOf(railsIn(h.container).pop()), /150/,
    'the rail must show the NEW average level');
});

test('C-10: an unchanged model does not rebuild the rail', () => {
  const h = loadMarkerHarness({ withContainer: true });
  h.CM.initChartMarkers();
  h.CM.addMarker({ ts: 1000, price: 5, side: 'buy', solAmount: 1, currency: 'USD' });
  h.flush();
  const renders = h.CM._getRenderCount();

  h.CM.tickPrice(5.0001); // ticks refresh age text at most once a minute
  h.flush();
  assert.equal(h.CM._getRenderCount(), renders,
    'a tick with no displayed-value change must not rebuild the rail');
});

/* ---------------- C-11: detached container re-discovery ---------------- */

test('C-11: a detached chart container is re-found and the rail re-mounts on the new node', () => {
  const h = loadMarkerHarness({ withContainer: true });
  h.CM.initChartMarkers();
  h.CM.addMarker({ ts: 1000, price: 1, side: 'buy', solAmount: 1, currency: 'USD' });
  h.flush();
  const oldContainer = h.container;
  assert.equal(railsIn(oldContainer).length, 1, 'the rail mounts on the original container');

  // TradingView reload / SPA re-render: the old node is detached, a fresh
  // one appears. The old code kept BOTH stale refs (truthy-but-detached)
  // and wrote into the dead subtree until the next token change.
  const fresh = h.swapContainer();
  h.CM.tickPrice(1.01); // any render trigger
  h.flush();

  assert.equal(railsIn(fresh).length, 1,
    'the rail must re-mount on the live container after a remount');
});

/* ---------------- C-24: the observer ignores our own writes ---------------- */

test('C-24: mutations originating inside the rail never schedule a render', () => {
  const h = loadMarkerHarness({ withContainer: true });
  h.CM.initChartMarkers();
  h.CM.addMarker({ ts: 1000, price: 1, side: 'buy', solAmount: 1, currency: 'USD' });
  h.flush();

  const observer = h.observers.find((o) => o.target === h.container);
  assert.ok(observer, 'the container must be observed');
  const rail = h.CM._getRailElement();
  assert.ok(rail && rail.children.length, 'the rail is mounted');

  // Simulate the site wiping the rail, then a mutation record that points
  // INSIDE our own subtree: the filter must swallow it (no self-feedback).
  h.container.removeChild(rail);
  observer.callback([{ target: rail.children[0] }]);
  h.flush();
  assert.equal(railsIn(h.container).length, 0,
    'a self-originated record must not trigger a re-render');

  // An EXTERNAL mutation (the site re-rendered around us) does re-render,
  // which also restores the wiped rail.
  observer.callback([{ target: h.container }]);
  h.flush();
  assert.equal(railsIn(h.container).length, 1,
    'an external mutation must re-render and restore the rail');
});

/* ---------------- O-23/C-25: fallback strip docks to a free corner --------- */

test('O-23/C-25: the fallback strip is not hardcoded under the panel and dodges occupied corners', () => {
  const src = fs.readFileSync(path.join(ROOT, 'chart-markers.js'), 'utf8');
  // Match the quoted CSS strings the old code shipped, not the comment that
  // documents their removal.
  assert.doesNotMatch(src, /'top:140px'|'right:360px'/,
    'the old hardcoded panel-adjacent position must be gone');

  const h = loadMarkerHarness({ withBody: true }); // no chart container at all
  h.CM.initChartMarkers();
  h.CM.addMarker({ ts: 1000, price: 1, side: 'buy', solAmount: 1, currency: 'USD' });
  h.flush();
  let strip = h.doc.body.children[h.doc.body.children.length - 1];
  assert.ok(strip && strip._attrs.id === 'papertrench-chart-fallback', 'the strip renders on body');
  assert.match(strip.style.cssText, /left:12px;bottom:12px/,
    'with no occupancy signal the strip docks bottom-left (away from the default panel)');

  // The PaperTrench panel now sits at bottom-left: the probe reports the
  // shadow host there, so the next render must dock elsewhere.
  h.setElementFromPoint((x, y) => (x < 100 && y > 700 ? { id: 'papertrench-host' } : null));
  h.CM.addMarker({ ts: 2000, price: 2, side: 'sell', solAmount: 1, currency: 'USD' });
  h.flush();
  strip = h.doc.body.children[h.doc.body.children.length - 1];
  assert.match(strip.style.cssText, /right:12px;bottom:12px/,
    'an occupied corner must be dodged, not sat under');
});

/* ---------------- lifecycle: DEFECTS C-21 / C-22 ---------------- */

test('C-21: a re-init that finds the chart immediately retires the previous scan interval', () => {
  const h = loadMarkerHarness(); // container NOT discoverable yet
  h.CM.initChartMarkers();
  assert.equal(h.intervals.size, 1, 'with no container the scanner must start polling');

  // The chart mounts, and the caller re-inits (SPA nav / token switch). The
  // early "found it" return used to skip clearInterval, leaking the old
  // scanner from the first init.
  h.showContainer();
  h.CM.initChartMarkers();
  assert.equal(h.intervals.size, 0,
    'a successful re-init must retire the previous scan interval, not leak it');

  h.CM.destroyChartMarkers();
  assert.equal(h.intervals.size, 0, 'destroy leaves no interval behind');
});

test('C-22: the first render after destroy + re-init is not skipped by the stale memo', () => {
  const h = loadMarkerHarness({ withContainer: true });
  h.CM.initChartMarkers();
  h.CM.addMarker({ ts: 1000, price: 0.001, side: 'buy', solAmount: 1, symbol: 'BONK' });
  h.flush(); // debounced render fires

  const first = railsIn(h.container)[0];
  assert.ok(first && first.children.length > 0, 'the first mount must render the marker');

  h.CM.destroyChartMarkers();
  h.CM.initChartMarkers();
  // Same marker values as before the destroy: exactly the state the old
  // memo compared equal against and skipped.
  h.CM.addMarker({ ts: 1000, price: 0.001, side: 'buy', solAmount: 1, symbol: 'BONK' });
  h.flush();

  const second = railsIn(h.container).pop();
  assert.ok(second && second !== first, 'a re-init mounts a fresh rail');
  assert.ok(second.children.length > 0,
    'the render-skip memo must reset on destroy — the first render after re-init must draw');
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
