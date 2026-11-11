#!/bin/sh
# Keep the phone poster running on this Mac: starts at login, restarts on crash,
# keeps the Mac awake while it runs. Uninstall: launchctl bootout gui/$(id -u)/com.taboost.poster-remote
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOG="$HOME/Library/Application Support/TaboostPoster/remote.log"
DEST="$HOME/Library/LaunchAgents/com.taboost.poster-remote.plist"
mkdir -p "$(dirname "$LOG")"
sed -e "s#__NODE__#$NODE#" -e "s#__REPO__#$REPO#" -e "s#__LOG__#$LOG#g" "$REPO/scripts/com.taboost.poster-remote.plist" > "$DEST"
launchctl bootout "gui/$(id -u)/com.taboost.poster-remote" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "Installed. Log: $LOG"
