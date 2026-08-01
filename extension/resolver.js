/* PaperTrench — token resolver (I/O layer).
 *
 * Turns an address taken from a page URL (either a token mint OR an LP/pair
 * address) into a verified token record + anchor quote, using the free
 * Dexscreener API (no key, no registration).
 *
 * All decision logic lives in quote.js as pure functions; this file is only
 * the network wrapper around them, so the interesting behavior stays testable
 * without a network.
 */
(function () {
  'use strict';

  var Q = (typeof window !== 'undefined' && window.PaperQuote)
    || (typeof self !== 'undefined' && self.PaperQuote)
    || (typeof module !== 'undefined' && module.exports ? require('./quote.js') : null);

  var BASE = 'https://api.dexscreener.com/latest/dex';
  var TTL_MS = 60000;
  var cache = new Map(); // address -> { at, data }

  function cacheGet(address) {
    var hit = cache.get(address);
    if (!hit) return null;
    if (Date.now() - hit.at >= TTL_MS) { cache.delete(address); return null; }
    return hit.data;
  }

  function cachePut(data) {
    if (!data) return;
    var at = Date.now();
    if (data.mint) cache.set(data.mint, { at: at, data: data });
    if (data.pairAddress) cache.set(data.pairAddress, { at: at, data: data });
  }

  async function getJson(url, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 4000) : null;
    try {
      var res = await fetch(url, ctrl ? { cache: 'no-store', signal: ctrl.signal } : { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  var JUP = 'https://lite-api.jup.ag/tokens/v2/search';

  // SOL/USD is needed to convert Jupiter's USD-only quotes into the SOL prices
  // the engine trades in. It moves slowly relative to a memecoin, so a short
  // cache keeps fresh-launch resolution to a single round trip.
  var solUsdCache = { at: 0, value: 0 };
  var SOL_USD_TTL_MS = 30000;

  function jupiterUrl(query) {
    return JUP + '?query=' + encodeURIComponent(query);
  }

  /**
   * Ask Jupiter for a token AND the SOL reference in one request.
   * Returns { record, solUsd } — record is null when Jupiter doesn't know it.
   */
  async function resolveViaJupiter(address) {
    var fresh = Date.now() - solUsdCache.at < SOL_USD_TTL_MS && solUsdCache.value > 0;
    // Bundle WSOL into the same query when the cached rate is stale, so a
    // brand-new coin still costs exactly one request.
    var query = fresh ? address : address + ',' + Q.WSOL_MINT;
    var payload = await getJson(jupiterUrl(query), 4000);
    if (!payload) return { record: null, solUsd: fresh ? solUsdCache.value : 0 };

    var solUsd = fresh ? solUsdCache.value : Q.solUsdFromJupiter(payload);
    if (solUsd > 0) solUsdCache = { at: Date.now(), value: solUsd };
    if (!(solUsd > 0)) return { record: null, solUsd: 0 };

    return { record: Q.tokenFromJupiter(payload, address, solUsd), solUsd: solUsd };
  }

  /**
   * Resolve an address that may be a mint or a pair address.
   *
   * All three lookups are issued together. Dexscreener gives the venue price
   * for established tokens; Jupiter covers the first seconds of a launch, when
   * Dexscreener still returns `pairs: null`. Racing them means a sniper is not
   * blocked waiting for whichever source is slower to index.
   */
  async function resolve(address) {
    if (!address) return null;

    var cached = cacheGet(address);
    if (cached) return cached;

    var results = await Promise.all([
      getJson(BASE + '/tokens/' + address),
      getJson(BASE + '/pairs/solana/' + address),
      resolveViaJupiter(address).catch(function () { return { record: null, solUsd: 0 }; }),
    ]);
    var byToken = results[0];
    var byPair = results[1];
    var viaJup = results[2] || { record: null };

    // A pair lookup is unambiguous, so prefer it when it returned something.
    var dexData = Q.tokenFromPayload(byPair, address) || Q.tokenFromPayload(byToken, address);
    var data = Q.preferResolved(dexData, viaJup.record);
    if (data) {
      if (!data.mint) data.mint = address;
      cachePut(data);
    }
    return data;
  }

  /** Re-quote an already-resolved token (slow safety net behind the live feed). */
  async function refresh(token) {
    if (!token) return null;

    // A token first resolved through Jupiter is, by definition, one that
    // Dexscreener did not have. Re-quoting it there would return nothing and
    // freeze the price, so keep using the source that actually knows it until
    // Dexscreener catches up.
    if (token.priceSource === 'jupiter') {
      var viaJup = await resolveViaJupiter(token.mint).catch(function () { return { record: null }; });
      if (viaJup && viaJup.record) { cachePut(viaJup.record); return viaJup.record; }
      // Dexscreener may have indexed it by now; fall through and try.
    }

    var json = token.pairAddress
      ? await getJson(BASE + '/pairs/solana/' + token.pairAddress)
      : await getJson(BASE + '/tokens/' + token.mint);
    var data = json ? Q.tokenFromPayload(json, token.mint) : null;
    if (data) { cachePut(data); return data; }

    // Last resort for a token neither source indexed under its pair address.
    var retry = await resolveViaJupiter(token.mint).catch(function () { return { record: null }; });
    if (retry && retry.record) { cachePut(retry.record); return retry.record; }
    return null;
  }

  /**
   * Price several mints in as few requests as possible.
   *
   * Dexscreener's /tokens/ endpoint accepts a comma-separated list and returns
   * every matching pair in one payload, so N open positions cost roughly
   * ceil(N / CHUNK) requests instead of N. This is what lets the positions bar
   * track tokens whose charts are not on screen.
   */
  var BATCH_CHUNK = 25;

  async function batchPrices(mints) {
    var unique = [];
    var seen = Object.create(null);
    for (var i = 0; i < (mints || []).length; i++) {
      var m = mints[i];
      if (typeof m === 'string' && m && !seen[m]) { seen[m] = 1; unique.push(m); }
    }
    if (!unique.length) return {};

    var chunks = [];
    for (var j = 0; j < unique.length; j += BATCH_CHUNK) {
      chunks.push(unique.slice(j, j + BATCH_CHUNK));
    }

    var payloads = await Promise.all(chunks.map(function (chunk) {
      return getJson(BASE + '/tokens/' + chunk.join(','), 6000);
    }));

    var out = {};
    for (var k = 0; k < payloads.length; k++) {
      var parsed = Q.pricesFromBatch(payloads[k]);
      for (var mint in parsed) {
        if (Object.prototype.hasOwnProperty.call(parsed, mint)) {
          out[mint] = parsed[mint];
          cachePut(parsed[mint]);
        }
      }
    }
    return out;
  }

  function clearCache() { cache.clear(); }

  var api = {
    resolve: resolve,
    refresh: refresh,
    batchPrices: batchPrices,
    clearCache: clearCache,
    BASE: BASE,
    BATCH_CHUNK: BATCH_CHUNK,
  };

  if (typeof window !== 'undefined') window.PaperTrenchResolver = api;
  if (typeof self !== 'undefined') self.PaperTrenchResolver = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
