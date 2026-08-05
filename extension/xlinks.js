/* PaperTrench — X/Twitter link classification for the warm-links path.
 *
 * Loaded in three worlds: the background service worker (importScripts), the
 * trading sites' MAIN world (window.open hook), and their ISOLATED world
 * (click capture). One classifier everywhere, or the three layers drift and a
 * link the hook swallows is one the background refuses — which strands the
 * click. Dependency-free on purpose.
 *
 * Every URL is re-classified at each trust boundary (page → content script →
 * background); MAIN-world input is attacker-controlled and must never be
 * trusted just because it was classified once before.
 */
(() => {
  'use strict';
  const root = typeof self !== 'undefined' ? self : window;
  if (root.PTXLinks) return;

  const X_HOSTS = new Set([
    'x.com', 'www.x.com', 'mobile.x.com',
    'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
  ]);

  // First path segments that are X app surfaces, not user handles. A link to
  // /search or /compose is navigation chrome, not "check this account out" —
  // warm-routing those would hijack X's own UI.
  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'compose', 'settings',
    'search', 'hashtag', 'i', 'intent', 'share', 'login', 'logout', 'signup',
    'account', 'about', 'tos', 'privacy', 'jobs', 'download', 'help',
    'follower_requests', 'communities', 'places', 'topics',
  ]);

  // /handle/status/123... and the handleless embed form /i/web/status/123...
  const POST_RE = /^\/(?:i\/web|([A-Za-z0-9_]{1,15}))\/status(?:es)?\/(\d+)/;
  const PROFILE_RE = /^\/([A-Za-z0-9_]{1,15})\/?$/;
  // Memecoins live in X communities; GMGN's trench rows link them directly.
  const COMMUNITY_RE = /^\/i\/communities\/\d+/;

  function isXHost(hostname) {
    return X_HOSTS.has(String(hostname || '').toLowerCase());
  }

  /**
   * Classify an href as a warm-routable X target.
   *
   * Returns { kind: 'post'|'profile'|'community'|'search', handle, postId,
   * url }, or null for everything else (system routes, other hosts,
   * non-https). Posts and profiles carry the fields their arrival check
   * needs; communities and searches verify by title movement alone, so they
   * carry only the kind.
   *
   * The returned url is canonicalized onto https://x.com: the viewer tab lives
   * on x.com, and a same-document SPA navigation can only target its own
   * origin — a twitter.com URL handed to pushState would throw.
   */
  function classify(href, baseHref) {
    let url;
    try {
      url = baseHref ? new URL(href, baseHref) : new URL(href);
    } catch (_) {
      return null;
    }
    if (url.protocol !== 'https:' || !isXHost(url.hostname)) return null;

    // The two forms trading platforms emit that are NOT handle-shaped:
    // a token's X community (GMGN links these on every trench row) and a
    // search for its CA/ticker (Axiom's X affordance). Both live under
    // otherwise-reserved first segments, so they are matched before the
    // reserved-set check can refuse them.
    if (COMMUNITY_RE.test(url.pathname)) {
      return { kind: 'community', handle: null, postId: null,
        url: 'https://x.com' + url.pathname + url.search };
    }
    if ((url.pathname === '/search' || url.pathname === '/search/') && url.searchParams.get('q')) {
      return { kind: 'search', handle: null, postId: null,
        url: 'https://x.com/search' + url.search };
    }

    const post = POST_RE.exec(url.pathname);
    if (post) {
      const handle = post[1] ? post[1].toLowerCase() : null;
      if (handle && RESERVED.has(handle)) return null;
      return {
        kind: 'post',
        handle,
        postId: post[2],
        url: 'https://x.com' + url.pathname + url.search,
      };
    }

    const profile = PROFILE_RE.exec(url.pathname);
    if (profile && !RESERVED.has(profile[1].toLowerCase())) {
      return {
        kind: 'profile',
        handle: profile[1].toLowerCase(),
        postId: null,
        url: 'https://x.com/' + profile[1],
      };
    }

    return null;
  }

  root.PTXLinks = { isXHost, classify };
})();
