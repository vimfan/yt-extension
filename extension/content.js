// Content script: runs on www.youtube.com watch pages.
// Injects a "Save / play locally" button and extracts the direct stream URL
// from the page's own player state (trusted IP), so we can cache ad-free.

(function () {
  if (window.__ytLocalInjected) return;
  window.__ytLocalInjected = true;

  let currentVideoId = null;
  let button = null;
  let statusEl = null;
  let saveBtn = null;
  let isCached = false;

  function videoIdFromUrl() {
    const m = location.pathname.match(/^\/watch/) && new URLSearchParams(location.search).get("v");
    return m || null;
  }

  function metaFromCfg() {
    let vd = null;
    try {
      vd = window.ytInitialPlayerResponse?.videoDetails || null;
    } catch {}
    if (!vd) return {};
    return {
      title: vd.title || "",
      artist: (vd.author || "").replace(/- Topic$/i, "").trim(),
    };
  }

  // ---- button ----
  function ensureButton() {
    const below = document.querySelector("#below") || document.querySelector("#primary") ||
      document.querySelector("#player-container") || document.querySelector("#player");
    if (!below) return;
    if (button && button.isConnected) return;

    button = document.createElement("div");
    button.style.cssText =
      "margin:12px 0;padding:12px 16px;border-radius:12px;border:1px solid #333;" +
      "background:#222;color:#fff;display:flex;align-items:center;gap:10px;font-family:Roboto,Arial,sans-serif;max-width:760px;";
    button.innerHTML =
      '<span style="font-size:14px;font-weight:600;">YT Local</span>' +
      '<button id="ytl-action" style="padding:6px 14px;border:none;border-radius:8px;background:#0a7cff;color:#fff;font-size:13px;cursor:pointer;">Save locally</button>' +
      '<span id="ytl-status" style="font-size:12px;color:#aaa;flex:1;text-align:right;"></span>';
    below.prepend(button);
    statusEl = button.querySelector("#ytl-status");
    saveBtn = button.querySelector("#ytl-action");
    saveBtn.addEventListener("click", onAction);
  }

  function setMode(mode) {
    if (!saveBtn) return;
    if (mode === "save") {
      saveBtn.textContent = "Save locally";
      saveBtn.style.background = "#0a7cff";
      saveBtn.dataset.mode = "save";
    } else if (mode === "play") {
      saveBtn.textContent = "Play locally";
      saveBtn.style.background = "#3fb950";
      saveBtn.dataset.mode = "play";
    }
  }

  async function onAction() {
    if (!currentVideoId) return;
    const mode = saveBtn?.dataset?.mode || "save";
    if (mode === "play") {
      openLocalPlayer();
      return;
    }
    setMode("save");
    setStatus("working…");
    const meta = metaFromCfg();
    chrome.runtime.sendMessage({ type: "cacheVideo", videoId: currentVideoId, meta }, (resp) => {
      if (chrome.runtime.lastError) return setStatus("extension error");
      if (!resp || !resp.ok) {
        setStatus("failed: " + (resp?.reason || "unknown"));
        return;
      }
      if (resp.async) setStatus("downloading… (button will enable when ready)");
    });
  }

  function openLocalPlayer() {
    // Play the locally-cached file. The host serves it with range support.
    const url = `http://127.0.0.1:8717/video/${currentVideoId}`;
    // Try to use the page's own <video> element by swapping its source.
    const vids = document.querySelectorAll("video.html5-main-video");
    if (vids.length) {
      const v = vids[0];
      const ytPlayer = document.getElementById("movie_player");
      if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
      v.src = url;
      v.play().catch(() => setStatus("click play on the video"));
      setStatus("▶ playing local ad-free stream");
      return;
    }
    window.open(url, "_blank");
  }

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t;
  }

  // ---- progress / streamable updates from background ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg.videoId || msg.videoId !== currentVideoId) return;
    if (msg.type === "streamable") {
      isCached = true;
      setMode("play");
      setStatus("local stream ready");
    } else if (msg.type === "progress") {
      if (isCached) return;
      setStatus(msg.pct >= 0 ? `downloading… ${msg.pct}%` : "downloading…");
    } else if (msg.type === "done") {
      if (msg.ok) { isCached = true; setMode("play"); setStatus("✓ ready — play locally"); }
      else setStatus("✗ failed");
    }
  });

  // ---- observe URL / view changes ----
  async function sync() {
    const vid = videoIdFromUrl();
    currentVideoId = vid;
    isCached = false;
    if (!vid) return;
    ensureButton();
    setStatus("checking…");
    // Check if already cached locally
    chrome.runtime.sendMessage({ type: "checkVideo", videoId: vid }, (resp) => {
      if (chrome.runtime.lastError || !resp) return setStatus("");
      if (resp.streamable || resp.complete) {
        isCached = true;
        setMode("play");
        setStatus("local stream ready");
      } else {
        setMode("save");
        setStatus("");
      }
    });
  }
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(sync, 300);
  }).observe(document.body, { childList: true, subtree: true });
  sync();
})();
