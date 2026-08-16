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
    const player = document.getElementById("movie_player") || document.querySelector("#player-container");
    if (!player) return;
    if (localBtn && !localBtn.isConnected) localBtn = null;
    if (localBtn) return;
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
    const player = document.getElementById("movie_player") || document.querySelector("#player-container");
    if (!player) return;
    // If our badge isn't in the current player anymore (YouTube re-created it),
    // create a fresh one.
    if (localBadge && !localBadge.isConnected) localBadge = null;
    if (localBadge) return;
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

  // =====================================================================
  // Custom local player overlay (fully independent of the YouTube player)
  // =====================================================================
  let player = null;          // root overlay element
  let pvideo = null;          // <video>
  let pPlaying = false;

  function fmtTime(s) {
    s = Math.floor(s || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  function iconSvg(path) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="display:block">${path}</svg>`;
  }

  function buildPlayer(videoId) {
    const root = document.createElement("div");
    root.id = "ytl-player";
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.92);" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "font-family:Roboto,Arial,sans-serif;";

    const video = document.createElement("video");
    video.id = "ytl-player-video";
    video.controls = false;
    video.playsInline = true;
    video.style.cssText = "max-width:92vw;max-height:78vh;background:#000;border-radius:8px;";

    const vtt = `http://127.0.0.1:8717/subs/${videoId}`;
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "English";
    track.srclang = "en";
    track.src = vtt;
    track.default = true;
    video.appendChild(track);

    const title = document.createElement("div");
    title.textContent = "LOCAL · " + (metaFromCfg().title || videoId);
    title.style.cssText = "color:#fff;font-size:15px;font-weight:600;margin-bottom:12px;max-width:92vw;text-align:center;";

    // ---- controls ----
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:12px;background:rgba(255,255,255,.08);padding:8px 12px;border-radius:8px;";

    const mkBtn = (html, label, action) => {
      const b = document.createElement("button");
      b.innerHTML = html;
      b.title = label;
      b.style.cssText = "background:none;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:6px;display:flex;";
      b.addEventListener("click", action);
      return b;
    };

    const playBtn = mkBtn(iconSvg('<path d="M8 5v14l11-7z"/>'), "Play/Pause", () => togglePlay());
    const backBtn = mkBtn(iconSvg('<path d="M12 5V1L7 6l5 5V7c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/>'), "Back 10s", () => { video.currentTime = Math.max(0, video.currentTime - 10); });
    const fwdBtn = mkBtn(iconSvg('<path d="M12 5V1l5 5-5 5V7c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6h2c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8z"/>'), "Forward 10s", () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); });
    const ccBtn = mkBtn(iconSvg('<path d="M4 6h16v12H4z"/><rect x="9" y="10" width="2" height="4"/><rect x="13" y="10" width="2" height="4"/>'), "Subtitles", () => toggleCc());
    const fsBtn = mkBtn(iconSvg('<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>'), "Fullscreen", () => toggleFullscreen());

    const curEl = document.createElement("span");
    curEl.textContent = "0:00 / 0:00";
    curEl.style.cssText = "color:#ddd;font-size:12px;white-space:nowrap;min-width:92px;text-align:center;";

    const seek = document.createElement("input");
    seek.type = "range";
    seek.min = 0; seek.max = 1000; seek.value = 0;
    seek.style.cssText = "flex:1;min-width:120px;accent-color:#3fb950;";

    const closeBtn = mkBtn(iconSvg('<path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/>'), "Close", () => closePlayer());

    bar.append(backBtn, playBtn, fwdBtn, curEl, seek, ccBtn, fsBtn, closeBtn);
    root.append(title, video, bar);

    // wire seek bar
    let dragging = false;
    seek.addEventListener("input", () => { dragging = true; });
    seek.addEventListener("change", () => { dragging = false; });
    video.addEventListener("timeupdate", () => {
      if (!dragging && video.duration) seek.value = (video.currentTime / video.duration) * 1000;
      curEl.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    });
    seek.addEventListener("mouseup", () => {
      if (video.duration) video.currentTime = (seek.value / 1000) * video.duration;
      dragging = false;
    });
    seek.addEventListener("touchend", () => {
      if (video.duration) video.currentTime = (seek.value / 1000) * video.duration;
      dragging = false;
    });

    // keyboard: space = play, arrows = seek
    root.addEventListener("keydown", (e) => {
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (e.code === "ArrowLeft") video.currentTime = Math.max(0, video.currentTime - 5);
      else if (e.code === "ArrowRight") video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
      else if (e.code === "Escape") closePlayer();
    });

    // captions
    function toggleCc() {
      const show = track.track.mode === "hidden" || track.track.mode === "disabled";
      track.track.mode = show ? "showing" : "hidden";
      ccBtn.style.opacity = show ? "1" : ".4";
    }
    function togglePlay() {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }
    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else root.requestFullscreen().catch(() => {});
    }
    function closePlayer() {
      video.pause();
      if (document.fullscreenElement && document.fullscreenElement === root) {
        document.exitFullscreen().catch(() => {});
      }
      root.remove();
      player = null;
      pvideo = null;
    }

    video.addEventListener("play", () => { pPlaying = true; playBtn.style.opacity = "1"; });
    video.addEventListener("pause", () => { pPlaying = false; playBtn.style.opacity = ".6"; });
    // if subs 404, hide the cc button
    track.addEventListener("error", () => { ccBtn.style.display = "none"; });

    document.body.appendChild(root);
    video.focus();
    return { root, video, closePlayer };
  }

  function openLocalPlayer() {
    // Pause the YouTube player so two audio streams don't overlap.
    const ytPlayer = document.getElementById("movie_player");
    if (ytPlayer && ytPlayer.pauseVideo) { try { ytPlayer.pauseVideo(); } catch (e) {} }
    if (player) return; // already open
    const built = buildPlayer(currentVideoId);
    player = built.root;
    pvideo = built.video;
    pvideo.src = `http://127.0.0.1:8717/video/${currentVideoId}`;
    pvideo.load();
    // attempt autoplay (may be blocked by browser); user can press play
    pvideo.play().catch(() => {});
    playingLocal = true;
    setLocalBtn(true);
    setLocalBadge(true);
    setStatus("▶ playing in local player");
  }

  function setStatus(t) {
    try {
      if (statusEl && statusEl.isConnected) statusEl.textContent = t;
    } catch (e) {
      // ignore — status element may have been torn down by YouTube
    }
  }

  // ---- progress / streamable updates from background ----
  chrome.runtime.onMessage.addListener((msg) => {
    try {
      if (!msg || !msg.videoId || msg.videoId !== currentVideoId) return;
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
    } catch (e) {
      // Never let a stray message crash the page.
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
