/* PaperTrench — keyless RPC endpoint pool.
 *
 * WHY THERE IS NO API KEY HERE
 *
 * An extension bundle is public. Anyone can unzip a published build and grep
 * it in under a minute, which is how Avast (7M users), Awesome Screen Recorder
 * (3M) and Equatio (5M) all leaked live credentials. A shipped key is a public
 * key, and one shared key would also mean one shared rate limit for every user
 * of the product.
 *
 * Public Solana RPC limits are enforced PER IP, not per key:
 *
 *   100 requests / 10s per IP
 *   5 concurrent WebSocket subscriptions per IP
 *
 * Every user has their own IP, so a keyless endpoint scales to any number of
 * installs — each install gets its own budget. PaperTrench needs one or two
 * subscriptions for the token on screen, comfortably inside the per-IP cap.
 *
 * Endpoints do go down and do throttle: publicnode streamed nine updates in one
 * probe and zero in the next. So this is a POOL, not a URL. It scores endpoints
 * on observed health and moves on the moment one stops delivering.
 *
 * A user can still point PaperTrench at their own private endpoint in Settings,
 * and it will be preferred. Nobody is required to.
 */
(() => {
  'use strict';

  /**
   * Verified keyless mainnet endpoints. Each was probed live for HTTP account
   * reads and WebSocket `accountSubscribe` streaming. Order is the starting
   * preference only — real ordering comes from measured health.
   */
  const PUBLIC_ENDPOINTS = [
    { id: 'publicnode', http: 'https://solana-rpc.publicnode.com', ws: 'wss://solana-rpc.publicnode.com' },
    { id: 'solana-labs', http: 'https://api.mainnet-beta.solana.com', ws: 'wss://api.mainnet-beta.solana.com' },
    { id: 'tatum', http: 'https://solana-mainnet.gateway.tatum.io', ws: null },
  ];

  // An endpoint that fails is benched, not discarded; transient 429s recover.
  const COOLDOWN_MS = 60_000;
  const PROBE_TIMEOUT_MS = 4000;

  const health = new Map(); // id -> { failures, benchedUntil, latencyMs }
  let userEndpoint = null;

  function stateFor(id) {
    if (!health.has(id)) health.set(id, { failures: 0, benchedUntil: 0, latencyMs: null });
    return health.get(id);
  }

  /** A user-supplied endpoint always wins over the public pool. */
  function setUserEndpoint(url) {
    if (!url || typeof url !== 'string') { userEndpoint = null; return; }
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) { userEndpoint = null; return; }
    userEndpoint = {
      id: 'user',
      http: trimmed,
      ws: trimmed.replace(/^http/i, 'ws'),
    };
  }

  function hasUserEndpoint() { return Boolean(userEndpoint); }

  /**
   * Endpoints in preference order: healthiest first, benched ones last.
   *
   * Sorting rather than filtering matters — if every endpoint is benched we
   * still return the least-bad one instead of leaving the user with no feed.
   */
  function ranked(opts) {
    const needsWs = Boolean(opts && opts.websocket);
    const now = Date.now();
    const list = [];
    if (userEndpoint && (!needsWs || userEndpoint.ws)) list.push(userEndpoint);

    const pool = PUBLIC_ENDPOINTS
      .filter((endpoint) => !needsWs || endpoint.ws)
      .slice()
      .sort((a, b) => {
        const sa = stateFor(a.id);
        const sb = stateFor(b.id);
        const benchedA = sa.benchedUntil > now ? 1 : 0;
        const benchedB = sb.benchedUntil > now ? 1 : 0;
        if (benchedA !== benchedB) return benchedA - benchedB;
        if (sa.failures !== sb.failures) return sa.failures - sb.failures;
        // Prefer a measured-fast endpoint; unmeasured sorts after measured.
        const la = sa.latencyMs == null ? Infinity : sa.latencyMs;
        const lb = sb.latencyMs == null ? Infinity : sb.latencyMs;
        return la - lb;
      });

    return list.concat(pool);
  }

  function reportSuccess(id, latencyMs) {
    const state = stateFor(id);
    state.failures = 0;
    state.benchedUntil = 0;
    if (latencyMs != null) {
      // Smooth the estimate so one slow response cannot demote a good endpoint.
      state.latencyMs = state.latencyMs == null
        ? latencyMs
        : state.latencyMs * 0.7 + latencyMs * 0.3;
    }
  }

  function reportFailure(id) {
    const state = stateFor(id);
    state.failures += 1;
    // Two strikes benches an endpoint; a single blip is not worth losing it.
    if (state.failures >= 2) state.benchedUntil = Date.now() + COOLDOWN_MS;
  }

  /**
   * Perform an RPC call against the first endpoint that answers.
   *
   * Failover is the entire point: a keyless endpoint WILL throttle, and the
   * user must never see that as a dead price feed.
   */
  // Circuit breaker: once every endpoint is benched, more traffic resets
  // nothing — it keeps the strikes coming and the pool benched forever
  // (DEFECT F-09 cascade). Fail fast during the cooldown and let one
  // half-open probe through periodically to discover recovery.
  let lastBenchedProbeAt = 0;
  const BENCHED_PROBE_MS = 5000;

  // Hedged failover: a HANGING endpoint is worse than a failing one — a hard
  // failure steps to the next endpoint immediately, but a hang used to eat
  // the full PROBE_TIMEOUT before failover. Measured live on the sniping
  // path: an identical getMultipleAccounts cost 422ms, then 4159ms, then
  // 75ms — the middle call was one silent endpoint consuming its whole 4s.
  // Now an attempt that has not answered within HEDGE_MS gets a parallel
  // competitor on the next-ranked endpoint; the first success wins and
  // aborts the losers. Hedges only fire when the primary is already slow,
  // so the extra traffic exists exactly when the pool is misbehaving.
  const HEDGE_MS = 500;

  function attemptEndpoint(endpoint, method, params, controllers) {
    const started = Date.now();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller && controllers) controllers.push(controller);
    const timer = controller ? setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS) : null;
    return fetch(endpoint.http, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller ? controller.signal : undefined,
    }).then(async (response) => {
      if (!response.ok) throw new Error('http ' + response.status);
      const json = await response.json();
      if (json.error) throw new Error(json.error.message || 'rpc error');
      reportSuccess(endpoint.id, Date.now() - started);
      return json.result;
    }).catch((error) => {
      reportFailure(endpoint.id);
      throw error;
    }).finally(() => {
      // The abort timer must clear on EVERY path — a rejected fetch used
      // to leak it until it fired (DEFECT F-27).
      if (timer) clearTimeout(timer);
    });
  }

  async function call(method, params, opts) {
    let endpoints = ranked(opts);
    const now = Date.now();
    if (endpoints.length && endpoints.every((e) => stateFor(e.id).benchedUntil > now)) {
      if (now - lastBenchedProbeAt < BENCHED_PROBE_MS) {
        throw new Error('rpc pool cooling down');
      }
      lastBenchedProbeAt = now;
      endpoints = endpoints.slice(0, 1); // the single half-open probe
    }
    if (!endpoints.length) throw new Error('no rpc endpoint available');

    const controllers = [];
    return await new Promise((resolve, reject) => {
      let settled = false;
      let pending = 0;
      let index = 0;
      let hedgeTimer = null;
      let lastError = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; }
        // Losers stop spending the endpoint's rate limit on an answer
        // nobody will read.
        for (const c of controllers) { try { c.abort(); } catch (_) {} }
        fn(value);
      };

      const launchNext = () => {
        hedgeTimer = null;
        if (settled || index >= endpoints.length) return;
        const endpoint = endpoints[index++];
        pending += 1;
        attemptEndpoint(endpoint, method, params, controllers).then(
          (result) => { pending -= 1; finish(resolve, result); },
          (error) => {
            pending -= 1;
            lastError = error;
            if (settled) return;
            if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; }
            if (index < endpoints.length) launchNext(); // hard failure: step on immediately
            else if (pending === 0) finish(reject, lastError || new Error('no rpc endpoint available'));
          }
        );
        // A slow (not failed) attempt earns a competitor.
        if (!settled && index < endpoints.length) hedgeTimer = setTimeout(launchNext, HEDGE_MS);
      };

      launchNext();
    });
  }

  /** WebSocket URLs in preference order, for the streaming feed to walk. */
  function websocketUrls() {
    return ranked({ websocket: true }).map((endpoint) => ({ id: endpoint.id, url: endpoint.ws }));
  }

  const api = {
    PUBLIC_ENDPOINTS, COOLDOWN_MS,
    setUserEndpoint, hasUserEndpoint,
    ranked, call, websocketUrls,
    reportSuccess, reportFailure,
    _health: health,
    _reset: () => { health.clear(); userEndpoint = null; },
  };

  if (typeof self !== 'undefined') self.PTRpcPool = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
