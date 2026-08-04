/* PaperTrench — live on-chain price feed (service worker).
 *
 * Holds one WebSocket to a Solana RPC and `accountSubscribe`s to the pool
 * backing the token on screen, at `processed` commitment (~400ms) rather than
 * `confirmed` (~2-3s, what aggregators publish from).
 *
 * Decoding lives in onchain.js and every offset there was verified against
 * mainnet. This file is transport and lifecycle only.
 *
 * Invariants:
 *   - A notification from an older slot never replaces a newer one.
 *   - A pool whose owner program has no verified decoder produces no on-chain
 *     quote at all. It falls back to the aggregator and says so.
 *   - The socket reconnects with backoff and resubscribes; a dead socket must
 *     never look like a quiet market.
 */
(() => {
  'use strict';

  const O = (typeof self !== 'undefined' && self.PTOnchain)
    || (typeof window !== 'undefined' && window.PTOnchain)
    || (typeof require === 'function' ? require('./onchain.js') : null);
  const POOL = (typeof self !== 'undefined' && self.PTRpcPool)
    || (typeof window !== 'undefined' && window.PTRpcPool)
    || (typeof require === 'function' ? require('./rpc-pool.js') : null);

  // A missing dependency previously surfaced as watch() quietly returning
  // false, which looked identical to "this pool has no decoder" and hid the
  // real fault for an entire release. Fail loudly instead.
  if (!O || !POOL) {
    try {
      console.error('PaperTrench: on-chain feed disabled — missing',
        !O ? 'PTOnchain' : '', !POOL ? 'PTRpcPool' : '');
    } catch (_) {}
  }

  const COMMITMENT = 'processed';
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 15000;
  // A quote older than this is not fresh enough to fill against.
  const QUOTE_STALE_MS = 2500;

  let socket = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let nextRequestId = 1;
  // Index into the ranked WebSocket list, so a dead endpoint is stepped past
  // rather than retried forever.
  let wsIndex = 0;
  let activeWsId = null;

  // mint -> { pool, kind, decimals, subId, quote }
  const watched = new Map();
  // subscription id -> mint
  const subToMint = new Map();
  const pending = new Map();
  const listeners = new Set();

  /**
   * Point the feed at a user-supplied endpoint. Entirely optional — the
   * keyless public pool is the default and requires no setup from anyone.
   */
  function configure(opts) {
    if (!opts || !POOL) return;
    POOL.setUserEndpoint(opts.rpcUrl || null);
    // A changed endpoint invalidates the current socket.
    if (socket) { try { socket.close(); } catch (_) {} socket = null; }
    wsIndex = 0;
  }

  function onQuote(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function emit(quote) {
    for (const fn of listeners) {
      try { fn(quote); } catch (_) { /* one bad listener must not stop the feed */ }
    }
  }

  /* ---------------- HTTP RPC ---------------- */

  /** Every HTTP read goes through the pool, so one throttled endpoint is survivable. */
  function rpc(method, params) {
    return POOL.call(method, params);
  }

  async function getAccounts(addresses) {
    if (!addresses.length) return [];
    const result = await rpc('getMultipleAccounts', [
      addresses, { encoding: 'base64', commitment: COMMITMENT },
    ]);
    return (result && result.value) || [];
  }

  /* ---------------- pool resolution ---------------- */

  /**
   * Inspect a pool account once to learn how it must be decoded and which
   * accounts have to be watched for live price.
   */
  async function describePool(poolAddress, mint) {
    const [account] = await getAccounts([poolAddress]);
    if (!account) return null;

    const kind = O.poolKindForOwner(account.owner);
    if (!kind) return null; // no verified layout -> no on-chain quote

    const bytes = O.bytesFromBase64(account.data[0]);
    if (kind === 'whirlpool' || kind === 'clmm') {
      const pool = O.decodeWhirlpool(bytes);
      if (!pool) return null;
      const decimals = await mintDecimals([pool.mintA, pool.mintB]);
      if (decimals[pool.mintA] == null || decimals[pool.mintB] == null) return null;
      return { kind, watch: poolAddress, pool, decimals, mint };
    }
    if (kind === 'pump-curve') {
      const decimals = await mintDecimals([mint]);
      return { kind, watch: poolAddress, decimals, mint };
    }
    // Constant product: the price lives in the two vaults, so those are what
    // must be watched, not the pool header. The decimals map is required to
    // turn vault balances into a price — omitting it crashed priceFromEntry
    // on the first vault update (issue #17: sell options disappeared because
    // the dead price stream starved the overlay).
    const vaults = await findVaults(bytes, mint);
    if (!vaults) return null;
    // Both the token and WSOL decimals are needed to turn vault balances into
    // a price — fetch them here so priceFromEntry never sees a gap.
    const decimals = await mintDecimals([mint, O.WSOL_MINT]);
    if (decimals[mint] == null || decimals[O.WSOL_MINT] == null) return null;
    return { kind, watch: vaults.base, watchQuote: vaults.quote, vaults, decimals, mint };
  }

  const decimalsCache = new Map();

  async function mintDecimals(mints) {
    const out = {};
    const missing = [];
    for (const m of mints) {
      if (decimalsCache.has(m)) out[m] = decimalsCache.get(m);
      else missing.push(m);
    }
    if (missing.length) {
      const accounts = await getAccounts(missing);
      accounts.forEach((account, i) => {
        if (!account) return;
        const info = O.decodeMint(O.bytesFromBase64(account.data[0]));
        if (info) {
          decimalsCache.set(missing[i], info.decimals);
          out[missing[i]] = info.decimals;
        }
      });
    }
    return out;
  }

  /**
   * Locate a constant-product pool's two vaults by scanning the pool account
   * for embedded pubkeys and keeping the largest token account per mint.
   * Layouts differ per program; the vaults themselves are always plain SPL
   * token accounts, which is what makes this reliable.
   */
  async function findVaults(poolBytes, mint) {
    if (!poolBytes) return null;
    const candidates = [];
    const seen = new Set();
    for (let offset = 0; offset + 32 <= poolBytes.length; offset += 1) {
      const key = O.readPubkey(poolBytes, offset);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push(key);
    }

    let base = null;
    let quote = null;
    for (let i = 0; i < candidates.length; i += 100) {
      const chunk = candidates.slice(i, i + 100);
      const accounts = await getAccounts(chunk);
      accounts.forEach((account, index) => {
        if (!account) return;
        if (account.owner !== O.TOKEN_PROGRAM && account.owner !== O.TOKEN_2022_PROGRAM) return;
        const decoded = O.decodeTokenAccount(O.bytesFromBase64(account.data[0]));
        if (!decoded) return;
        const address = chunk[index];
        if (decoded.mint === mint && (!base || decoded.amount > base.amount)) {
          base = { address, amount: decoded.amount };
        } else if (decoded.mint === O.WSOL_MINT && (!quote || decoded.amount > quote.amount)) {
          quote = { address, amount: decoded.amount };
        }
      });
    }
    if (!base || !quote) return null;
    return { base: base.address, quote: quote.address };
  }

  /* ---------------- pricing ---------------- */

  function priceFromEntry(entry) {
    if (!entry || !entry.desc) return null;
    const d = entry.desc;
    // A malformed or partial desc must yield "no price yet", never a throw:
    // a throw inside the socket handler kills live prices for every token.
    if (!d.decimals || d.decimals[d.mint] == null) return null;
    if (d.kind === 'whirlpool' || d.kind === 'clmm') {
      if (!entry.raw) return null;
      const pool = O.decodeWhirlpool(entry.raw);
      return O.priceFromSqrtPrice(pool, d.mint, d.decimals);
    }
    if (d.kind === 'pump-curve') {
      if (!entry.raw) return null;
      const curve = O.decodePumpCurve(entry.raw);
      if (!curve || curve.complete) return null; // migrated: price the AMM pool
      return O.priceFromPumpCurve(curve, d.decimals[d.mint]);
    }
    if (entry.baseAmount == null || entry.quoteAmount == null) return null;
    return O.priceFromVaults(
      entry.baseAmount, d.decimals[d.mint],
      entry.quoteAmount, d.decimals[O.WSOL_MINT]
    );
  }

  /* ---------------- socket ---------------- */

  function ensureSocket() {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return socket;

    const candidates = POOL.websocketUrls();
    if (!candidates.length) return null;
    // Walk the ranked list rather than hammering one endpoint. A public node
    // that streams fine one minute can go quiet the next.
    const candidate = candidates[wsIndex % candidates.length];
    activeWsId = candidate.id;

    socket = new WebSocket(candidate.url);
    socket.onopen = () => {
      reconnectAttempt = 0;
      POOL.reportSuccess(candidate.id, null);
      for (const mint of watched.keys()) subscribe(mint);
    };
    socket.onmessage = (event) => handleMessageSafe(event.data);
    socket.onclose = () => {
      socket = null;
      subToMint.clear();
      for (const entry of watched.values()) entry.subIds = [];
      scheduleReconnect();
    };
    socket.onerror = () => {
      POOL.reportFailure(candidate.id);
      // Advance so the next attempt tries a different provider.
      wsIndex += 1;
      try { socket.close(); } catch (_) {}
    };
    return socket;
  }

  function scheduleReconnect() {
    if (reconnectTimer || !watched.size) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt++), RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; ensureSocket(); }, delay);
  }

  function send(payload) {
    const ws = ensureSocket();
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(payload)); return true; }
    return false;
  }

  function subscribe(mint) {
    const entry = watched.get(mint);
    if (!entry || !entry.desc) return;
    for (const account of accountsToWatch(entry.desc)) {
      const id = nextRequestId++;
      pending.set(id, { mint, account });
      send({
        jsonrpc: '2.0', id, method: 'accountSubscribe',
        params: [account, { encoding: 'base64', commitment: COMMITMENT }],
      });
    }
  }

  function accountsToWatch(desc) {
    return desc.watchQuote ? [desc.watch, desc.watchQuote] : [desc.watch];
  }

  function handleMessage(data) {
    let message;
    try { message = JSON.parse(data); } catch (_) { return; }

    // Subscription acknowledgement.
    if (message.id != null && pending.has(message.id)) {
      const info = pending.get(message.id);
      pending.delete(message.id);
      if (typeof message.result === 'number') {
        subToMint.set(message.result, info);
        const entry = watched.get(info.mint);
        if (entry) entry.subIds = (entry.subIds || []).concat(message.result);
      }
      return;
    }

    if (message.method !== 'accountNotification') return;
    const params = message.params || {};
    const info = subToMint.get(params.subscription);
    if (!info) return;

    const result = params.result || {};
    const slot = result.context && result.context.slot;
    const value = result.value;
    if (!value || !value.data) return;

    const entry = watched.get(info.mint);
    if (!entry) return;

    // Out-of-order frames must never overwrite fresher state.
    if (!O.isNewerObservation(slot, entry.slot)) return;

    const bytes = O.bytesFromBase64(value.data[0]);
    const desc = entry.desc;

    if (desc.kind === 'cp-vaults') {
      const decoded = O.decodeTokenAccount(bytes);
      if (!decoded) return;
      if (info.account === desc.watch) entry.baseAmount = decoded.amount;
      else entry.quoteAmount = decoded.amount;
    } else {
      entry.raw = bytes;
    }

    const priceNative = priceFromEntry(entry);
    if (!(priceNative > 0)) return;

    entry.slot = slot;
    entry.priceNative = priceNative;
    entry.observedAt = Date.now();

    emit({
      mint: info.mint,
      priceNative,
      slot,
      source: 'onchain',
      poolKind: desc.kind,
      observedAt: entry.observedAt,
    });
  }

  /**
   * One malformed or hostile frame must never kill the stream. handleMessage
   * runs inside the WebSocket onmessage path, so an uncaught throw there
   * silently ends every live price in the session (issue #17). Isolate it.
   */
  function handleMessageSafe(data) {
    try { handleMessage(data); } catch (_) { /* drop the frame, keep the feed */ }
  }

  /* ---------------- public API ---------------- */

  /** Begin streaming live on-chain prices for `mint` via `poolAddress`. */
  async function watch(mint, poolAddress) {
    if (!mint || !poolAddress) return false;
    if (!O || !POOL) return false;
    const existing = watched.get(mint);
    if (existing && existing.desc && existing.desc.watch) return true;

    // A thrown error here means a real fault (missing dependency, RPC down),
    // not "unsupported pool". Swallowing it silently is what let a dead feed
    // ship looking exactly like a pool we simply cannot decode.
    let desc = null;
    try {
      desc = await describePool(poolAddress, mint);
    } catch (error) {
      try { console.error('PaperTrench: on-chain watch failed:', error && error.message); } catch (_) {}
      return false;
    }
    if (!desc) return false;

    watched.set(mint, { desc, slot: 0, subIds: [] });
    ensureSocket();
    subscribe(mint);
    return true;
  }

  /** Stop streaming a mint and release its subscriptions. */
  function unwatch(mint) {
    const entry = watched.get(mint);
    if (!entry) return;
    for (const subId of entry.subIds || []) {
      send({ jsonrpc: '2.0', id: nextRequestId++, method: 'accountUnsubscribe', params: [subId] });
      subToMint.delete(subId);
    }
    watched.delete(mint);
    if (!watched.size && socket) { try { socket.close(); } catch (_) {} socket = null; }
  }

  /** The newest on-chain quote for a mint, or null if none is fresh enough. */
  function currentQuote(mint) {
    const entry = watched.get(mint);
    if (!entry || !(entry.priceNative > 0)) return null;
    if (Date.now() - entry.observedAt > QUOTE_STALE_MS) return null;
    return {
      mint,
      priceNative: entry.priceNative,
      slot: entry.slot,
      source: 'onchain',
      poolKind: entry.desc.kind,
      observedAt: entry.observedAt,
    };
  }

  function isLive(mint) { return Boolean(currentQuote(mint)); }

  /** Which provider is currently streaming, for status display. */
  function activeEndpoint() { return activeWsId; }

  const api = {
    configure, watch, unwatch, currentQuote, isLive, onQuote, activeEndpoint,
    QUOTE_STALE_MS, COMMITMENT,
    // Exposed for tests.
    _describePool: describePool,
    _handleMessage: handleMessage,
    _watched: watched,
    _priceFromEntry: priceFromEntry,
  };

  if (typeof self !== 'undefined') self.PTOnchainFeed = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
