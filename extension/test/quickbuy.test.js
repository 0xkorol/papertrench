/* One-click quick buy — tapping a preset amount fires the order immediately,
 * like Axiom and Padre, instead of only selecting it for the BUY button.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

test('instant buy defaults on and old settings merge to it', () => {
  assert.equal(E.DEFAULT_SETTINGS.instantBuyEnabled, true);
  assert.equal(E.mergeSettings({}).instantBuyEnabled, true,
    'an install from before the setting must land on the one-click default');
  assert.equal(E.mergeSettings({ instantBuyEnabled: false }).instantBuyEnabled, false,
    'a deliberate opt-out is never overridden');
});

test('preset taps route through the shared buy path when instant is on', () => {
  // The same requestBuy() must serve both the preset tap and the BUY button,
  // so arming for unresolved tokens and the in-flight guard apply to both.
  assert.match(content, /if \(instant\) requestBuy\(Number\(b\.dataset\.amt\)\)/,
    'a preset tap must fire the order when one-click quick buy is enabled');
  assert.match(content, /if \(!\(amt > 0\)\) return toast\('Pick a SOL amount first'\);\s*\n\s*requestBuy\(amt\);/,
    'the BUY button must use the same shared path');
  assert.match(content, /let buyInFlight = false;/,
    'rapid taps must be guarded against stacking fills');
  assert.match(content, /buyInFlight = true;\s*\n\s*doBuy\(amt\)\.finally\(\(\) => \{ buyInFlight = false; \}\);/,
    'the guard must release when the buy settles');
});

test('the settings page exposes the one-click toggle', () => {
  assert.match(dashJs, /id="set-instant-buy"/);
  assert.match(dashJs, /instantBuyEnabled: document\.getElementById\('set-instant-buy'\)\.checked/,
    'the toggle must be persisted with the rest of the settings');
});

test('the quick-buy controls live in their own labeled card (discoverability)', () => {
  // Reported: a user could not FIND the QB toggle. The controls existed but
  // were buried mid-list inside "Wallet & Trading". They now sit in a card
  // literally titled "Quick-buy (QB)", so searching for QB lands on them.
  const cardOpen = dashJs.indexOf('<h3>Quick-buy (QB)</h3>');
  assert.ok(cardOpen !== -1, 'a "Quick-buy (QB)" settings card must exist');
  // Every QB control must come AFTER the card heading (i.e. inside the card,
  // not scattered elsewhere in the page).
  for (const id of ['set-presets', 'set-instant-buy', 'set-list-quick-buy', 'set-panel-buy', 'set-panel-presets']) {
    const at = dashJs.indexOf(`id="${id}"`);
    assert.ok(at !== -1, `${id} must exist`);
    assert.ok(at > cardOpen, `${id} must live inside the Quick-buy card`);
  }
});

/* ---------------- screener row quick buys ---------------- */

const sites = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'content.css'), 'utf8');

test('row quick-buy chips are configured for Axiom, Padre and GMGN screener pages', () => {
  // Axiom Pulse / Discover rows link to /meme/<pair> and carry pump.fun icons;
  // the chip sits left of the site's own instant-buy button.
  assert.match(sites, /linkSelectors: \['a\[href\^="\/meme\/"\]', 'a\[href\*="pump\.fun\/coin\/"\]'/);
  assert.match(sites, /placement: 'before-buy-button'/);
  // GMGN Trenches cards navigate by JS but carry /sol/token/ + pump.fun links.
  assert.match(sites, /linkSelectors: \['a\[href\*="\/sol\/token\/"\]', 'a\[href\*="pump\.fun\/coin\/"\]'/);
  // Padre Trenches cards link absolutely to /trade/solana/<mint>.
  assert.match(sites, /linkSelectors: \['a\[href\*="\/trade\/solana\/"\]', 'a\[href\*="pump\.fun\/coin\/"\]'/);
  // Badge placement keeps the chip off the cards' content entirely.
  assert.match(sites, /placement: 'badge'/);
  // Coverage: icon-cluster links also carry the address (solscan).
  assert.match(sites, /solscan\.io\/token/);
  // Each is gated to its screener paths, never the chart pages.
  assert.match(sites, /listPaths:[\s\S]{0,40}pulse\|discover/);
});

test('row buys run the full fill pipeline and never navigate the row', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.match(content, /function scanRowBuys\(\)/);
  assert.match(content, /function doRowBuy\(/);
  // The MAIN-world bridge owns row scanning: only it can read React fibers.
  assert.match(bridge, /function scanScreenerRows\(spec\)/);
  assert.match(bridge, /function addressFromRowFiber\(row\)/);
  // Chips forward their tap back to the content script's fill pipeline.
  assert.match(bridge, /emit\('row-buy', \{ address: entry\.address \}\)/);
  assert.match(content, /ev\.type === 'row-buy'/);
  // The chip shows a busy state until the content script settles the fill.
  assert.match(bridge, /type === 'row-buy-done'/);
  assert.match(content, /sendPadreMarker\('row-buy-done', null\)/);
  // Taps are seen at the WINDOW capture phase, registered at document_start:
  // Padre installs its own capturing click handler that stops propagation,
  // so a listener on the chip element itself never fires.
  assert.match(bridge, /function handleRowChipTap\(ev\)/);
  assert.match(bridge, /window\.addEventListener\(type, handleRowChipTap, true\)/);
  assert.match(bridge, /\['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'\]/,
    'press events must be swallowed so the row never navigates from a chip tap');
  // The tap must not trigger the row's own navigation or click handlers.
  assert.match(bridge, /ev\.preventDefault\(\);\s*\n\s*ev\.stopPropagation\(\);\s*\n\s*ev\.stopImmediatePropagation\(\);/);
  // The fill goes through the engine and the attestation chain, like any buy.
  assert.match(content, /doRowBuy[\s\S]{0,1600}E\.buy\(state, settings/);
  assert.match(content, /doRowBuy[\s\S]{0,2400}commitFill\(trade\)/);
  // The screener's own realtime price is preferred when fresh.
  assert.match(content, /recentRowPrices/);
  // The new position surfaces immediately in the rail. (Window widened when
  // the F-04 freshness fix added its rationale comment to doRowBuy.)
  assert.match(content, /doRowBuy[\s\S]{0,2800}renderPositionsBar\(\)/);
  // The scanner runs on the positions-bar cadence, which works on pages with
  // no detected token — exactly the screener situation.
  assert.match(content, /renderPositionsBar\(\);\s*\n\s*\/\/ Screener rows render continuously; catch new ones on this cadence\.\s*\n\s*scanRowBuys\(\);/);
});

test('the row chip is styled for the page DOM and has a settings toggle', () => {
  assert.match(css, /\.pt-rowbuy \{/);
  assert.match(css, /\.pt-rowbuy\.busy/);
  assert.equal(E.DEFAULT_SETTINGS.listQuickBuyEnabled, true);
  assert.equal(E.mergeSettings({}).listQuickBuyEnabled, true);
  assert.equal(E.DEFAULT_SETTINGS.listQuickBuySize, 1.0);
  assert.equal(E.mergeSettings({}).listQuickBuySize, 1.0);
  assert.match(dashJs, /id="set-list-quick-buy"/);
  assert.match(dashJs, /listQuickBuyEnabled: document\.getElementById\('set-list-quick-buy'\)\.checked/);
  assert.match(dashJs, /id="set-list-quick-buy-size"/);
  assert.match(dashJs, /listQuickBuySize:/);
});

test('the row scan carries the user-chosen chip size to the bridge', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.match(content, /sendPadreMarker\('row-scan', \{[\s\S]{0,120}size:/,
    'content script must forward the chip size to the bridge');
  assert.match(bridge, /const size = Math\.max\(0\.6, Math\.min\(1\.5, numberValue\(spec && spec\.size\) \|\| 1\)\);/,
    'bridge must read the size from the scan spec');
  assert.match(bridge, /el\.style\.transform[^;]*scale\(/,
    'bridge must scale the chip with the user setting');
});

test('chips live in a fixed overlay layer and never enter the page DOM', () => {
  // Inserting foreign nodes into React-managed containers corrupts
  // reconciliation — on Axiom Pulse it crashed the whole list into an
  // error-boundary skeleton. Chips must render in our own layer only.
  const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.match(bridge, /rowChipLayer = document\.createElement\('div'\)/);
  assert.match(bridge, /rowChipLayer\.id = 'pt-rowbuy-layer'/);
  assert.match(bridge, /layer\.appendChild\(button\)/,
    'the chip must be appended to the layer, not to the row');
  assert.doesNotMatch(bridge, /row\.appendChild\(button\)/,
    'no code path may append a chip inside a page row');
  assert.doesNotMatch(bridge, /insertBefore\(button/,
    'no code path may splice a chip between page nodes');
  // The layer itself is inert; only the chips take pointer events.
  assert.match(css, /#pt-rowbuy-layer \{/);
  assert.match(css, /pointer-events: none/);
  assert.match(css, /pointer-events: auto/);
  // Chips are repositioned from row rects as the lists scroll and churn.
  assert.match(bridge, /function positionRowChip\(entry\)/);
  assert.match(bridge, /function sweepRowChips\(\)/);
  assert.match(bridge, /addEventListener\('scroll', scheduleRowChipReposition/);
  assert.match(bridge, /new MutationObserver\(scheduleRowChipReposition\)/);
});

test('fiber addresses accept only whole base58 values on address-like keys', () => {
  // Substring matches let EVM rows (0x…) and IPFS image CIDs sneak in as
  // fake Solana mints; image/url keys are never token identity.
  const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.match(bridge, /\^\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\$/);
  assert.match(bridge, /image\|img\|logo\|icon\|uri\|url\|banner/);
});

/* ---------------- removing quick buys from the trade tab ----------------
 *
 * Two independent user toggles: hide the one-tap preset row on its own, or
 * hide the entire buy section (label, presets, custom amount, BUY button)
 * for a view-only trade tab. Both default on.
 */

test('the buy toggles default on and migrate onto existing installs', () => {
  assert.equal(E.DEFAULT_SETTINGS.panelBuyEnabled, true);
  assert.equal(E.DEFAULT_SETTINGS.panelPresetsEnabled, true);
  assert.equal(E.mergeSettings({}).panelBuyEnabled, true,
    'an install from before the toggles must keep its buy section');
  assert.equal(
    E.mergeSettings({ settingsRevision: E.SETTINGS_REVISION, panelBuyEnabled: false }).panelBuyEnabled,
    false,
    'a deliberate opt-out recorded at the current revision is never overridden'
  );
});

test('the overlay hides exactly what each toggle controls', () => {
  assert.match(content, /settings\.panelBuyEnabled !== false/,
    'the buy-section master toggle must gate the section');
  assert.match(content, /settings\.panelPresetsEnabled !== false/,
    'the preset-row toggle must gate the preset buttons');
  // The master switch hides every buy control, not just the presets.
  for (const el of ['buyLabel', 'custom', 'btnBuy', 'buyPresets']) {
    assert.match(content, new RegExp('els\\.' + el + '\\) els\\.' + el + '\\.style\\.display'),
      `the visibility pass must cover ${el}`);
  }
});

test('the settings page exposes both removal toggles', () => {
  assert.match(dashJs, /id="set-panel-buy"/);
  assert.match(dashJs, /id="set-panel-presets"/);
  assert.match(dashJs, /panelBuyEnabled: document\.getElementById\('set-panel-buy'\)\.checked/,
    'the buy-section toggle must be persisted with the rest of the settings');
  assert.match(dashJs, /panelPresetsEnabled: document\.getElementById\('set-panel-presets'\)\.checked/,
    'the preset-row toggle must be persisted with the rest of the settings');
});
