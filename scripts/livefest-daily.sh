#!/bin/sh
# Owner 2026-11-21: post the next LIVE Fest lesson (2..5) once a day, then unload itself.
cd "$HOME/taboost-post-automation-legal" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
N=$(( $(cat data-lf/posted) + 1 ))
[ $N -gt 5 ] && { launchctl unload "$HOME/Library/LaunchAgents/com.taboost.livefest-lessons.plist"; exit 0; }
F=video/out/livefest-lesson-0$N.mp4
if node src/cli.ts post --video $F --platform tiktok --live >> data-lf/log.txt 2>&1 && tail -3 data-lf/log.txt | grep -q "1 done"; then
  echo $N > data-lf/posted
  osascript -e "display notification \"LIVE Fest video $N posted\" with title \"TABOOST\""
else
  osascript -e "display notification \"LIVE Fest video $N FAILED - check TikTok login\" with title \"TABOOST\""
fi
