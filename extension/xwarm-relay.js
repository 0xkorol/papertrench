/* PaperTrench — warm X links, x.com side (ISOLATED world relay).
 *
 * Passive until messaged. This script's whole job is to shuttle one message
 * pair between the background worker (chrome.runtime) and the MAIN-world SPA
 * driver (window.postMessage): a navigation request in, a verification result
 * back. It reads nothing from the page and touches no DOM.
 *
 * Requests only ever arrive via chrome.runtime — i.e. from the extension's own
 * background worker — so the page cannot forge one. Results DO cross the
 * MAIN-world boundary (page-controlled); the background treats them as a hint
 * for its repair decision only, and matches them against the request id and
 * sender tab it actually messaged.
 */
(() => {
  'use strict';
  if (window.__ptXWarmRelay) return;
  window.__ptXWarmRelay = true;

  const REQ_TAG = 'papertrench-xwarm-request';
  const RES_TAG = 'papertrench-xwarm-result';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'pt_warm_spa') return;
    window.postMessage({
      source: REQ_TAG,
      requestId: String(msg.requestId || ''),
      url: String(msg.url || ''),
      kind: ['post', 'profile', 'community', 'search'].includes(msg.kind) ? msg.kind : 'post',
      handle: typeof msg.handle === 'string' ? msg.handle : null,
      postId: typeof msg.postId === 'string' ? msg.postId : null,
    }, window.location.origin);
    // Synchronous ack: "the driver has the request". The background reveals
    // the tab on this ack and treats the eventual result (or its absence)
    // as the repair signal.
    sendResponse({ forwarded: true });
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== RES_TAG || typeof data.requestId !== 'string') return;
    try {
      chrome.runtime.sendMessage({
        type: 'pt_warm_spa_result',
        requestId: data.requestId,
        ok: data.ok === true,
        reason: typeof data.reason === 'string' ? data.reason : null,
      }).catch(() => {});
    } catch (_) {
      // Extension context torn down mid-flight; the background's timeout
      // covers the repair.
    }
  });
})();
