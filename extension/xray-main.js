/* PaperTrench — X-Ray, x.com side (MAIN world observer + budgeted replay).
 *
 * Installs at document_start, before X's app boots, and wraps fetch/XHR the
 * same way price-bridge.js wraps the trading sites' feeds. Two jobs:
 *
 *  1. OBSERVE. When the page's own GraphQL traffic carries an allowlisted
 *     operation (profile, tweets, follower lists — see PTXRay.OPS), the
 *     response is digested IN THIS WORLD down to derived facts — user field
 *     snapshots, tweet ids/dates, the contract addresses a tweet carries —
 *     and only that digest crosses to the extension. Raw tweet text never
 *     leaves the page context. Nothing outside the allowlist is ever parsed:
 *     home timeline, DMs, and notifications are none of X-Ray's business.
 *
 *  2. REPLAY (deep scan). On command from the panel, re-issue an
 *     already-observed request shape with different variables (next tweet
 *     page, the followers-you-know edge) using the page's own session — the
 *     same request the page would make if the user scrolled. Hard-budgeted:
 *     minimum spacing, a per-minute cap, and any non-2xx answer retires the
 *     shape for the session. If X's build rotates its query IDs, the deep
 *     scan silently degrades to nothing — the passive layer keeps working.
 *
 * Trust: this world is page-adjacent, so everything it emits is treated as
 * untrusted input by the relay and re-validated by the background. Scan
 * commands could in principle be forged by the page itself; the only thing a
 * forgery can trigger is a throttled request from x.com to x.com with the
 * page's own cookies — nothing crosses an origin, and the budget bounds it.
 *
 * Digests are queued (bounded) until the panel reports whether the user's
 * toggle is on: the first profile response usually lands before an
 * ISOLATED-world script at document_idle can possibly have answered, and
 * dropping it would make the first visit blind. Off means the queue is
 * discarded and nothing further is parsed.
 */
(() => {
  'use strict';
  if (window.__ptXRayMain) return;
  window.__ptXRayMain = true;

  const XR = window.PTXRay;
  if (!XR) return;

  const DIGEST_TAG = 'papertrench-xray-digest';
  const SCAN_TAG = 'papertrench-xray-scan';
  const STATE_TAG = 'papertrench-xray-state';

  const QUEUE_MAX = 40;
  const REPLAY_MIN_GAP_MS = 900;
  const REPLAY_PER_MINUTE = 8;

  let enabled = null; // null = panel has not reported yet; queue meanwhile
  const queue = [];

  // op -> { url, headers } — the page's own request shapes, session memory
  // only. Auth header here is X's public web-app bearer; the csrf token is
  // read fresh from the cookie at replay time and never stored.
  const shapes = new Map();
  const shapeAnnounced = new Set();

  const realFetch = window.fetch;

  function post(digest) {
    if (enabled === false) return;
    if (enabled === null) {
      if (queue.length < QUEUE_MAX) queue.push(digest);
      return;
    }
    try {
      window.postMessage({ source: DIGEST_TAG, digest }, window.location.origin);
    } catch (_) {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;
    if (data.source === STATE_TAG) {
      const on = data.enabled === true;
      if (on && enabled !== true) {
        enabled = true;
        while (queue.length) {
          const d = queue.shift();
          try { window.postMessage({ source: DIGEST_TAG, digest: d }, window.location.origin); } catch (_) {}
        }
      } else if (!on) {
        enabled = false;
        queue.length = 0;
      }
      return;
    }
    if (data.source === SCAN_TAG) {
      if (enabled !== true) return;
      runScan(data).catch(() => {});
    }
  });

  /* -------------------- header capture -------------------- */

  const KEEP_HEADERS = [
    'authorization', 'x-twitter-auth-type', 'x-twitter-active-user',
    'x-twitter-client-language',
  ];

  function pickHeaders(headersLike) {
    const out = {};
    if (!headersLike) return out;
    try {
      if (typeof headersLike.get === 'function') {
        for (const name of KEEP_HEADERS) {
          const v = headersLike.get(name);
          if (typeof v === 'string') out[name] = v;
        }
        return out;
      }
      if (Array.isArray(headersLike)) {
        for (const pair of headersLike) {
          if (!pair) continue;
          const k = String(pair[0] || '').toLowerCase();
          if (KEEP_HEADERS.includes(k)) out[k] = String(pair[1] || '');
        }
        return out;
      }
      for (const k of Object.keys(headersLike)) {
        const lk = k.toLowerCase();
        if (KEEP_HEADERS.includes(lk)) out[lk] = String(headersLike[k]);
      }
    } catch (_) {}
    return out;
  }

  function captureShape(op, url, headersLike) {
    if (!XR.REPLAY_OPS.has(op)) return;
    const headers = pickHeaders(headersLike);
    if (!headers.authorization) return; // a shape we cannot replay is no shape
    shapes.set(op, { url: String(url), headers });
  }

  /* -------------------- digestion -------------------- */

  function csrfToken() {
    const m = /(?:^|;\s*)ct0=([A-Za-z0-9]+)/.exec(String(document.cookie || ''));
    return m ? m[1] : null;
  }

  function digestText(found, url, text, scanMeta) {
    if (typeof text !== 'string' || !text || text.length > XR.LIMITS.maxPayloadChars) return;
    let payload;
    try { payload = JSON.parse(text); } catch (_) { return; }

    const vars = XR.requestVariables(url) || {};
    const { users, tweets, cursor } = XR.extract(payload);
    if (!users.length && !tweets.length && !scanMeta) return;

    let subjectRestId = null;
    if (found.op === 'UserByScreenName' && typeof vars.screen_name === 'string') {
      const want = vars.screen_name.toLowerCase();
      const hit = users.find((u) => u.handle.toLowerCase() === want);
      if (hit) subjectRestId = hit.restId;
    } else if (found.op === 'TweetDetail' && typeof vars.focalTweetId === 'string') {
      const focal = tweets.find((t) => t.id === vars.focalTweetId);
      if (focal) subjectRestId = focal.authorId;
    }

    const digest = {
      op: found.op,
      users,
      tweets,
      cursor,
      subjectRestId,
      followersTarget: XR.FOLLOWER_OPS.has(found.op) && typeof vars.userId === 'string'
        ? vars.userId : null,
      scan: scanMeta || null,
      opShape: null,
    };

    // Announce each replayable shape once per page session so the ledger can
    // remember it — that is what lets a later profile deep-scan an edge the
    // page never fetched THAT visit (e.g. followers-you-know, learned the one
    // time the user opened a followers tab weeks ago).
    const shape = shapes.get(found.op);
    if (shape && !shapeAnnounced.has(found.op)) {
      shapeAnnounced.add(found.op);
      digest.opShape = { op: found.op, url: shape.url, headers: shape.headers };
    }

    post(digest);
  }

  function observeResponse(found, url, responsePromise) {
    responsePromise.then((res) => {
      if (!res || !res.ok || typeof res.clone !== 'function') return;
      let clone;
      try { clone = res.clone(); } catch (_) { return; }
      clone.text().then((text) => digestText(found, url, text)).catch(() => {});
    }).catch(() => {});
  }

  /* -------------------- fetch hook -------------------- */

  window.fetch = function (input, init) {
    const result = realFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input
        : (input && typeof input.url === 'string' ? input.url : '');
      const found = XR.interestingOp(url);
      if (found) {
        captureShape(found.op, url,
          (init && init.headers) || (input && typeof input.url === 'string' ? input.headers : null));
        if (enabled !== false) observeResponse(found, url, result);
      }
    } catch (_) {}
    return result;
  };

  /* -------------------- XHR hook (belt to fetch's braces) -------------------- */

  const XHRp = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHRp && typeof XHRp.open === 'function' && typeof XHRp.send === 'function') {
    const realOpen = XHRp.open;
    const realSend = XHRp.send;
    const realSetHeader = XHRp.setRequestHeader;
    XHRp.open = function (method, url) {
      try {
        const found = XR.interestingOp(url);
        this.__ptXRay = found ? { found, url: String(url), headers: {} } : null;
      } catch (_) { this.__ptXRay = null; }
      return realOpen.apply(this, arguments);
    };
    if (typeof realSetHeader === 'function') {
      XHRp.setRequestHeader = function (name, value) {
        try {
          if (this.__ptXRay) this.__ptXRay.headers[String(name).toLowerCase()] = String(value);
        } catch (_) {}
        return realSetHeader.apply(this, arguments);
      };
    }
    XHRp.send = function () {
      try {
        const tag = this.__ptXRay;
        if (tag) {
          captureShape(tag.found.op, tag.url, tag.headers);
          if (enabled !== false) {
            this.addEventListener('load', () => {
              try {
                if (this.status >= 200 && this.status < 300 && typeof this.responseText === 'string') {
                  digestText(tag.found, tag.url, this.responseText);
                }
              } catch (_) {}
            });
          }
        }
      } catch (_) {}
      return realSend.apply(this, arguments);
    };
  }

  /* -------------------- deep-scan replay -------------------- */

  let lastReplayAt = 0;
  let replayStamps = [];

  function scanFailed(requestId, op, status) {
    post({
      op, users: [], tweets: [], cursor: null, subjectRestId: null,
      followersTarget: null, opShape: null,
      scan: { requestId: String(requestId), status },
    });
  }

  async function runScan(cmd) {
    const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : '';
    const op = typeof cmd.op === 'string' && XR.REPLAY_OPS.has(cmd.op) ? cmd.op : null;
    if (!requestId || !op || !/^\d{1,25}$/.test(String(cmd.userId || ''))) return;

    const now = Date.now();
    replayStamps = replayStamps.filter((t) => now - t < 60_000);
    if (now - lastReplayAt < REPLAY_MIN_GAP_MS || replayStamps.length >= REPLAY_PER_MINUTE) {
      scanFailed(requestId, op, 'throttled');
      return;
    }

    // Prefer the shape captured live this session; fall back to one the
    // ledger learned earlier (relayed through the panel with the command).
    let shape = shapes.get(op) || null;
    if (!shape && cmd.shape && typeof cmd.shape.url === 'string'
        && cmd.shape.headers && typeof cmd.shape.headers === 'object') {
      shape = { url: cmd.shape.url, headers: pickHeaders(cmd.shape.headers) };
    }
    if (!shape || !shape.headers.authorization) {
      scanFailed(requestId, op, 'no_shape');
      return;
    }

    let url;
    try {
      url = new URL(shape.url, window.location.origin);
      if (url.origin !== window.location.origin) throw new Error('cross-origin shape');
      const vars = JSON.parse(url.searchParams.get('variables') || '{}');
      vars.userId = String(cmd.userId);
      delete vars.screen_name;
      if (typeof cmd.count === 'number' && cmd.count > 0 && cmd.count <= 100) vars.count = cmd.count;
      if (typeof cmd.cursor === 'string' && cmd.cursor) vars.cursor = cmd.cursor;
      else delete vars.cursor;
      url.searchParams.set('variables', JSON.stringify(vars));
    } catch (_) {
      scanFailed(requestId, op, 'bad_shape');
      return;
    }

    const headers = { ...shape.headers };
    const csrf = csrfToken();
    if (csrf) headers['x-csrf-token'] = csrf;

    lastReplayAt = now;
    replayStamps.push(now);
    let res = null;
    try {
      res = await realFetch.call(window, url.toString(), {
        method: 'GET',
        headers,
        credentials: 'include',
      });
    } catch (_) {
      scanFailed(requestId, op, 'network');
      return;
    }
    if (!res.ok) {
      // Query id rotated, rate limited, or the endpoint changed underneath
      // us: retire the shape so this session stops trying, and report the
      // status so the ledger can drop its remembered copy too.
      shapes.delete(op);
      shapeAnnounced.delete(op);
      scanFailed(requestId, op, res.status);
      return;
    }
    try {
      const text = await res.text();
      const found = XR.interestingOp(url.toString()) || { op, queryId: '' };
      digestText(found, url.toString(), text, { requestId, status: 200 });
    } catch (_) {
      scanFailed(requestId, op, 'unreadable');
    }
  }
})();
