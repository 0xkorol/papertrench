/* Replay playback: video-driven, flicker-free.
 *
 * Reported defect: stepping the session tape made the screen flash and the
 * video lag/jump. Cause — every cursor move rebuilt the whole section with
 * innerHTML, which destroyed and recreated the <video> element, restarting
 * playback and repainting the page.
 *
 * The fix inverts the relationship: the video is the clock, a rAF loop maps its
 * currentTime onto the timeline, and only the parts that changed are updated.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RC = require('../recordings.js');


/** Slice one top-level function out of the source, independent of ordering. */
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  // Find the next top-level declaration after it.
  const rest = src.slice(start + 1);
  const nextFn = rest.search(/\nfunction \w+\(/);
  return nextFn < 0 ? src.slice(start) : src.slice(start, start + 1 + nextFn);
}

const RECORDING = { id: 'r1', startedAt: 1_000_000, endedAt: 1_300_000 };

/* ---------------- mapping playback time onto the timeline ---------------- */

test('a playback position maps back to the wall-clock moment', () => {
  // Exact inverse of offsetForMoment — the two must agree or the tape drifts.
  assert.equal(RC.momentForOffset(RECORDING, 0), 1_000_000);
  assert.equal(RC.momentForOffset(RECORDING, 60), 1_060_000);
  for (const seconds of [0, 12.5, 90, 300]) {
    const moment = RC.momentForOffset(RECORDING, seconds);
    assert.equal(RC.offsetForMoment(RECORDING, moment), seconds,
      'converting back and forth must be lossless');
  }
});

test('an unusable playback position yields no moment rather than a guess', () => {
  assert.equal(RC.momentForOffset(null, 10), null);
  assert.equal(RC.momentForOffset(RECORDING, -1), null);
  assert.equal(RC.momentForOffset(RECORDING, NaN), null);
  assert.equal(RC.momentForOffset({ startedAt: 0 }, 10), null);
});

/* ---------------- which event is current during playback ---------------- */

const EVENTS = [
  { at: 1_000_000, kind: 'open' },
  { at: 1_060_000, kind: 'buy' },
  { at: 1_120_000, kind: 'interval' },
  { at: 1_300_000, kind: 'close' },
];

test('the active event is the last one at or before the playhead', () => {
  assert.equal(RC.activeEventIndex(EVENTS, 1_000_000), 0, 'exactly on an event selects it');
  assert.equal(RC.activeEventIndex(EVENTS, 1_059_999), 0, 'just before the next one holds');
  assert.equal(RC.activeEventIndex(EVENTS, 1_060_000), 1);
  assert.equal(RC.activeEventIndex(EVENTS, 1_200_000), 2, 'between events holds the earlier one');
  assert.equal(RC.activeEventIndex(EVENTS, 9_999_999), 3, 'past the end holds the last');
});

test('before the first event there is no active event', () => {
  assert.equal(RC.activeEventIndex(EVENTS, 999_999), -1,
    'playback before anything happened must not pretend an event is current');
});

test('active-event lookup is safe on empty or malformed input', () => {
  assert.equal(RC.activeEventIndex([], 1_000_000), -1);
  assert.equal(RC.activeEventIndex(null, 1_000_000), -1);
  assert.equal(RC.activeEventIndex(EVENTS, NaN), -1);
});

test('playing straight through visits every event exactly once, in order', () => {
  // Simulate natural playback: sample the video clock forward and record which
  // event the tape would highlight. This is the behaviour that was jumping.
  const visited = [];
  for (let seconds = 0; seconds <= 300; seconds += 0.5) {
    const at = RC.momentForOffset(RECORDING, seconds);
    const index = RC.activeEventIndex(EVENTS, at);
    if (index >= 0 && visited[visited.length - 1] !== index) visited.push(index);
  }
  assert.deepEqual(visited, [0, 1, 2, 3],
    'the highlight must advance monotonically, never bounce or skip');
});

/* ---------------- the shipped dashboard does not rebuild the video ---------------- */

const dash = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

test('the replay shell is built once and reused across cursor moves', () => {
  assert.match(dash, /function mountReplayShell/,
    'a persistent shell must exist');
  assert.match(dash, /function updateReplayView/,
    'cursor moves must update, not rebuild');

  const render = fnBody(dash, 'renderReplay');

  // D-12: shell identity is a composite key. It must cover every fact whose
  // change requires a rebuild (a round closing mid-watch must redraw the hero,
  // a new session must appear in the list) — and nothing that changes on a
  // cursor move, or the video would restart on every step.
  const keyLine = render.match(/const shellKey = (.+)/)?.[1] ?? '';
  assert.ok(keyLine, 'renderReplay must derive a composite shell key');
  for (const part of ['replay.sessionId', 'replay.status', 'replay.roundId', 'replays.length']) {
    assert.ok(keyLine.includes(part),
      `the shell key must cover ${part}, or its change would leave a stale shell`);
  }
  assert.doesNotMatch(keyLine, /cursor/i,
    'the cursor must never be part of the shell identity');

  assert.match(render, /replayShell\.key !== shellKey/,
    'the shell must be remounted only when its key changes');
  assert.match(render, /replayShell\.key = shellKey/,
    'the new key must be recorded after a remount, or every render would rebuild');
  assert.doesNotMatch(render, /replayShell\.sessionId/,
    'the session-only identity check is superseded by the composite key');
});

test('the video element is only replaced when its source changes', () => {
  const fn = fnBody(dash, 'syncReplayMedia');
  assert.ok(fn.length > 0, 'the media sync function must exist');
  assert.match(fn, /mediaKey !== key/,
    'a keyed guard is what stops the <video> being torn down every tick');
});

test('the timeline follows the video clock rather than seeking it every frame', () => {
  assert.match(dash, /requestAnimationFrame/,
    'playback must be followed frame-aligned, not on an arbitrary interval');
  const sync = fnBody(dash, 'syncCursorToVideo');
  assert.match(sync, /activeEventIndex/,
    'the cursor must be derived FROM the video position');
  assert.match(sync, /if \(!force && next === replayCursor\) return;/,
    'the DOM must only be touched when the active event actually changes');
});

test('tape rows and ticks are created once, then only the highlight moves', () => {
  const tape = fnBody(dash, 'syncTape');
  assert.match(tape, /tapeRows\.length !== events\.length/,
    'rows must be rebuilt only when the event list itself changes');
  assert.match(tape, /classList\.toggle\('active', active\)/,
    'stepping through the tape must be a class change, not a rebuild');

  const ticks = fnBody(dash, 'syncTicks');
  assert.match(ticks, /tickEls\.length !== events\.length/);
});

test('the dashboard never re-renders unless the data actually changed', () => {
  // The blind periodic re-render was the root cause of the "constantly
  // refreshing" behaviour: renderSection() clears the section first, so a
  // timer-driven rebuild wiped scroll, focus, and the replay's video element.
  assert.match(dash, /function refreshIfChanged/,
    'refreshes must be gated on real change');
  const refresh = fnBody(dash, 'refreshIfChanged');
  assert.match(refresh, /if \(next === lastFingerprint\) return;/,
    'an unchanged fingerprint must produce no DOM work at all');
  assert.match(refresh, /if \(isUserBusy\(\)\) return;/,
    'a refresh must never interrupt an interaction');

  assert.doesNotMatch(dash, /setInterval\(async \(\) => \{\s*\n\s*await loadAll\(\);\s*\n\s*renderSidebar\(\);\s*\n\s*renderSection/,
    'the unconditional periodic rebuild must be gone');
});

test('an interaction suspends background refreshes entirely', () => {
  const busy = fnBody(dash, 'isUserBusy');
  assert.match(busy, /INPUT\|TEXTAREA\|SELECT/,
    'typing must never be destroyed by a background rebuild');
  assert.match(busy, /replayPlaying\(\)/,
    'a playing recording must not be interrupted');
  assert.match(busy, /currentSection === 'settings'/,
    'unsaved settings edits must survive');
});

test('storage changes drive updates so fills appear without polling', () => {
  assert.match(dash, /function watchDashboardStorage/);
  const watch = fnBody(dash, 'watchDashboardStorage');
  assert.match(watch, /onChanged\.addListener/,
    'the extension already announces its writes; use them');
  assert.match(watch, /refreshIfChanged/,
    'storage events must go through the same change gate');
});

test('recordings are cached rather than re-read from IndexedDB each refresh', () => {
  const load = fnBody(dash, 'loadRecordings');
  assert.match(load, /cached && cached\.blob/,
    're-reading every video blob on each refresh is needless work');
  assert.match(load, /revokeObjectURL/,
    'URLs for removed recordings must be released');
});

test('leaving the replay section releases its timers and shell', () => {
  assert.match(dash, /releaseReplayShell/,
    'navigating away must not leave a rAF loop running');
  const release = fnBody(dash, 'releaseReplayShell');
  assert.match(release, /stopVideoSync\(\)/);
});

/* ---------------- sections never flash empty ---------------- */

test('a section is swapped atomically, never blanked before rendering', () => {
  const fn = fnBody(dash, 'renderSection');

  // The reported flash: `el.innerHTML = ''` lets the browser paint an empty
  // section before the rebuild lands.
  assert.doesNotMatch(fn, /el\.innerHTML\s*=\s*['"]{2}/,
    'blanking the section before rendering is what caused the visible flash');
  assert.match(fn, /replaceChildren/,
    'content must be swapped in a single mutation');
  assert.match(fn, /if \(el\.innerHTML === staged\.innerHTML\) return;/,
    'identical output must not repaint at all');
  assert.match(fn, /document\.createElement\('div'\)/,
    'sections must be built detached so nothing half-built is ever painted');
});

test('the sidebar does not rewrite identical markup', () => {
  const fn = fnBody(dash, 'renderSidebar');
  assert.match(fn, /if \(sb\.innerHTML !== markup\)/,
    'rewriting identical markup still forces a repaint');
});

test('handlers are bound after the markup is live, not during staging', () => {
  assert.match(dash, /function rebindSection/,
    'staged nodes are unreachable from document, so binding must be deferred');
  const fn = fnBody(dash, 'rebindSection');
  assert.match(fn, /rounds/);
  assert.match(fn, /settings/);
});
