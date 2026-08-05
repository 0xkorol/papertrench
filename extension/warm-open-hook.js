/* PaperTrench — MAIN-world window.open hook for warm X links.
 *
 * Trading sites open X posts two ways: a plain <a target="_blank"> (handled by
 * warm-links.js's capture-phase click listener — window.open never fires for
 * those), and a script calling window.open() from its own click handler. This
 * hook covers the second path.
 *
 * Deliberately unlike the design it replaces: interception does NOT check
 * navigator.userActivation. A real click always carries active user
 * activation, so gating on "no activation" means the warm path never runs for
 * actual users — the one case it was built for. Modified clicks (ctrl / cmd /
 * shift / middle) never reach window.open in the first place: the browser
 * handles those natively on the anchor, and the click listener passes them
 * through, so "open in real background tab" keeps working.
 *
 * Fail-safe: `enabled` starts false and is only flipped by the ISOLATED-world
 * script relaying the user's opt-in setting. If the extension is dead,
 * disabled, or slow to load, every window.open behaves natively.
 */
(() => {
  'use strict';
  if (window.__ptWarmOpenHooked) return;
  window.__ptWarmOpenHooked = true;

  const OUT_TAG = 'papertrench-warmhook';
  const STATE_TAG = 'papertrench-warmstate';

  let enabled = false;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== STATE_TAG || typeof data.enabled !== 'boolean') return;
    enabled = data.enabled;
  });

  const nativeOpen = window.open.bind(window);

  // Callers expect a Window back and may poke at it; a inert stand-in keeps
  // their code from throwing. `closed` flips on close() so polling loops that
  // wait for the popup to go away still terminate.
  function fakeWindow() {
    const w = {
      closed: false,
      focus() {}, blur() {}, close() { w.closed = true; },
      postMessage() {},
      location: { href: '' },
    };
    return w;
  }

  window.open = function (url, target, features) {
    try {
      const X = window.PTXLinks;
      if (enabled && X && url != null) {
        const t = X.classify(String(url), window.location.href);
        if (t) {
          window.postMessage({ source: OUT_TAG, type: 'warm-open', url: t.url }, window.location.origin);
          return fakeWindow();
        }
      }
    } catch (_) {
      // Never let the hook break the site's own open — fall through to native.
    }
    return nativeOpen(url, target, features);
  };
})();
