/* Popup quick settings (lev: "nice to have these on the tab for quick fixes").
 *
 * The popup gains the handful of knobs people re-tune mid-session — starting
 * balance, quick-buy/quick-sell presets, a fee profile — with validation that
 * mirrors the dashboard EXACTLY. Two invariants this suite pins:
 *
 *   1. Non-destructive writes: the popup patches over a fresh storage read
 *      ({ ...settings, ...patch }); it never rebuilds the settings object, so
 *      every key it does not own survives untouched.
 *   2. Dashboard-parity validation (D-42/D-06): a bad value keeps the SAVED
 *      value and says so — it never silently becomes a default.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the popup exposes all four quick-settings fields and the apply button', () => {
  const html = read('popup.html');
  for (const id of ['qs-balance', 'qs-presets', 'qs-sellpcts', 'qs-fees', 'qs-apply']) {
    assert.match(html, new RegExp(`id="${id}"`), `popup.html must have #${id}`);
  }
  // The fee select must offer the same three rough starting points as the
  // dashboard's Fees & costs card, plus an explicit keep-current.
  for (const value of ['custom', 'bot', 'fast', 'zero']) {
    assert.match(html, new RegExp(`value="${value}"`), `fee profile "${value}" must be offered`);
  }
});

test('applyQuickSettings patches over a fresh storage read — never a rebuild', () => {
  const src = read('popup.js');
  const fnStart = src.indexOf('async function applyQuickSettings');
  assert.ok(fnStart !== -1, 'applyQuickSettings must exist');
  const block = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2);
  assert.match(block, /chrome\.storage\.local\.get\(\['pt_settings'\]\)/,
    'the patch base must be a FRESH read, not the values load() rendered from');
  assert.match(block, /pt_settings: \{ \.\.\.settings, \.\.\.patch \}/,
    'the write must spread stored settings under the patch — foreign keys survive');
  assert.match(block, /pt_settings_changed/,
    'open tabs must be told, like every other settings writer');
});

test('validation mirrors the dashboard: rejected values keep the SAVED value and say so', () => {
  const src = read('popup.js');
  // Balance: same floor, same refuse-and-keep semantics as D-42/D-06.
  assert.match(src, /balanceNum >= 0\.1/, 'the 0.1 SOL floor must match the dashboard');
  assert.match(src, /rejected \(must be ≥ 0\.1 SOL\) — kept/,
    'a rejected balance must SAY it kept the saved value');
  // Preset lists: same bounds — positive, capped magnitude, max 8, dedupe
  // where repeats are meaningless.
  assert.match(src, /n > 0 && n <= max/, 'list entries must be positive and bounded');
  assert.match(src, /values\.length > 8/, 'the 8-button cap must match the dashboard');
  assert.match(src, /parseNumberList\(\$\('qs-presets'\)\.value, 1000/, 'buy presets bounded at 1000 SOL');
  assert.match(src, /parseNumberList\(\$\('qs-sellpcts'\)\.value, 100, [^)]*\{ dedupe: true \}/,
    'sell percents bounded at 100 and deduplicated');
});

test('the popup fee profiles carry the same numbers as the dashboard quick fill-in', () => {
  const popup = read('popup.js');
  const dash = read('dashboard.js');
  // Dashboard: bot { fee: 100, gas: 0.001, tip: 0.001, slip: 0 } etc.
  const dashBlockStart = dash.indexOf("bot: { fee: 100");
  assert.ok(dashBlockStart !== -1, 'the dashboard quick fill-in presets must exist');
  const expectations = {
    bot: { feeBps: 100, gasSolPerTx: 0.001, tipSolPerTx: 0.001, slippageBps: 0 },
    fast: { feeBps: 100, gasSolPerTx: 0.003, tipSolPerTx: 0.005, slippageBps: 50 },
    zero: { feeBps: 0, gasSolPerTx: 0, tipSolPerTx: 0, slippageBps: 0 },
  };
  for (const [name, p] of Object.entries(expectations)) {
    const re = new RegExp(`${name}: \\{ feeBps: ${p.feeBps}, gasSolPerTx: ${p.gasSolPerTx}, tipSolPerTx: ${p.tipSolPerTx}, slippageBps: ${p.slippageBps} \\}`);
    assert.match(popup, re, `popup fee profile "${name}" must match the dashboard's numbers`);
    // And the dashboard side must still say the same thing, so a future edit
    // to either card breaks this test instead of silently forking the two.
    const dashRe = new RegExp(`${name}: \\{ fee: ${p.feeBps}, gas: ${p.gasSolPerTx}, tip: ${p.tipSolPerTx}, slip: ${p.slippageBps} \\}`);
    assert.match(dash, dashRe, `dashboard fee preset "${name}" changed — update the popup profiles together`);
  }
});

test('quick-settings fields are filled once, not clobbered on every toggle re-render', () => {
  const src = read('popup.js');
  assert.match(src, /if \(qsFilled\) return;/,
    'load() re-runs after every toggle; re-filling would clobber mid-typed values');
  assert.match(src, /qsFilled = false; \/\/ re-fill from what was actually saved/,
    'after an apply the fields must re-fill from the accepted values');
});
