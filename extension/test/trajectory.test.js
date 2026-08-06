/* Trajectory predictor — pure-geometry contracts (Turbo II).
 *
 * The predictor may only guess when the motion is fast AND straight; every
 * refusing gate is what keeps trajectory prefetch honest — a hint fired at a
 * wandering cursor is traffic with no intent behind it. These tests drive
 * the module through Node's require path (the same file installs
 * window.PTTrajectory in the browser).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createTracker } = require(path.join(__dirname, '..', 'trajectory.js'));

function feed(tracker, points) {
  for (const [x, y, t] of points) tracker.sample(x, y, t);
}

test('straight fast motion predicts ahead along the line', () => {
  const tracker = createTracker();
  // 1 px/ms rightward, sampled every 20ms.
  feed(tracker, [[100, 50, 0], [120, 50, 20], [140, 50, 40], [160, 50, 60], [180, 50, 80]]);
  const p = tracker.predict(200);
  assert.ok(p, 'clean motion must produce a prediction');
  assert.ok(Math.abs(p.x - 380) < 1, `projects ~200px ahead of the last sample (got ${p.x})`);
  assert.ok(Math.abs(p.y - 50) < 1, 'no lateral drift on a horizontal line');
  assert.ok(p.speed > 0.9 && p.speed < 1.1, 'speed reports in px/ms');
});

test('a drifting cursor is not going anywhere', () => {
  const tracker = createTracker();
  // 0.05 px/ms — well under the minimum speed gate.
  feed(tracker, [[100, 50, 0], [101, 50, 20], [102, 50, 40], [103, 50, 60]]);
  assert.equal(tracker.predict(200), null);
});

test('a flick is a gesture, not an aim', () => {
  const tracker = createTracker();
  // 10 px/ms — over the maximum speed gate.
  feed(tracker, [[0, 0, 0], [200, 0, 20], [400, 0, 40], [600, 0, 60]]);
  assert.equal(tracker.predict(200), null);
});

test('a direction change refuses to guess', () => {
  const tracker = createTracker();
  // Rightward then sharply downward: the window halves disagree.
  feed(tracker, [[100, 100, 0], [140, 100, 20], [180, 100, 40], [180, 140, 60], [180, 180, 80]]);
  assert.equal(tracker.predict(200), null, 'a turning cursor has no known target');
});

test('too few samples refuse, and stale samples age out', () => {
  const tracker = createTracker();
  feed(tracker, [[0, 0, 0], [20, 0, 20]]);
  assert.equal(tracker.predict(200), null, 'two points are a line, not intent');
  // A long pause empties the history window: the old motion may not predict.
  tracker.sample(40, 0, 1000);
  tracker.sample(41, 0, 1020);
  assert.equal(tracker.predict(200), null, 'post-pause the window restarts from scratch');
});

test('reset forgets everything', () => {
  const tracker = createTracker();
  feed(tracker, [[100, 50, 0], [120, 50, 20], [140, 50, 40], [160, 50, 60]]);
  assert.ok(tracker.predict(200));
  tracker.reset();
  assert.equal(tracker.predict(200), null);
});

test('the manifest loads the predictor before the interceptor that uses it', () => {
  const fs = require('node:fs');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const isolatedEntry = manifest.content_scripts.find((cs) => cs.js.includes('content.js'));
  assert.ok(isolatedEntry.js.includes('trajectory.js'),
    'the predictor must load on the trading sites');
  assert.ok(isolatedEntry.js.indexOf('trajectory.js') < isolatedEntry.js.indexOf('warm-links.js'),
    'warm-links.js reads window.PTTrajectory at event time; the order still must hold');
});
