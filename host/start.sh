#!/usr/bin/env bash
# Start the local host (defaults: port 8717, cache ~/.yt-extension-cache, 10GB cap).
# Run this once when you want to use YT Local. Stop with Ctrl-C.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${YT_EXT_PORT:-8717}"
CACHE_DIR="${YT_EXT_DIR:-$HOME/.yt-extension-cache}"
MAX_GB="${YT_EXT_MAX_GB:-10}"
COOKIES="${YT_EXT_COOKIES:-chrome}"
exec python3 "$DIR/host.py" --port "$PORT" --dir "$CACHE_DIR" --max-gb "$MAX_GB" --cookies-browser "$COOKIES"
