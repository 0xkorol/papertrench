/* PaperTrench — trade attestation.
 *
 * A paper-trading leaderboard is trivially cheatable: every number lives on the
 * user's own machine, so self-reported P&L is worth nothing. This module does
 * not pretend to make cheating impossible. It produces EVIDENCE that a server
 * can independently verify, and it is explicit about what that evidence does
 * and does not prove.
 *
 * What the chain proves:
 *   - Ordering. Each fill commits to the hash of the previous one, so a trade
 *     cannot be inserted, removed, or reordered after the fact without breaking
 *     every link that follows it.
 *   - Pre-commitment. A fill is hashed at the moment it is made, before its
 *     outcome is known. Backdating a winning entry invalidates the chain.
 *   - Price claims. Every fill records mint, side, quantity, price and
 *     timestamp, so a verifier can re-fetch the historical price for that mint
 *     at that second and reject fills at prices that never existed.
 *
 * What it does NOT prove:
 *   - That the user ran unmodified code. A determined attacker can always forge
 *     a locally-consistent chain. That is why ranking must be server-verified
 *     against real price history, and why identity is bound to an X account:
 *     forging costs a real, rate-limited, publicly visible identity.
 */
(() => {
  'use strict';

  const VERSION = 1;
  const GENESIS = 'papertrench-genesis-v1';

  function subtle() {
    const c = (typeof crypto !== 'undefined' && crypto) || null;
    return c && c.subtle ? c.subtle : null;
  }

  function bytes(text) {
    return new TextEncoder().encode(text);
  }

  function hex(buffer) {
    return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function sha256(text) {
    const api = subtle();
    if (!api) throw new Error('WebCrypto unavailable');
    return hex(await api.digest('SHA-256', bytes(text)));
  }

  /**
   * The exact bytes a fill commits to.
   *
   * Deterministic and explicit: a verifier must be able to reproduce this
   * string from the public fill record alone, so field order and formatting are
   * part of the contract rather than an implementation detail.
   */
  function fillPreimage(fill, previousHash) {
    return [
      'v' + VERSION,
      previousHash,
      String(fill.id || ''),
      String(fill.sessionId || ''),
      String(fill.mint || ''),
      String(fill.side || ''),
      // Fixed precision keeps the digest stable across float formatting.
      Number(fill.qty || 0).toFixed(12),
      Number(fill.priceNative || 0).toExponential(12),
      // Cash-basis amount: gross on buy, net on sell.
      Number(fill.side === 'buy'
        ? (fill.solGross !== undefined ? fill.solGross : fill.solNet)
        : (fill.solNet !== undefined ? fill.solNet : fill.solGross)
      ).toFixed(12),
      String(Math.trunc(Number(fill.ts) || 0)),
    ].join('|');
  }

  /** Append one fill to the chain, returning its link. */
  async function appendFill(previousHash, fill) {
    const prev = previousHash || GENESIS;
    const preimage = fillPreimage(fill, prev);
    const hash = await sha256(preimage);
    return {
      version: VERSION,
      seq: null, // assigned by the caller that owns the chain
      id: String(fill.id || ''),
      sessionId: String(fill.sessionId || ''),
      mint: String(fill.mint || ''),
      side: String(fill.side || ''),
      qty: Number(fill.qty) || 0,
      priceNative: Number(fill.priceNative) || 0,
      solGross: Number(fill.solGross) || 0,
      solNet: Number(fill.solNet !== undefined ? fill.solNet : fill.solGross) || 0,
      // Flat per-transaction cost (gas + tip emulation). Stored like solNet —
      // uncommitted but replayed — so the chain-derived P&L keeps agreeing
      // with an honest wallet when cost emulation is on.
      txCostSol: Number(fill.txCostSol) || 0,
      amount: Number(fill.side === 'buy'
        ? (fill.solGross !== undefined ? fill.solGross : fill.solNet)
        : (fill.solNet !== undefined ? fill.solNet : fill.solGross)
      ) || 0,
      ts: Math.trunc(Number(fill.ts) || 0),
      prev,
      hash,
    };
  }

  /**
   * Verify a chain end to end.
   *
   * Returns every problem found rather than the first, because a verifier
   * showing "3 fills were altered" is far more useful than "invalid".
   */
  async function verifyChain(links) {
    const list = Array.isArray(links) ? links : [];
    const problems = [];
    let previous = GENESIS;

    for (let i = 0; i < list.length; i++) {
      const link = list[i] || {};
      if (link.prev !== previous) {
        problems.push({ index: i, id: link.id, reason: 'broken-link' });
      }
      const expected = await sha256(fillPreimage(link, link.prev || GENESIS));
      if (expected !== link.hash) {
        problems.push({ index: i, id: link.id, reason: 'hash-mismatch' });
      }
      // Time must move forward; a backdated fill is the classic cheat.
      if (i > 0 && Number(link.ts) < Number(list[i - 1].ts)) {
        problems.push({ index: i, id: link.id, reason: 'out-of-order-timestamp' });
      }
      previous = link.hash;
    }

    return {
      valid: problems.length === 0,
      length: list.length,
      head: list.length ? list[list.length - 1].hash : GENESIS,
      problems,
    };
  }

  /**
   * Build the payload a leaderboard server would verify.
   *
   * It deliberately carries the full chain rather than a summary: a server that
   * only receives "I made 4.2 SOL" has nothing to check. With the chain it can
   * recompute the result AND re-price every fill against real history.
   */
  function buildSubmission(opts) {
    const options = opts || {};
    const chain = Array.isArray(options.chain) ? options.chain : [];
    const stats = options.stats || {};
    return {
      version: VERSION,
      submittedAt: Date.now(),
      identity: options.identity || null,
      // Claimed result — treated as untrusted until the server recomputes it.
      claim: {
        equitySol: Number(stats.equitySol) || 0,
        realizedPnlSol: Number(stats.realizedPnlSol) || 0,
        rounds: Number(stats.rounds) || 0,
        wins: Number(stats.wins) || 0,
        losses: Number(stats.losses) || 0,
        startingBalanceSol: Number(options.startingBalanceSol) || 0,
      },
      chain,
      head: chain.length ? chain[chain.length - 1].hash : GENESIS,
      // Stated plainly so no one mistakes local evidence for proof.
      trustModel: 'client-generated evidence; server must re-verify every fill price',
    };
  }

  /**
   * Recompute a result from the chain alone.
   *
   * This is the function a server runs instead of trusting `claim`. It is
   * exported so the client can show the user the same number a verifier would
   * compute — if the two disagree, the local state has been tampered with.
   */
  function replayChain(links, startingBalanceSol) {
    const list = Array.isArray(links) ? links : [];
    let cash = Number(startingBalanceSol) || 0;
    const positions = new Map();
    let realized = 0;
    let wins = 0;
    let losses = 0;

    for (const link of list) {
      const qty = Number(link.qty) || 0;
      const price = Number(link.priceNative) || 0;
      const amount = Number(link.amount !== undefined
        ? link.amount
        : (link.side === 'buy' ? link.solGross : link.solNet)
      ) || 0;
      if (!(qty > 0) || !(price > 0)) continue;

      if (link.side === 'buy') {
        cash -= amount;
        const held = positions.get(link.mint) || { qty: 0, cost: 0 };
        held.qty += qty;
        // D-02/D-03: the cost basis accumulates at the NET amount (gross
        // minus the buy fee) because that is exactly how the engine books it
        // (sell(): pnl = net proceeds − net cost share, accumulated into
        // stats.realizedPnlSol). Replaying at GROSS cost made the derived
        // realized P&L sit below an honest client's displayed figure by its
        // cumulative buy fees, so claimMatchesChain flagged every untampered
        // wallet as edited the moment it paid a fee. Every link stores
        // solNet; only `amount` (gross on buys) is hash-committed, which is
        // acceptable under the stated trust model — the chain is evidence,
        // not proof, and a server re-verifies every fill against real price
        // history anyway. Links without solNet (foreign/minimal fills) fall
        // back to the committed gross amount, preserving old behaviour.
        // Buy-side flat tx costs join the basis exactly as the engine books
        // them (costSol += net + flat); sell-side flats already flow through
        // the sell link's solNet.
        held.cost += (Number(link.solNet) > 0 ? Number(link.solNet) : amount)
          + (Number(link.txCostSol) || 0);
        positions.set(link.mint, held);
      } else if (link.side === 'sell') {
        const held = positions.get(link.mint);
        if (!held || held.qty <= 0) continue;
        const share = Math.min(1, qty / held.qty);
        const costOut = held.cost * share;
        cash += amount;
        realized += amount - costOut;
        held.qty -= qty;
        held.cost -= costOut;
        if (held.qty <= 1e-12) {
          positions.delete(link.mint);
          if (amount - costOut > 0) wins += 1; else losses += 1;
        } else {
          positions.set(link.mint, held);
        }
      }
    }

    return {
      cashSol: cash,
      openPositions: positions.size,
      realizedPnlSol: realized,
      wins,
      losses,
      rounds: wins + losses,
    };
  }

  /**
   * Does the locally displayed result match what the chain actually implies?
   *
   * A mismatch means stored state disagrees with the committed history — the
   * signature of hand-edited storage.
   */
  function claimMatchesChain(claim, links, startingBalanceSol, tolerance) {
    const replayed = replayChain(links, startingBalanceSol);
    const tol = Number(tolerance) > 0 ? Number(tolerance) : 1e-6;
    const diff = Math.abs(replayed.realizedPnlSol - (Number(claim.realizedPnlSol) || 0));
    return {
      ok: diff <= tol,
      diff,
      replayed,
    };
  }

  const api = {
    VERSION, GENESIS,
    sha256, fillPreimage, appendFill, verifyChain,
    buildSubmission, replayChain, claimMatchesChain,
  };

  if (typeof window !== 'undefined') window.PTAttest = api;
  if (typeof self !== 'undefined') self.PTAttest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
