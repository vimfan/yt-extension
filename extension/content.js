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
    // Sit exactly where the YouTube player is: absolute within the same
    // container, sized to match, covering the normal player.
    root.style.cssText =
      "position:absolute;inset:0;z-index:2147483000;background:#000;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
      "font-family:Roboto,Arial,sans-serif;";

    const video = document.createElement("video");
    video.id = "ytl-player-video";
    video.controls = false;
    video.playsInline = true;
    video.style.cssText = "width:100%;height:100%;object-fit:contain;background:#000;";

    // Captions overlay (rendered manually from the VTT so we fully control
    // visibility + on/off).
    const cap = document.createElement("div");
    cap.id = "ytl-captions";
    cap.style.cssText =
      "position:absolute;left:10%;right:10%;bottom:56px;z-index:12;display:none;" +
      "text-align:center;color:#fff;font-family:Roboto,Arial,sans-serif;" +
      "font-size:clamp(14px,2.4vw,28px);font-weight:500;line-height:1.3;" +
      "text-shadow:0 2px 4px rgba(0,0,0,.9),0 0 6px rgba(0,0,0,.8);pointer-events:none;";
    const cues = []; // {start, end, text}
    let subsReady = false;
    let ccOn = false;
    (async () => {
      try {
        const r = await fetch(`http://127.0.0.1:8717/subs/${videoId}`);
        if (!r.ok) throw new Error("no subs");
        const text = await r.text();
        parseVtt(text, cues);
        subsReady = true;
        ccBtn.style.display = "";
      } catch (e) {
        ccBtn.style.display = "none";
      }
    })();
    function parseVtt(vtt, out) {
      const lines = vtt.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
        if (!m) continue;
        const s = +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000;
        const e = +m[5]*3600 + +m[6]*60 + +m[7] + +m[8]/1000;
        // next non-empty line is the cue text (may span until blank line)
        let text = "";
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === "") break;
          text += (text ? " " : "") + lines[j];
        }
        out.push({ start: s, end: e, text: cleanVtt(text) });
        i = i + 1;
      }
    }
    function cleanVtt(t) {
      // strip YouTube timestamp markers and <c> tags + numbered prefix
      return t
        .replace(/<00:\d{2}:\d{2}\.\d{3}>/g, "")
        .replace(/<\/?c[^>]*>/g, "")
        .replace(/^\s*\d+\.\s*/, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .trim();
    }
    video.addEventListener("timeupdate", () => {
      if (!ccOn || !cues.length) return;
      const t = video.currentTime;
      let found = "";
      for (let k = 0; k < cues.length; k++) {
        if (t >= cues[k].start && t < cues[k].end) { found = cues[k].text; break; }
      }
      cap.textContent = found;
    });

    const vtt = `http://127.0.0.1:8717/subs/${videoId}`;
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "English";
    track.srclang = "en";
    track.src = vtt;
    video.appendChild(track);
    void track; // native track is a fallback; we render manually above

    // Top bar: always-present "Back to YouTube" so the user can always go back.
    const topbar = document.createElement("div");
    topbar.style.cssText =
      "position:absolute;top:0;left:0;right:0;z-index:10;" +
      "display:flex;align-items:center;gap:8px;padding:8px 10px;" +
      "background:linear-gradient(rgba(0,0,0,.7),rgba(0,0,0,0));color:#fff;";
    const backBtn2 = document.createElement("button");
    backBtn2.textContent = "← Back to YouTube";
    backBtn2.style.cssText =
      "background:rgba(255,255,255,.15);border:none;color:#fff;padding:6px 12px;" +
      "border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;";
    backBtn2.addEventListener("click", () => closePlayer(true));
    const title = document.createElement("div");
    title.textContent = "LOCAL · " + (metaFromCfg().title || videoId);
    title.style.cssText = "color:#fff;font-size:13px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;";
    topbar.append(backBtn2, title);
    root.appendChild(topbar);

    // ---- controls (overlaid at the bottom) ----
    const bar = document.createElement("div");
    bar.style.cssText =
      "position:absolute;bottom:0;left:0;right:0;z-index:10;" +
      "display:flex;align-items:center;gap:8px;padding:8px 12px;" +
      "background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.75));";

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

    bar.append(backBtn, playBtn, fwdBtn, curEl, seek, ccBtn, fsBtn);

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
      else if (e.code === "Escape") closePlayer(true);
    });

    // captions (manual overlay toggle)
    function toggleCc() {
      ccOn = !ccOn;
      cap.style.display = ccOn ? "block" : "none";
      ccBtn.style.opacity = ccOn ? "1" : ".4";
    }
    function togglePlay() {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }
    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else root.requestFullscreen().catch(() => {});
    }
    function closePlayer(goBack) {
      video.pause();
      if (document.fullscreenElement && document.fullscreenElement === root) {
        document.exitFullscreen().catch(() => {});
      }
      root.remove();
      player = null;
      pvideo = null;
      playingLocal = false;
      setLocalBadge(false);
      setLocalBtn(true); // re-enable the [Local] button (shows "Local" again)
      // Restore the YouTube player (unmute + resume if going back).
      restoreYouTubePlayer(goBack);
    }

    video.addEventListener("play", () => { pPlaying = true; playBtn.style.opacity = "1"; });
    video.addEventListener("pause", () => { pPlaying = false; playBtn.style.opacity = ".6"; });

    root.append(video, bar, cap);
    document.body.appendChild(root);
    video.focus();
    return { root, video, closePlayer };
  }

  // Pause + mute the YouTube player reliably (both the API and the real
  // <video> element, since pauseVideo() alone may not stop the audio).
  function stopYouTubePlayer() {
    const mp = document.getElementById("movie_player");
    if (mp && mp.pauseVideo) { try { mp.pauseVideo(); } catch (e) {} }
    const v = document.querySelector("video.html5-main-video");
    if (v) {
      try {
        window.__ytlPrevMuted = v.muted;
        window.__ytlPrevVolume = v.volume;
        v.pause();
        v.muted = true;
        v.volume = 0;
      } catch (e) {}
    }
  }

  function restoreYouTubePlayer(resume) {
    const v = document.querySelector("video.html5-main-video");
    if (v) {
      try {
        if (typeof window.__ytlPrevMuted === "boolean") v.muted = window.__ytlPrevMuted;
        if (typeof window.__ytlPrevVolume === "number") v.volume = window.__ytlPrevVolume;
      } catch (e) {}
    }
    const mp = document.getElementById("movie_player");
    if (mp) { try { mp.style.opacity = ""; } catch (e) {} }
    if (resume && mp && mp.playVideo) {
      try { mp.playVideo(); } catch (e) {}
    }
  }

  function openLocalPlayer() {
    if (player) return; // already open
    const ytPlayer = document.getElementById("movie_player");
    // Stop the YouTube player so its audio doesn't keep playing under local.
    stopYouTubePlayer();
    // Mount into the same container as the normal player so it appears in the
    // same place. #movie_player (or its parent) is the positioned anchor.
    let anchor = ytPlayer && ytPlayer.parentElement ? ytPlayer.parentElement : document.querySelector("#player-container");
    if (!anchor) anchor = document.body;
    const built = buildPlayer(currentVideoId);
    // Hide the YouTube player surface so only our local video shows in that spot.
    if (ytPlayer) { try { ytPlayer.style.opacity = "0"; } catch (e) {} }
    anchor.appendChild(built.root);
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

  // =====================================================================
  // Player chooser: ask which player to use when a video is available locally
  // =====================================================================
  let chooser = null;
  let playerChoice = "ask"; // ask | youtube | local

  function getSettings() {
    return new Promise((r) => {
      chrome.storage.sync.get({ playerChoice: "ask" }, (s) => r(s.playerChoice || "ask"));
    });
  }

  function ensureChooser() {
    try {
      const player = document.getElementById("movie_player") || document.querySelector("#player-container");
      if (!player) return null;
      // If the chooser exists but was detached by YouTube re-creating the
      // player, drop it so we build a fresh one.
      if (chooser && !chooser.isConnected) chooser = null;
      if (chooser) return chooser;
      chooser = document.createElement("div");
      chooser.id = "ytl-chooser";
      chooser.style.cssText =
        "position:absolute;left:12px;bottom:110px;z-index:2000;display:none;" +
        "background:rgba(15,15,15,.95);border:1px solid #444;border-radius:10px;padding:10px 12px;" +
        "color:#fff;font-family:Roboto,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.6);";
      chooser.innerHTML =
        '<div style="font-size:12px;color:#aaa;margin-bottom:8px;">Available locally — which player?</div>' +
        '<div style="display:flex;gap:8px;">' +
        '<button id="ytl-choice-youtube" style="padding:7px 14px;border:none;border-radius:7px;background:#333;color:#fff;font-size:13px;cursor:pointer;">YouTube</button>' +
        '<button id="ytl-choice-local" style="padding:7px 14px;border:none;border-radius:7px;background:#3fb950;color:#fff;font-size:13px;cursor:pointer;">Local</button>' +
        "</div>";
      player.appendChild(chooser);
      chooser.querySelector("#ytl-choice-youtube").addEventListener("click", () => {
        hideChooser();
        // just resume normal YouTube playback
      });
      chooser.querySelector("#ytl-choice-local").addEventListener("click", () => {
        hideChooser();
        openLocalPlayer();
      });
      return chooser;
    } catch (e) {
      chooser = null;
      return null;
    }
  }

  function showChooser() {
    try {
      const c = ensureChooser();
      if (c) c.style.display = "block";
    } catch (e) {
      // never crash the page if the chooser can't be built
    }
  }

  function hideChooser() {
    if (chooser) chooser.style.display = "none";
  }

  function setStatus(t) {
    try {
      if (statusEl && statusEl.isConnected) statusEl.textContent = t;    } catch (e) {
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
  let choicePromise = null;
  function ensureChoice() {
    if (!choicePromise) {
      choicePromise = getSettings().then((c) => { playerChoice = c || "ask"; });
    }
    return choicePromise;
  }

  async function sync() {
    const vid = videoIdFromUrl();
    if (vid !== currentVideoId) {
      playingLocal = false;
      setLocalBadge(false);
      hideChooser();
    }
    currentVideoId = vid;
    isCached = false;
    if (!vid) return;
    ensureButton();
    ensureLocalBtn();
    setStatus("checking…");
    await ensureChoice();
    // Check if already cached locally
    chrome.runtime.sendMessage({ type: "checkVideo", videoId: vid }, (resp) => {
      if (chrome.runtime.lastError || !resp) return setStatus("");
      if (resp.streamable || resp.complete) {
        isCached = true;
        setMode("play");
        setLocalBtn(true);
        if (playerChoice === "local") {
          setStatus("local stream ready");
          openLocalPlayer();
        } else if (playerChoice === "ask") {
          setStatus("local stream ready");
          showChooser();
        } else {
          setStatus("local stream ready (click Local to use it)");
        }
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
