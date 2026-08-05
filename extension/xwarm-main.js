/* PaperTrench — warm X links, x.com side (MAIN world SPA driver).
 *
 * Executes the in-page navigation: pushState onto X's own history, dispatch a
 * popstate so X's router picks it up, then watch the DOM until the target
 * content actually arrives. The whole point of the warm path is that this
 * skips DNS/TLS/HTML/hydration and costs only X's client-side data fetch.
 *
 * Verification is honest about what it can know:
 *  - A post has arrived when the rendered article links to its own
 *    /status/<id> (the tweet's timestamp anchor) — an exact, per-post signal.
 *  - A profile has arrived when the title carries its @handle.
 *  - X's error surface ([data-testid="error-detail"]) is an explicit failure.
 *  - Fallback: the title moved to a genuinely different page. Titles are
 *    compared with the "(3) " unread-count prefix stripped — a notification
 *    count ticking over changes the title WITHOUT navigation, and counting
 *    that as success would strand the user on their home feed.
 *
 * On failure (or silence) the background repairs with a full load of the same
 * URL, so the worst case is exactly what a cold open would have been.
 */
(() => {
  'use strict';
  if (window.__ptXWarmMain) return;
  window.__ptXWarmMain = true;

  const REQ_TAG = 'papertrench-xwarm-request';
  const RES_TAG = 'papertrench-xwarm-result';
  const VERIFY_MS = 5000;
  const CHECK_THROTTLE_MS = 100;

  // A newer request supersedes the watcher of the one before it: two rapid
  // clicks must end on the SECOND target, never repaired back to the first.
  let watchToken = 0;

  function respond(requestId, ok, reason) {
    window.postMessage({ source: RES_TAG, requestId, ok, reason: reason || null },
      window.location.origin);
  }

  function normalizeTitle(title) {
    return String(title || '').replace(/^\(\d+\)\s*/, '');
  }

  function arrived(target) {
    if (document.querySelector('main [data-testid="error-detail"]')) return 'error';
    if (target.kind === 'post' && target.postId
        && document.querySelector('main article a[href*="/status/' + target.postId + '"]')) {
      return 'ok';
    }
    if (target.kind === 'profile' && target.handle
        && normalizeTitle(document.title).toLowerCase().includes('@' + target.handle)) {
      return 'ok';
    }
    return null;
  }

  function watch(requestId, target, beforeTitle) {
    const token = ++watchToken;
    const startedAt = performance.now();
    let lastCheckAt = 0;
    let observer = null;
    let interval = null;

    const stop = () => {
      if (observer) observer.disconnect();
      if (interval) clearInterval(interval);
    };
    const finish = (ok, reason) => {
      stop();
      respond(requestId, ok, reason);
    };
    const check = () => {
      if (token !== watchToken) { stop(); return; }
      const now = performance.now();
      if (now - lastCheckAt < CHECK_THROTTLE_MS) return; // X mutates in storms
      lastCheckAt = now;
      const got = arrived(target);
      if (got === 'ok') { finish(true, null); return; }
      if (got === 'error') { finish(false, 'x_error_page'); return; }
      if (normalizeTitle(document.title) !== normalizeTitle(beforeTitle)) {
        finish(true, 'title_changed');
        return;
      }
      if (now - startedAt > VERIFY_MS) finish(false, 'verify_timeout');
    };

    observer = new MutationObserver(check);
    observer.observe(document.body || document.documentElement,
      { childList: true, subtree: true });
    interval = setInterval(check, 250);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== REQ_TAG) return;
    if (typeof data.requestId !== 'string' || typeof data.url !== 'string') return;

    let target;
    try {
      const url = new URL(data.url);
      if (url.origin !== window.location.origin) {
        // Viewer drifted onto a different origin (e.g. a twitter.com redirect
        // caught mid-flight) — pushState cannot cross origins.
        respond(data.requestId, false, 'cross_origin');
        return;
      }
      target = {
        kind: data.kind === 'profile' ? 'profile' : 'post',
        handle: typeof data.handle === 'string' ? data.handle.toLowerCase() : null,
        postId: typeof data.postId === 'string' ? data.postId : null,
        path: url.pathname + url.search,
      };
    } catch (_) {
      respond(data.requestId, false, 'bad_url');
      return;
    }

    if (window.location.pathname + window.location.search === target.path) {
      respond(data.requestId, true, 'already_here');
      return;
    }

    const beforeTitle = document.title;
    try {
      window.history.pushState({}, '', target.path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    } catch (_) {
      respond(data.requestId, false, 'pushstate_failed');
      return;
    }
    watch(data.requestId, target, beforeTitle);
  });
})();
