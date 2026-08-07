/* The app-wide master switch (appEnabled, v2.4.0).
 *
 * "Disable overlay" was the closest thing to an off button, and it lied by
 * omission: the positions bar, chart drawings, title feed, and warm links all
 * kept their own lives. appEnabled is the switch users actually asked for —
 * off means PaperTrench exists NOWHERE until turned back on, while every
 * sub-setting (and the wallet) survives for the return trip.
 *
 * The warm-links side of the contract is tested behaviorally in
 * warmlinks.test.js ("the app-wide master switch outranks the warm-links
 * toggle"); this file pins the wiring: every surface that mounts UI must
 * check the master switch, and every settings UI must expose it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('content.js gates BOTH mount paths on the master switch', () => {
  const src = read('content.js');
  // Boot: a page loaded while PaperTrench is off must mount nothing.
  assert.match(src, /if \(settings\.appEnabled === false \|\| !settings\.overlayEnabled\) return;/,
    'init() must refuse to mount under master off');
  // Live: flipping the switch must tear down open tabs immediately.
  assert.match(src, /settings\.appEnabled !== false && settings\.overlayEnabled\) enableOverlay/,
    'the storage listener must run the full teardown when the master switch goes off');
});

test('warm-links run independently of the master switch (speed survives paper-off)', () => {
  // Maintainer (2026-08-05): the master switch is the PAPER switch. Turning
  // PaperTrench off must never take the speed plane down with it.
  const src = read('warm-links.js');
  assert.doesNotMatch(src, /appEnabled !== false && settings\.warm/,
    'speed toggles stand alone — no master-switch condition on interception');
  const background = read('background.js');
  assert.match(background, /function warmFeatureOn\(settings\)\s*\{\s*\n?\s*return settings\.warmXLinksEnabled === true;/,
    'the helper gates on the feature toggle alone');
  assert.match(background, /function warmDestFeatureOn\(settings\)\s*\{\s*\n?\s*return settings\.warmEverywhereEnabled === true;/,
    'warm destinations too');
  assert.match(background, /return settings\.xrayEnabled === true;/,
    'and X-Ray — the whole speed plane survives paper-off');
});

test('the background defaults the master switch to ON for existing installs', () => {
  const background = read('background.js');
  assert.match(background, /appEnabled: true,/,
    'a missing appEnabled key must mean ON, or updating the extension would turn everyone off');
});

test('the popup exposes the power button and flips ONLY the master flag', () => {
  const html = read('popup.html');
  assert.match(html, /id="power"/, 'the popup must have the power button');
  assert.match(html, /id="badge"/, 'the header badge must be addressable to show OFF');

  const src = read('popup.js');
  assert.match(src, /appEnabled: settings\.appEnabled === false/,
    'togglePower must flip appEnabled and nothing else');
  assert.match(src, /pt_settings_changed/,
    'the background must hear about the flip (it releases the warm viewer)');
  // The off-state copy must be honest about scope AND about what is kept.
  assert.match(src, /wallet, journal, and settings are untouched/,
    'an off switch that might eat the wallet is one nobody dares press');
});

test('the dashboard settings form exposes and persists the master switch', () => {
  const src = read('dashboard.js');
  assert.match(src, /id="set-app-enabled"/, 'the settings card must show the master switch');
  assert.match(src, /appEnabled: document\.getElementById\('set-app-enabled'\)\.checked/,
    'saving the form must persist it');
  assert.doesNotMatch(src, /Master switch for the PaperTrench panel/,
    'the old overlay copy claimed to be the master switch — that lie is what prompted this feature');
});

test('turning the master switch back on restores the previous configuration', () => {
  // The popup flip must be non-destructive: spread the stored settings, touch
  // one key. Simulate the exact object transform popup.js performs.
  const src = read('popup.js');
  const flip = /const next = \{ \.\.\.settings, appEnabled: settings\.appEnabled === false \};/;
  assert.match(src, flip, 'the flip must spread existing settings, preserving every sub-toggle');

  const stored = { overlayEnabled: false, warmXLinksEnabled: true, positionsBarEnabled: false, appEnabled: true };
  const off = { ...stored, appEnabled: stored.appEnabled === false };
  const backOn = { ...off, appEnabled: off.appEnabled === false };
  assert.deepEqual(backOn, stored,
    'off-then-on must round-trip to exactly the configuration the user had');
});

test('the perps surface honors the master switch (amogus: OFF popup, ticket still mounted)', () => {
  // The perps stack shipped after appEnabled existed and never learned it —
  // the popup read OFF while the PAPER PERPS ticket sat on Hyperliquid
  // anyway. Every surface that mounts UI must check the master switch.
  const src = read('perps-content.js');
  assert.match(src, /const off = Boolean\(s\) && s\.appEnabled === false;/,
    'the perps surface must read the master switch');
  assert.match(src, /if \(off\) \{\s*\n\s*leavePage\(\);/,
    'flipping OFF must unmount everything the perps surface owns');
  assert.match(src, /if \(masterOff\) return; \/\/ the master switch owns page presence/,
    'the location poll must refuse to (re)mount while the master is off');
  assert.match(src, /loadUiSettings\(pollLocation\);/,
    'the first mount must wait for the settings read — an OFF user must never see the ticket flash in');
  assert.match(src, /applyMasterSwitch\(s\);/,
    'live settings changes must reach the master-switch handler');
});
