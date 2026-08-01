/* Screen recordings in the replay view.
 *
 * Reported defect: a round WAS screen-recorded, but the dashboard replay still
 * showed only still frames. Cause — the recorder downloaded the video to disk
 * and stored just the filename string, so the dashboard had no video to play.
 *
 * These tests pin the pieces that make playback correct: the video is persisted,
 * a replay moment maps onto the right position inside it, and the video takes
 * precedence over screenshots when it exists.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RC = require('../recordings.js');

/* ---------------- mapping a moment onto the video ---------------- */

const RECORDING = { id: 'r1', startedAt: 1_000_000, endedAt: 1_300_000 }; // 5 min

test('a replay moment maps onto the matching position inside the video', () => {
  // Derived from the recording bounds, not pasted.
  assert.equal(RC.offsetForMoment(RECORDING, 1_000_000), 0, 'the start maps to 0s');
  assert.equal(RC.offsetForMoment(RECORDING, 1_060_000), 60, 'one minute in maps to 60s');
  assert.equal(RC.offsetForMoment(RECORDING, 1_300_000), 300, 'the end maps to the full length');
});

test('a moment outside the recorded window yields no seek rather than a wrong frame', () => {
  assert.equal(RC.offsetForMoment(RECORDING, 999_000), null,
    'before recording began there is nothing truthful to show');
  assert.equal(RC.offsetForMoment(RECORDING, 1_400_000), null,
    'after recording ended the video cannot depict the moment');
});

test('offsetForMoment refuses to guess when the bounds are unusable', () => {
  assert.equal(RC.offsetForMoment(null, 1_000_000), null);
  assert.equal(RC.offsetForMoment({ startedAt: 0 }, 1_000_000), null);
  assert.equal(RC.offsetForMoment(RECORDING, 0), null);
  assert.equal(RC.offsetForMoment(RECORDING, NaN), null);
});

test('a recording with no end bound still seeks forward', () => {
  // A recording interrupted by a crash may never get an end timestamp.
  const open = { id: 'r2', startedAt: 1_000_000, endedAt: 0 };
  assert.equal(RC.offsetForMoment(open, 1_090_000), 90);
});

/* ---------------- metadata never carries the blob ---------------- */

test('listed metadata excludes the video payload', () => {
  const entry = {
    id: 'r1', sessionId: 'pts-1', symbol: 'BONK', file: 'x.webm',
    startedAt: 1, endedAt: 2, mimeType: 'video/webm', size: 1234,
    savedAt: 9, blob: { size: 1234, type: 'video/webm' },
  };
  const meta = RC.meta(entry);
  assert.equal(meta.size, 1234);
  assert.equal(meta.file, 'x.webm');
  assert.equal(meta.blob, undefined,
    'metadata must not drag megabytes of video around');
});

/* ---------------- the recorder actually persists the video ---------------- */

test('the offscreen recorder stores the blob, not just a filename', () => {
  const src = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');

  assert.match(src, /PTRecordings/,
    'the recorder must hand the video to the store');
  assert.match(src, /startedAt/,
    'a start timestamp is required to seek into the recording later');
  assert.match(src, /blob,/,
    'the actual Blob must be persisted, not only its name');
});

test('the offscreen document loads the recording store before the recorder', () => {
  const html = fs.readFileSync(path.join(ROOT, 'offscreen.html'), 'utf8');
  const storeAt = html.indexOf('recordings.js');
  const recorderAt = html.indexOf('offscreen.js');
  assert.ok(storeAt >= 0, 'the offscreen page must load the recording store');
  assert.ok(storeAt < recorderAt, 'the store must be available when the recorder runs');
});

test('the background records playable recording metadata on the round', () => {
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.match(src, /round\.recording = /,
    'the round must carry the metadata the dashboard looks up');
  assert.match(src, /result\.stored/,
    'metadata is only attached when the video was genuinely persisted');
});

/* ---------------- the dashboard prefers video over stills ---------------- */

test('the replay view shows the recording instead of screenshots when one exists', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

  const fn = src.slice(src.indexOf('function renderMomentMedia'), src.indexOf('function replayRecording'));
  assert.ok(fn.length > 0, 'the media renderer must exist');

  // The video branch must be reached BECAUSE a recording exists — not because
  // of source ordering. Guarding on a constant would silently disable it.
  const guard = /if \(recording && !\(preferFrameOverVideo && relatedFrame\)\) \{/.exec(fn);
  assert.ok(guard,
    'the video branch must be entered whenever a recording exists and the ' +
    'user has not explicitly asked for the still frame');

  const videoAt = fn.indexOf('replay-video');
  const frameAt = fn.lastIndexOf('replay-frame');
  assert.ok(videoAt >= 0 && frameAt > videoAt,
    'a screen recording must take precedence over still frames');
  assert.match(fn, /offsetForMoment/,
    'the video must be seeked to the replayed moment, not started from zero');
});

test('the dashboard seeks the video to the selected moment', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  assert.match(src, /currentTime = /,
    'scrubbing the timeline must move the video with it');
  assert.match(src, /loadedmetadata/,
    'seeking must wait for metadata rather than silently failing');
});

test('object URLs are created once per recording rather than per render', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  const fn = src.slice(src.indexOf('function recordingUrl'), src.indexOf('function renderReplayTape'));
  assert.match(fn, /recordingUrls\[recording\.id\]/,
    'the replay re-renders on every tick; minting a new URL each time would leak');
});
