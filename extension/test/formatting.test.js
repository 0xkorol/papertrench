/* Readable numbers.
 *
 * Users reported "random unreadable numbers" in the overlay. The cause was
 * `toExponential`, which renders a normal memecoin price as "3.9690e-8", plus
 * raw decimals that render as an uncountable run of zeros.
 *
 * These tests pin the readable contract across the whole memecoin range.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadQuote() {
  const win = {};
  win.window = win;
  const sandbox = {
    window: win, self: win,
    Math, Number, String, Array, Object, Boolean, JSON, Date,
    isFinite, isNaN, parseInt, parseFloat,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'quote.js'), 'utf8'), ctx, {
    filename: 'quote.js',
  });
  return win.PaperQuote;
}

test('no price anywhere in the memecoin range renders as scientific notation', () => {
  const Q = loadQuote();
  const prices = [
    0.000000001, 0.00000003969, 0.0000004, 0.0000123,
    0.00042, 0.00234, 0.05, 1.5, 187.42, 25000,
  ];
  for (const p of prices) {
    const text = Q.formatPrice(p);
    assert.doesNotMatch(text, /e[+-]/i,
      `formatPrice(${p}) produced scientific notation: "${text}"`);
    assert.notEqual(text, '', `formatPrice(${p}) must render something`);
  }
});

test('a sub-cent price uses subscript-zero notation instead of a wall of zeros', () => {
  const Q = loadQuote();
  // The real BONK price at capture time.
  const text = Q.formatPrice(0.00000003969);
  assert.match(text, /^0\.0[₀-₉]/,
    `expected subscript-zero notation, got "${text}"`);
  assert.ok(text.includes('₇'),
    `0.00000003969 has 7 leading zeros, so the subscript must be ₇; got "${text}"`);
  assert.ok(text.includes('3969'),
    `the significant digits must survive; got "${text}"`);
  assert.ok(text.length < 14, `the result must stay compact; got "${text}"`);
});

test('an ordinary price is left alone rather than dressed up', () => {
  const Q = loadQuote();
  assert.equal(Q.formatPrice(1.5), '1.5');
  assert.equal(Q.formatPrice(0.00234), '0.00234');
});

test('market caps read as money, never as digit soup', () => {
  const Q = loadQuote();
  assert.equal(Q.formatMarketCap(255830000), '$255.83M');
  assert.equal(Q.formatMarketCap(1234000000), '$1.23B');
  assert.equal(Q.formatMarketCap(45600), '$45.6K');
  assert.equal(Q.formatMarketCap(842.5), '$842.50');
});

test('a market cap never renders in scientific notation', () => {
  const Q = loadQuote();
  for (const n of [999, 45600, 255830000, 1234000000, 5.5e12]) {
    assert.doesNotMatch(Q.formatMarketCap(n), /e[+-]/i,
      `formatMarketCap(${n}) leaked scientific notation`);
  }
});

test('missing or nonsense values render as empty, never as NaN or Infinity', () => {
  const Q = loadQuote();
  for (const bad of [0, -1, null, undefined, NaN, Infinity, 'abc']) {
    assert.equal(Q.formatPrice(bad), '', `formatPrice(${bad}) must be empty`);
    assert.equal(Q.formatMarketCap(bad), '', `formatMarketCap(${bad}) must be empty`);
  }
});

test('a USD price carries its dollar sign and stays readable', () => {
  const Q = loadQuote();
  const text = Q.formatUsdPrice(0.0000029);
  assert.ok(text.startsWith('$'), `expected a leading $, got "${text}"`);
  assert.doesNotMatch(text, /e[+-]/i, `USD price leaked scientific notation: "${text}"`);
});

test('the overlay routes its price and market-cap text through the shared formatters', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  // The two overlay helpers must delegate rather than re-implement.
  assert.match(src, /function trimSci\([^)]*\)\s*\{\s*return Q\.formatPrice/,
    'trimSci must delegate to the shared readable formatter');
  assert.match(src, /function fmtMoney\([^)]*\)\s*\{\s*return Q\.formatMarketCap/,
    'fmtMoney must delegate to the shared readable formatter');

  // And no stray toExponential may survive in the overlay.
  assert.doesNotMatch(src, /toExponential/,
    'content.js must not render scientific notation anywhere');
});
