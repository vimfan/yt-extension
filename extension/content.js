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

  // In-video [Local] button overlaid on the player's bottom-left corner.
  let localBtn = null;
  let playingLocal = false;

  function videoIdFromUrl() {
    const m = location.pathname.match(/^\/watch/) && new URLSearchParams(location.search).get("v");
    return m || null;
  }

  // ---- in-video [Local] overlay button ----
  function ensureLocalBtn() {
    if (localBtn && localBtn.isConnected) return;
    const player = document.getElementById("movie_player") || document.querySelector("#player-container");
    if (!player) return;
    localBtn = document.createElement("button");
    localBtn.id = "ytl-local";
    localBtn.textContent = "Local";
    localBtn.style.cssText =
      "position:absolute;left:12px;bottom:60px;z-index:1000;display:none;" +
      "padding:5px 12px;border:none;border-radius:6px;background:rgba(10,124,255,.9);" +
      "color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:Roboto,Arial,sans-serif;" +
      "box-shadow:0 1px 4px rgba(0,0,0,.5);";
    localBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isCached) openLocalPlayer();
      else startSave();
    });
    player.appendChild(localBtn);
  }

  function setLocalBtn(show) {
    if (!localBtn) return;
    localBtn.style.display = show ? "block" : "none";
    if (show) localBtn.textContent = playingLocal ? "▶ Local" : "Local";
  }

  // Persistent "LOCAL" badge so it's obvious the stream is local (not YouTube).
  let localBadge = null;
  function ensureLocalBadge() {
    if (localBadge && localBadge.isConnected) return;
    const player = document.getElementById("movie_player") || document.querySelector("#player-container");
    if (!player) return;
    localBadge = document.createElement("div");
    localBadge.id = "ytl-badge";
    localBadge.textContent = "LOCAL";
    localBadge.style.cssText =
      "position:absolute;top:10px;left:12px;z-index:1001;display:none;" +
      "padding:4px 10px;border-radius:5px;background:rgba(63,185,80,.92);color:#fff;" +
      "font-size:11px;font-weight:800;letter-spacing:.5px;font-family:Roboto,Arial,sans-serif;";
    player.appendChild(localBadge);
  }

  function setLocalBadge(show) {
    ensureLocalBadge();
    if (localBadge) localBadge.style.display = show ? "block" : "none";
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

  function startSave() {
    if (!currentVideoId) return;
    setMode("save");
    setStatus("downloading…");
    const meta = metaFromCfg();
    chrome.runtime.sendMessage({ type: "cacheVideo", videoId: currentVideoId, meta }, (resp) => {
      if (chrome.runtime.lastError) return setStatus("extension error");
      if (!resp || !resp.ok) {
        setStatus("failed: " + (resp?.reason || "unknown"));
        return;
      }
      if (resp.async) setStatus("downloading… ([Local] will appear when ready)");
    });
  }

  async function onAction() {
    if (!currentVideoId) return;
    const mode = saveBtn?.dataset?.mode || "save";
    if (mode === "play") {
      openLocalPlayer();
      return;
    }
    startSave();
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
      playingLocal = true;
      setLocalBtn(true);          // shows "▶ Local"
      setLocalBadge(true);        // shows green LOCAL badge
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
      setLocalBtn(true);
      setStatus("local stream ready");
    } else if (msg.type === "progress") {
      if (isCached) return;
      setStatus(msg.pct >= 0 ? `downloading… ${msg.pct}%` : "downloading…");
    } else if (msg.type === "done") {
      if (msg.ok) { isCached = true; setMode("play"); setLocalBtn(true); setStatus("✓ ready — play locally"); }
      else setStatus("✗ failed");
    }
  });

  // ---- observe URL / view changes ----
  async function sync() {
    const vid = videoIdFromUrl();
    if (vid !== currentVideoId) {
      playingLocal = false;
      setLocalBadge(false);
    }
    currentVideoId = vid;
    isCached = false;
    if (!vid) return;
    ensureButton();
    ensureLocalBtn();
    setStatus("checking…");
    // Check if already cached locally
    chrome.runtime.sendMessage({ type: "checkVideo", videoId: vid }, (resp) => {
      if (chrome.runtime.lastError || !resp) return setStatus("");
      if (resp.streamable || resp.complete) {
        isCached = true;
        setMode("play");
        setLocalBtn(true);
        setStatus("local stream ready");
      } else {
        setMode("save");
        setLocalBtn(false);
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
