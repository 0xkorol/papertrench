/* D-56 — "I press Save and it doesn't save."
 *
 * Reported from live use. The dashboard's save path is heavily defended
 * (fresh re-read before the merge, refusal to write over an unreadable
 * storage, a visible failure status), and it works: every control on the
 * Settings form is gathered and written. The loss happened AFTER the write,
 * on the next READ.
 *
 * DEFAULT_SETTINGS carried `settingsRevision: 4` as a literal while
 * SETTINGS_REVISION had moved on to 7. Nothing bumped the literal when the
 * constant was bumped, because they sat 60 lines apart with no coupling. So
 * a FRESH install was born three revisions stale:
 *
 *   1. saveFromForm() reads storage. Nothing is there yet, so
 *      mergeSettings(undefined) returns the defaults — stamped revision 4.
 *   2. The form values are laid over that and written. Storage now holds the
 *      user's choices AND revision 4. The status line says "Saved." — and it
 *      is telling the truth, the write really happened.
 *   3. The next read of pt_settings — the content script booting on a
 *      trading tab, a dashboard reload, the popup — calls mergeSettings on
 *      revision-4 data, so migrations 5, 6 and 7 run. Those migrations exist
 *      to hand NEW DEFAULTS to OLD INSTALLS, so they force-overwrite the
 *      very keys the user had just chosen.
 *
 * Net effect: uncheck "Buy section in the trade tab" or "Quick-buy preset
 * buttons", press Save, see "Saved.", and find them checked again a moment
 * later. Migrations written to repair data from old builds were running
 * against settings typed thirty seconds ago.
 *
 * The fix makes a fresh install CURRENT BY CONSTRUCTION: SETTINGS_REVISION
 * is declared above DEFAULT_SETTINGS and the defaults carry the constant
 * itself, so the two cannot drift apart again. A brand-new install has no
 * legacy data, so no migration may ever apply to it.
 *
 * These tests are behaviour-level on purpose. Asserting
 * `DEFAULT_SETTINGS.settingsRevision === SETTINGS_REVISION` alone would pass
 * against a future build that reintroduced the drift somewhere else; the
 * save -> read round-trip is the property users actually care about.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

/** The exact two steps dashboard.js's saveFromForm() performs, in order. */
function saveThenRead(storedBefore, formValues) {
  // saveFromForm: re-read fresh, lay the form-controlled keys over it, write.
  const fresh = E.mergeSettings(storedBefore);
  const written = { ...fresh, ...formValues };
  // Any later consumer: content script boot, dashboard reload, popup.
  return { written, readBack: E.mergeSettings(written) };
}

test('D-56: a FRESH install keeps what the first save wrote', () => {
  // Nothing has ever been written to pt_settings: chrome.storage.local.get
  // resolves {}, so stored.pt_settings is undefined.
  const form = {
    panelBuyEnabled: false,      // migration 5 used to force this back to true
    panelPresetsEnabled: false,  // migration 5 used to force this back to true
    positionsBarHidden: true,    // migration 6 used to force this back to false
  };

  const { readBack } = saveThenRead(undefined, form);

  assert.equal(readBack.panelBuyEnabled, false,
    'the buy section the user switched off must stay off');
  assert.equal(readBack.panelPresetsEnabled, false,
    'the preset buttons the user switched off must stay off');
  assert.equal(readBack.positionsBarHidden, true,
    'the collapsed positions bar must stay collapsed');
});

test('D-56: a fresh install runs NO migrations at all', () => {
  // The general form of the bug: whatever a migration touches, a brand-new
  // install must be immune to it. Revision 2 and 4 migrations are covered
  // here too, so a future revision 8 cannot reintroduce the defect for a
  // key this file does not name yet.
  const fresh = E.mergeSettings(undefined);
  assert.equal(fresh.settingsRevision, E.SETTINGS_REVISION,
    'a fresh install is born at the current revision, so no migration applies');

  // And the value the defaults carry is the constant itself, not a literal
  // copy of it that a future bump could leave behind.
  assert.equal(E.DEFAULT_SETTINGS.settingsRevision, E.SETTINGS_REVISION,
    'DEFAULT_SETTINGS.settingsRevision must BE SETTINGS_REVISION, never a stale literal');
});

test('D-56: the fresh-install save is idempotent under a second read', () => {
  // Save -> read -> save -> read must converge, not oscillate. A migration
  // that re-ran on every read would show up here even if the first read
  // happened to look right.
  const form = { tradeSoundsEnabled: false, averagePriceLinesEnabled: false };
  const first = saveThenRead(undefined, form);
  const second = saveThenRead(first.written, form);

  assert.deepEqual(second.readBack, first.readBack,
    'a second save/read cycle changes nothing');
  assert.equal(second.readBack.tradeSoundsEnabled, false);
  assert.equal(second.readBack.averagePriceLinesEnabled, false);
});

test('D-56: a fresh install that sets an AI endpoint and key keeps both', () => {
  // Migration 7 clears credentials orphaned with no usable endpoint. On a
  // stale-born fresh install it ran against a key the user had just pasted.
  const { readBack } = saveThenRead(undefined, {
    aiEndpoint: 'https://ai.example.com/v1',
    aiApiKey: 'user-typed-key',
    aiModel: 'user-typed-model',
  });

  assert.equal(readBack.aiApiKey, 'user-typed-key');
  assert.equal(readBack.aiModel, 'user-typed-model');
  assert.equal(readBack.aiEndpoint, 'https://ai.example.com/v1');
});

/* The other half of the contract: this fix must NOT disarm the migrations
 * for the installs they were written for. An install that really did save
 * under an older revision still receives the new defaults exactly once. */

test('D-56 does not disarm migrations for genuinely old installs', () => {
  const rev4 = { settingsRevision: 4, balanceStartSol: 7 };
  const migrated = E.mergeSettings(rev4);
  assert.equal(migrated.panelBuyEnabled, true,
    'a real revision-4 install still receives the revision-5 defaults');
  assert.equal(migrated.panelPresetsEnabled, true);
  assert.equal(migrated.settingsRevision, E.SETTINGS_REVISION);
  assert.equal(migrated.balanceStartSol, 7, 'unrelated settings survive');

  // And the oldest case of all: settings saved before the key existed.
  const ancient = { balanceStartSol: 7, tradeSoundsEnabled: false };
  const fromAncient = E.mergeSettings(ancient);
  assert.equal(fromAncient.tradeSoundsEnabled, true,
    'a pre-revision install (no settingsRevision at all) still migrates');
  assert.equal(fromAncient.settingsRevision, E.SETTINGS_REVISION);
});
