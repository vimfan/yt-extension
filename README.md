# YT Local — ad-free local streaming for YouTube

A Chrome extension that caches YouTube videos to **local disk** (via a small local
host) and plays them back ad-free. No cloud server, no mikrus, no network
round-trip — everything stays on your machine.

## Why this exists
YouTube bot-blocks datacenter IPs, which is why cloud-server-based approaches
need a trusted-IP machine. But the browser runs on your (trusted) home IP and is
already logged into YouTube — so we can download the stream right on your disk.

## Architecture

```
[ YouTube watch page ]
   content.js injects a "Save locally / Play locally" button
        │  (chrome.runtime message)
        ▼
[ background.js (MV3 SW) ]
   asks the local host to download the video
        │  POST http://127.0.0.1:8717/api/download
        ▼
[ host/host.py (localhost HTTP server) ]
   runs yt-dlp  →  full muxed mp4 (video+audio) to ~/.yt-extension-cache
   enforces a 10GB LRU cache (auto-evicts oldest)
        │  serves the file back with range support
        ▼
[ content.js → swaps the page <video> to the local stream ]
```

## The three hard problems we solved
1. **No direct stream URL in page state** — modern YouTube omits `.url` in
   `ytInitialPlayerResponse`. So we don't try to read it; the host runs yt-dlp.
2. **yt-dlp JS challenge solving** — YouTube requires deciphering the `n` and
   signature parameters. Fixed with:
   - a **recent yt-dlp** (`~/.yt-extension/.venv` or the music-pwa venv)
   - `--remote-components ejs:github`
   - `--extractor-args "youtube:js-provider=deno"` (needs `deno` installed)
   - `--cookies-from-browser chrome` (uses your logged-in session)
3. **Disk space (your explicit constraint)** — hard **10GB cap**, LRU eviction:
   the least-recently-used cached video is deleted whenever the cache exceeds
   the cap. Runs at startup and after every download.

## Requirements
- macOS (tested) — Python 3, `deno`, yt-dlp (recent), ffmpeg (for merging)
- A Chrome browser logged into YouTube
- `yt-dlp` is auto-discovered from `~/projects/madajczyk_net/music-pwa/.venv/bin/yt-dlp`
  or `~/.yt-extension/.venv/bin/yt-dlp`, falling back to `yt-dlp` on PATH.

## Setup & usage
1. **Start the host** (keep it running while using the extension):
   ```bash
   ./host/start.sh
   # options (env vars): YT_EXT_PORT, YT_EXT_DIR, YT_EXT_MAX_GB (default 10), YT_EXT_COOKIES
   ```
   Verify: `curl http://127.0.0.1:8717/api/ping`

2. **Load the extension** in Chrome:
   - Go to `chrome://extensions`
   - Enable "Developer mode"
   - "Load unpacked" → select the `extension/` folder

3. **Use it**: open any YouTube watch page → a **YT Local** panel appears.
   - Click **Save locally** to download the current video to disk.
   - The button turns green **Play locally** once enough is cached — click it to
     switch the page player to the ad-free local stream.
   - Click the extension icon to see cached items, delete, or purge everything.

## Caching / disk policy
- Cache dir: `~/.yt-extension-cache` (override with `YT_EXT_DIR`).
- **Hard 10GB cap** (override with `YT_EXT_MAX_GB`): when exceeded, the oldest
  cached videos are auto-deleted (LRU).
- Cached files are complete muxed mp4s (video+audio, faststart) so the local
  player can start before the file finishes downloading (progressive).

## Tests
```bash
# requires the host running and a loaded extension in Chromium
python3 -m pytest tests/ -s
```
