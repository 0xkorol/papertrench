/* PaperTrench — offscreen recorder.
 *
 * MV3 forbids getDisplayMedia in service workers, so recording lives here.
 * Chrome shows its "choose what to share" picker the first time this page
 * calls getDisplayMedia in a session; we keep the MediaStream alive between
 * round trips so the picker only appears once per browser session (or until
 * the user disables recording).
 *
 * When a round trip closes, the MediaRecorder is stopped, the .webm is saved
 * via a programmatic anchor download, and a fresh recorder is armed for the
 * next trade without re-requesting the stream.
 */

'use strict';

let stream = null;
let recorder = null;
let chunks = [];
let currentSymbol = null;
let startedAt = 0;   // wall-clock start, so a replay can seek into the video

async function ensureStream() {
  if (stream && stream.getTracks().some((t) => t.readyState === 'live')) return stream;
  const s = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 15 },
    audio: false,
  });
  // If the user cancels screen sharing from Chrome's UI, treat as stop.
  s.getVideoTracks()[0].addEventListener('ended', () => {
    stream = null;
    if (recorder && recorder.state !== 'inactive') finishRecording(null);
  });
  stream = s;
  return stream;
}

async function begin(symbol) {
  currentSymbol = symbol || 'token';
  try {
    const s = await ensureStream();
    if (recorder && recorder.state !== 'inactive') return { active: true };
    chunks = [];
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    recorder = new MediaRecorder(s, { mimeType: mime, videoBitsPerSecond: 1_500_000 });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.start(1000);
    startedAt = Date.now();
    return { active: true };
  } catch (e) {
    return { active: false, error: e.message };
  }
}

/**
 * Stop recording and keep the video somewhere the dashboard can actually play
 * it. Previously only the download filename was returned, so the replay view
 * had nothing to show and fell back to still frames even when a recording
 * existed. The blob is now persisted to IndexedDB, keyed by round id.
 */
function finishRecording(roundId) {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') return resolve(null);
    const sym = currentSymbol || 'token';
    const began = startedAt;
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' });
      chunks = [];
      const file = `papertrench-${sanitize(sym)}-${timestamp()}.webm`;
      if (!blob.size) { resolve(null); return; }

      let stored = false;
      if (roundId && self.PTRecordings) {
        try {
          await self.PTRecordings.put({
            id: roundId,
            symbol: sym,
            file,
            blob,
            startedAt: began,
            endedAt: Date.now(),
          });
          stored = true;
        } catch (e) {
          console.warn('PaperTrench: could not store recording:', e && e.message);
        }
      }
      // Still save a copy to disk so the user keeps the raw file.
      downloadBlob(blob, file);
      resolve({ file, stored, size: blob.size, startedAt: began, endedAt: Date.now() });
    };
    recorder.stop();
  });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function sanitize(s) {
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 32);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'recorder.begin') {
    begin(msg.symbol).then(sendResponse);
    return true;
  }
  if (msg.type === 'recorder.stop') {
    finishRecording(msg.roundId).then((result) => {
      if (!result) { sendResponse({ file: null }); return; }
      sendResponse(result);
    });
    return true;
  }
  if (msg.type === 'recorder.status') {
    sendResponse({ active: !!(recorder && recorder.state !== 'inactive'), hasStream: !!stream });
    return true;
  }
});
