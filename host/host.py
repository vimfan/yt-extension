#!/usr/bin/env python3
"""Local host for the YT ad-free extension.

Runs on localhost (trusted home IP), so yt-dlp is NOT bot-blocked here.
The extension can either:
  1. "browser-first": fetch the direct stream URL in the page, then stream the
     bytes to this host to write to disk (POST /api/write/*), or
  2. "native fallback": ask this host to run yt-dlp itself (POST /api/download).

It also serves cached files back for playback and enforces a hard cache cap
(10GB by default) with LRU eviction.

Run:  python3 host.py [--port 8717] [--dir ~/.yt-extension-cache] [--max-gb 10]
"""

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# yt-dlp resolution (try the python module first so it works in a venv)
# ---------------------------------------------------------------------------
# Prefer a recent yt-dlp that can solve YouTube JS challenges (n/signature).
# The music-pwa venv ships a current one. Use it if present.
def _ytdlp_cmd():
    candidates = [
        os.path.expanduser("~/projects/madajczyk_net/music-pwa/.venv/bin/yt-dlp"),
        os.path.expanduser("~/.yt-extension/.venv/bin/yt-dlp"),
    ]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return [c]
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        return ["yt-dlp"]


# Extra args needed so yt-dlp can solve YouTube's JS challenges with a local
# JS runtime (deno). Without these, only low-res/thumbnail formats resolve.
def _ytdlp_extra():
    return [
        "--remote-components", "ejs:github",
        "--extractor-args", "youtube:js-provider=deno",
    ]


UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def log(msg):
    print(f"[host] {msg}", flush=True)


# ---------------------------------------------------------------------------
# DB / cache manager
# ---------------------------------------------------------------------------
class Cache:
    def __init__(self, directory, max_bytes, cookies_browser=None):
        self.dir = directory
        self.max_bytes = max_bytes
        self.cookies_browser = cookies_browser
        os.makedirs(directory, exist_ok=True)
        self.db_path = os.path.join(directory, "cache.db")
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS media (
                video_id TEXT PRIMARY KEY,
                filename TEXT,
                title TEXT,
                artist TEXT,
                size INTEGER DEFAULT 0,
                complete INTEGER DEFAULT 0,
                source TEXT DEFAULT 'host',
                created_at REAL,
                last_used REAL
            )"""
        )
        self.conn.commit()
        self.lock = threading.RLock()

    def path_for(self, video_id):
        return os.path.join(self.dir, f"{video_id}.mp4")

    def file_info(self, video_id):
        with self.lock:
            row = self.conn.execute(
                "SELECT * FROM media WHERE video_id = ?", (video_id,)
            ).fetchone()
        if row:
            d = dict(row)
            d["size"] = os.path.getsize(self.path_for(video_id)) if os.path.isfile(self.path_for(video_id)) else d.get("size", 0)
            return d
        return None

    def list_media(self):
        with self.lock:
            rows = self.conn.execute("SELECT * FROM media ORDER BY last_used DESC").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            p = self.path_for(d["video_id"])
            if os.path.isfile(p):
                d["size"] = os.path.getsize(p)
                out.append(d)
        return out

    def upsert(self, video_id, title="", artist="", filename=None, source="host", complete=0):
        now = time.time()
        with self.lock:
            self.conn.execute(
                """INSERT INTO media (video_id, filename, title, artist, size, complete, source, created_at, last_used)
                   VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
                   ON CONFLICT(video_id) DO UPDATE SET
                     filename=excluded.filename, title=excluded.title, artist=excluded.artist,
                     complete=excluded.complete, source=excluded.source, last_used=excluded.last_used
                """,
                (video_id, filename or f"{video_id}.mp4", title, artist, complete, source, now, now),
            )
            self.conn.commit()

    def touch(self, video_id):
        with self.lock:
            self.conn.execute("UPDATE media SET last_used = ? WHERE video_id = ?", (time.time(), video_id))
            self.conn.commit()

    def mark_complete(self, video_id):
        with self.lock:
            self.conn.execute(
                "UPDATE media SET complete = 1, last_used = ? WHERE video_id = ?", (time.time(), video_id)
            )
            self.conn.commit()

    def remove(self, video_id):
        p = self.path_for(video_id)
        try:
            os.remove(p)
        except OSError:
            pass
        with self.lock:
            self.conn.execute("DELETE FROM media WHERE video_id = ?", (video_id,))
            self.conn.commit()

    def total_bytes(self):
        n = 0
        for d in self.list_media():
            n += d.get("size", 0)
        return n

    def enforce_cap(self):
        """LRU-evict until under max_bytes. Removes least-recently-used first."""
        items = self.list_media()  # already ordered by last_used DESC
        # evict oldest (last in the DESC list)
        with self.lock:
            while self.total_bytes() > self.max_bytes and items:
                victim = items[-1]  # least recently used
                if victim["complete"] == 0 and victim.get("size", 0) == 0:
                    # skip in-progress empties from eviction
                    break
                items.pop()
                self._remove_locked(victim["video_id"])
                log(f"LRU evict {victim['video_id']} ({victim.get('size',0)} bytes) -> total now {self.total_bytes()}")
            self.conn.commit()

    def _remove_locked(self, video_id):
        p = self.path_for(video_id)
        try:
            os.remove(p)
        except OSError:
            pass
        self.conn.execute("DELETE FROM media WHERE video_id = ?", (video_id,))
        self.conn.commit()


# ---------------------------------------------------------------------------
# yt-dlp download (native fallback)
# ---------------------------------------------------------------------------
def download_video(video_id, cache, max_height="720", cookies_browser=None):
    """Download video+audio to the cache dir via yt-dlp. Returns final path."""
    tmpdir = tempfile.mkdtemp(prefix="ytdl-")
    try:
        tmpl = os.path.join(tmpdir, f"{video_id}.%(ext)s")
        cmd = _ytdlp_cmd() + [
            "--no-warnings",
            "-f", f"bestvideo[height<={max_height}]+bestaudio/best[height<={max_height}]",
            "--merge-output-format", "mp4",
            "--postprocessor-args", "Merger:-movflags +faststart",
            "-o", tmpl,
            "--socket-timeout", "30", "--user-agent", UA,
        ] + _ytdlp_extra()
        if cookies_browser:
            cmd += ["--cookies-from-browser", cookies_browser]
        cmd += [f"https://www.youtube.com/watch?v={video_id}"]
        log(f"downloading {video_id} (<=p{max_height})" + (f" cookies={cookies_browser}" if cookies_browser else ""))
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if proc.returncode != 0:
            log(f"  yt-dlp failed: {proc.stderr[-500:]}")
            return None
        files = [os.path.join(tmpdir, f) for f in os.listdir(tmpdir)
                 if os.path.isfile(os.path.join(tmpdir, f))]
        if not files:
            log("  no file produced")
            return None
        src = max(files, key=os.path.getsize)
        if os.path.getsize(src) < 100000:
            log("  file too small")
            return None
        dest = cache.path_for(video_id)
        shutil.move(src, dest)
        log(f"  downloaded {video_id} -> {dest}")
        return dest
    except Exception as e:
        log(f"  download error: {e}")
        return None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    cache = None

    # ---- helpers ----
    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode())

    def do_OPTIONS(self):
        self._send(200)

    def log_message(self, *a):
        pass

    # ---- routing ----
    def do_GET(self):
        cache = self.cache
        if self.path == "/api/ping":
            return self._json(200, {"ok": True, "dir": cache.dir, "max_bytes": cache.max_bytes})
        if self.path == "/api/list":
            items = cache.list_media()
            return self._json(200, {"items": items, "total_bytes": cache.total_bytes(),
                                    "max_bytes": cache.max_bytes})
        if self.path.startswith("/api/status/"):
            vid = self.path.split("/")[-1]
            info = cache.file_info(vid)
            if not info:
                return self._json(404, {"error": "not found"})
            p = cache.path_for(vid)
            size = os.path.getsize(p) if os.path.isfile(p) else 0
            return self._json(200, {"video_id": vid, "size": size, "complete": info["complete"],
                                    "cached": os.path.isfile(p)})
        if self.path.startswith("/video/"):
            vid = self.path.split("/")[-1]
            p = cache.path_for(vid)
            if not os.path.isfile(p):
                return self._send(404, b"not found", "text/plain")
            cache.touch(vid)
            return self._serve_file(p)
        return self._json(404, {"error": "unknown route"})

    def do_POST(self):
        cache = self.cache
        if self.path == "/api/download":
            return self._handle_download()
        if self.path == "/api/write/start":
            return self._handle_write_start()
        if self.path == "/api/write/chunk":
            return self._handle_write_chunk()
        if self.path == "/api/write/end":
            return self._handle_write_end()
        return self._json(404, {"error": "unknown route"})

    def do_DELETE(self):
        cache = self.cache
        if self.path.startswith("/api/video/"):
            vid = self.path.split("/")[-1]
            cache.remove(vid)
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "unknown route"})

    # ---- endpoints ----
    def _read_body(self, maxlen=0):
        length = int(self.headers.get("Content-Length", 0))
        if maxlen and length > maxlen:
            return None, length
        return self.rfile.read(length), length

    def _handle_download(self):
        body, _ = self._read_body(1_000_000)
        try:
            data = json.loads(body or b"{}")
        except Exception:
            data = {}
        vid = data.get("video_id", "")
        if not vid:
            return self._json(400, {"error": "video_id required"})
        max_height = data.get("quality", "720")
        cache = self.cache
        cache.upsert(vid, data.get("title", ""), data.get("artist", ""), source="host")
        # run download in background thread so HTTP returns immediately with progress
        def work():
            path = download_video(vid, cache, max_height, cache.cookies_browser)
            if path:
                cache.mark_complete(vid)
            cache.enforce_cap()
        threading.Thread(target=work, daemon=True).start()
        return self._json(202, {"ok": True, "video_id": vid, "source": "host"})

    def _handle_write_start(self):
        body, _ = self._read_body(1_000_000)
        try:
            data = json.loads(body or b"{}")
        except Exception:
            data = {}
        vid = data.get("video_id", "")
        if not vid:
            return self._json(400, {"error": "video_id required"})
        cache = self.cache
        # wipe any existing partial
        p = cache.path_for(vid)
        if os.path.isfile(p):
            os.remove(p)
        cache.upsert(vid, data.get("title", ""), data.get("artist", ""), source="browser")
        return self._json(200, {"ok": True, "video_id": vid})

    def _handle_write_chunk(self):
        vid = self.headers.get("X-Video-Id", "")
        if not vid:
            return self._json(400, {"error": "X-Video-Id header required"})
        cache = self.cache
        p = cache.path_for(vid)
        chunk, _ = self._read_body()
        if chunk is None:
            return self._json(400, {"error": "no body"})
        with open(p, "ab") as f:
            f.write(chunk)
        return self._json(200, {"ok": True, "video_id": vid})

    def _handle_write_end(self):
        body, _ = self._read_body(1_000_000)
        try:
            data = json.loads(body or b"{}")
        except Exception:
            data = {}
        vid = data.get("video_id", "")
        if not vid:
            return self._json(400, {"error": "video_id required"})
        cache = self.cache
        p = cache.path_for(vid)
        if not os.path.isfile(p):
            return self._json(404, {"error": "no file"})
        cache.mark_complete(vid)
        cache.enforce_cap()
        return self._json(200, {"ok": True, "video_id": vid, "size": os.path.getsize(p)})

    def _serve_file(self, path):
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and rng.startswith("bytes="):
            part = rng[6:].split("-")
            start = int(part[0]) if part[0] else 0
            if part[1]:
                end = int(part[1])
            end = min(end, size - 1)
        length = end - start + 1
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("YT_EXT_PORT", "8717")))
    ap.add_argument("--dir", default=os.environ.get("YT_EXT_DIR",
                    os.path.expanduser("~/.yt-extension-cache")))
    ap.add_argument("--max-gb", type=float, default=float(os.environ.get("YT_EXT_MAX_GB", "10")))
    ap.add_argument("--cookies-browser", default=os.environ.get("YT_EXT_COOKIES", "chrome"))
    args = ap.parse_args()
    cache = Cache(args.dir, int(args.max_gb * 1024 ** 3), args.cookies_browser)
    Handler.cache = cache
    # enforce cap at startup
    cache.enforce_cap()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"cache dir: {cache.dir} (max {args.max_gb} GB, currently {cache.total_bytes()/1e9:.2f} GB)")
    log(f"listening on 127.0.0.1:{args.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
