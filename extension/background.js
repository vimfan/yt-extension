// Background service worker: orchestrates local caching.
//
// Strategy (host-primary with browser-first attempt):
//   1. Host yt-dlp (primary): ask the local host to download the video with
//      yt-dlp using the logged-in Chrome session's cookies (--cookies-from-browser
//      chrome) + JS challenge solving. Reliable, gives a full muxed file.
//   2. Browser-first (best effort): try the bundled innertube client to resolve
//      and stream directly; fall back to host download if it fails.

import { resolveStreams } from "./player-core.js";

const HOST = "http://127.0.0.1:8717";
const STREAMABLE_MIN = 3 * 1024 * 1024; // bytes cached before "play locally" enables

const active = new Map(); // video_id -> {port, total, lastPct, streamableNotified}

async function hostReady() {
  try {
    const r = await fetch(`${HOST}/api/ping`);
    return r.ok;
  } catch {
    return false;
  }
}

// ---- browser-first: resolve stream URL, stream bytes to host ----
async function browserFirst(videoId, meta) {
  let stream;
  try {
    stream = await resolveStreams(videoId);
  } catch (e) {
    return { ok: false, reason: `resolve: ${e.message}` };
  }
  if (!stream || !stream.url) {
    return { ok: false, reason: "no resolvable stream" };
  }
  const ctrl = new AbortController();
  let resp;
  try {
    resp = await fetch(stream.url, { credentials: "include", signal: ctrl.signal });
  } catch (e) {
    return { ok: false, reason: `fetch: ${e.message}` };
  }
  if (!resp.ok || !resp.body) {
    return { ok: false, reason: `stream http ${resp.status}` };
  }
  const total = stream.contentLength || Number(resp.headers.get("Content-Length") || 0);

  const start = await fetch(`${HOST}/api/write/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId, title: stream.title, artist: stream.artist }),
  });
  if (!start.ok) return { ok: false, reason: "host write/start failed" };

  const reader = resp.body.getReader();
  let got = 0;
  let buf = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    const merged = new Uint8Array(buf.length + value.length);
    merged.set(buf);
    merged.set(value, buf.length);
    buf = merged;
    while (buf.length >= 2 * 1024 * 1024) {
      const piece = buf.slice(0, 2 * 1024 * 1024);
      buf = buf.slice(2 * 1024 * 1024);
      const ok = await postChunk(videoId, piece);
      if (!ok) {
        ctrl.abort();
        return { ok: false, reason: "host write/chunk failed" };
      }
    }
    maybeStreamable(videoId, got);
    report(videoId, total, got);
  }
  if (buf.length) {
    const ok = await postChunk(videoId, buf);
    if (!ok) return { ok: false, reason: "host write/chunk failed" };
  }
  const end = await fetch(`${HOST}/api/write/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId }),
  });
  const endOk = end.ok;
  finish(videoId, endOk);
  return { ok: endOk, source: "browser" };
}

async function postChunk(videoId, bytes) {
  try {
    const r = await fetch(`${HOST}/api/write/chunk`, {
      method: "POST",
      headers: { "X-Video-Id": videoId, "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ---- primary: host runs yt-dlp ----
async function hostDownload(videoId, meta) {
  try {
    const r = await fetch(`${HOST}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId, ...meta }),
    });
    if (r.status === 202) {
      pollHost(videoId);
      return { ok: true, source: "host", async: true };
    }
    return { ok: false, reason: `host download http ${r.status}` };
  } catch (e) {
    return { ok: false, reason: `host download: ${e.message}` };
  }
}

function pollHost(videoId) {
  let tries = 0;
  const iv = setInterval(async () => {
    tries++;
    try {
      const r = await fetch(`${HOST}/api/status/${videoId}`);
      if (r.ok) {
        const st = await r.json();
        if (st.cached) {
          report(videoId, st.size, st.size);
          maybeStreamable(videoId, st.size);
          if (st.complete) {
            clearInterval(iv);
            finish(videoId, true);
            return;
          }
        }
      }
    } catch {}
    if (tries > 900) { // ~30 min
      clearInterval(iv);
      finish(videoId, false);
    }
  }, 2000);
}

// ---- progress / streamable reporting ----
function maybeStreamable(videoId, got) {
  const rec = active.get(videoId) || {};
  if (got >= STREAMABLE_MIN && !rec.streamableNotified) {
    rec.streamableNotified = true;
    active.set(videoId, rec);
    notify(videoId, { type: "streamable" });
  }
}

function report(videoId, total, got) {
  const pct = total > 0 ? Math.min(100, Math.round((got / total) * 100)) : -1;
  const rec = active.get(videoId) || {};
  rec.lastPct = pct;
  rec.got = got;
  rec.total = total;
  active.set(videoId, rec);
  notify(videoId, { type: "progress", pct });
}

function finish(videoId, ok) {
  notify(videoId, { type: "done", ok });
  active.delete(videoId);
}

function notify(videoId, payload) {
  chrome.runtime.sendMessage({ videoId, ...payload }).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { videoId, ...payload }).catch(() => {});
    }
  });
}

// ---- message handling ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "pingHost") {
    hostReady().then(sendResponse);
    return true;
  }
  if (msg.type === "cacheVideo") {
    (async () => {
      const ready = await hostReady();
      if (!ready) {
        sendResponse({ ok: false, reason: "Local host not running. Start it with: ./host/start.sh" });
        return;
      }
      active.set(msg.videoId, {});
      // Primary: host yt-dlp (reliable). Browser-first is optional/experimental.
      const res = await hostDownload(msg.videoId, msg.meta || {});
      if (!res.ok) {
        // last resort: browser-first via innertube
        const bf = await browserFirst(msg.videoId, msg.meta || {});
        if (!bf.ok) {
          active.delete(msg.videoId);
          sendResponse({ ok: false, reason: res.reason || bf.reason || "failed" });
          return;
        }
        sendResponse({ ok: true, source: "browser", async: false });
        return;
      }
      sendResponse({ ok: true, source: "host", async: true });
    })();
    return true;
  }
  if (msg.type === "checkVideo") {
    fetch(`${HOST}/api/status/${msg.videoId}`)
      .then((r) => r.json())
      .then((st) => sendResponse({
        cached: !!st.cached,
        complete: !!st.complete,
        streamable: !!(st.cached && st.size >= STREAMABLE_MIN),
        size: st.size || 0,
      }))
      .catch(() => sendResponse({ cached: false, streamable: false, complete: false, size: 0 }));
    return true;
  }
  if (msg.type === "list") {
    fetch(`${HOST}/api/list`).then((r) => r.json()).then(sendResponse).catch(() => sendResponse({ items: [] }));
    return true;
  }
  if (msg.type === "deleteVideo") {
    fetch(`${HOST}/api/video/${msg.videoId}`, { method: "DELETE" })
      .then((r) => r.json()).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "purge") {
    fetch(`${HOST}/api/list`)
      .then((r) => r.json())
      .then(async (l) => {
        const ids = (l.items || []).map((i) => i.video_id);
        for (const id of ids) {
          await fetch(`${HOST}/api/video/${id}`, { method: "DELETE" });
        }
        sendResponse({ ok: true, deleted: ids.length });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
