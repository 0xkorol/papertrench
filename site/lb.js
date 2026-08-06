/* PaperTrench site — leaderboard client.
 *
 * Talks to the API worker (api.papertrench.com) and, when the user clicks
 * Sync, to the extension over the externally_connectable bridge. Honesty
 * rules carried over from the product: every number rendered here came from
 * the server's replay of a verified chain or it is not rendered — no
 * invented rows, no placeholder standings, and unreachable-server states say
 * so instead of showing something.
 */
(() => {
  'use strict';

  const API = 'https://api.papertrench.com';
  // The stable id the Chrome Web Store assigns the published extension.
  // Unpacked developer installs get per-machine ids the site cannot know —
  // those users use the exported-file path instead (DEPLOY.md).
  const EXTENSION_IDS = ['REPLACE_WITH_CWS_EXTENSION_ID'];

  const esc = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmt = (n, digits) => {
    const value = Number(n);
    if (!Number.isFinite(value)) return '—';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
  };

  const signed = (n, digits, suffix) => {
    const value = Number(n) || 0;
    return (value >= 0 ? '+' : '') + fmt(value, digits) + (suffix || '');
  };

  async function api(path, options) {
    const res = await fetch(API + path, Object.assign({ credentials: 'include' }, options || {}));
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  /* ---------------- session ---------------- */

  async function me() {
    try { return (await api('/api/me')).body || { signedIn: false }; }
    catch { return { signedIn: false, unreachable: true }; }
  }

  function signIn() { window.location.href = API + '/api/auth/x/start'; }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    window.location.reload();
  }

  /* ---------------- extension bridge ---------------- */

  function bridgeSend(message) {
    return new Promise((resolve) => {
      if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) {
        resolve(null); // not a Chromium browser, or no extension API exposed
        return;
      }
      let settled = 0;
      const finish = (value) => { if (!settled++) resolve(value); };
      const tryId = (index) => {
        if (index >= EXTENSION_IDS.length) { finish(null); return; }
        try {
          chrome.runtime.sendMessage(EXTENSION_IDS[index], message, (response) => {
            if (chrome.runtime.lastError || !response) { tryId(index + 1); return; }
            finish(response);
          });
        } catch { tryId(index + 1); }
      };
      tryId(0);
      setTimeout(() => finish(null), 2500);
    });
  }

  const bridgePing = () => bridgeSend({ type: 'pt_bridge_ping' });
  const bridgeGetRecord = () => bridgeSend({ type: 'pt_bridge_get_record' });

  /* ---------------- submission ---------------- */

  async function submit(payload) {
    try {
      return await api('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      return { status: 0, body: { ok: false, reason: 'server-unreachable' } };
    }
  }

  /* ---------------- rendering ---------------- */

  const STATUS_BADGE = {
    verified: '<span class="verify">✓ VERIFIED</span>',
    pending: '<span class="verify" style="color:var(--orange2);border-color:rgba(255,157,69,.35);background:rgba(255,157,69,.08)">VERIFYING…</span>',
    partial: '<span class="verify" style="color:var(--blue);border-color:rgba(106,169,255,.35);background:rgba(106,169,255,.08)">PARTIAL DATA</span>',
  };

  const AVATAR_TONES = [
    'background:rgba(255,157,69,.2);color:var(--orange2)',
    'background:rgba(106,169,255,.2);color:var(--blue)',
    'background:rgba(167,139,250,.2);color:var(--violet)',
    'background:rgba(52,211,153,.2);color:var(--green)',
    'background:rgba(224,67,58,.2);color:#ff8a80',
  ];

  function avatar(entry, index) {
    if (entry.avatarUrl) {
      return `<img class="avatar" src="${esc(entry.avatarUrl)}" alt="" referrerpolicy="no-referrer">`;
    }
    const initials = String(entry.handle || '??').slice(0, 2).toUpperCase();
    return `<span class="avatar" style="${AVATAR_TONES[index % AVATAR_TONES.length]}">${esc(initials)}</span>`;
  }

  /** One standings row. `main` and `sub` are the two right-hand columns. */
  function row(entry, index, main, sub) {
    return `
      <a class="lb-row" href="profile.html?handle=${encodeURIComponent(entry.handle)}" style="text-decoration:none;color:inherit">
        <span class="rank">#${index + 1}</span>
        <span class="handle">${avatar(entry, index)}${esc(entry.handle)} ${STATUS_BADGE[entry.status] || ''}</span>
        <span class="pnl">${main}</span>
        <span class="win">${sub}</span>
      </a>`;
  }

  function emptyState(message) {
    return `<p style="color:var(--dim);font-size:13.5px;line-height:1.65;padding:18px 6px">${message}</p>`;
  }

  window.PTLB = {
    API, EXTENSION_IDS, esc, fmt, signed,
    me, signIn, logout,
    bridgePing, bridgeGetRecord, submit,
    row, emptyState, STATUS_BADGE,
    api,
  };
})();
