#!/bin/bash
# Weekly TABOOST product video: build + stage for approval. Does NOT post.
# Run by launchd (com.taboost.weekly-video) and safe to run by hand.
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$HOME/taboost-post-automation-legal"
LOG="$HOME/Library/Application Support/TaboostPoster/weekly/build.log"
mkdir -p "$(dirname "$LOG")"
echo "=== $(date '+%Y-%m-%d %H:%M:%S') weekly build ===" >> "$LOG"
node src/weekly/build.ts >> "$LOG" 2>&1
