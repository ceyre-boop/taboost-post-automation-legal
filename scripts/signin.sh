#!/bin/sh
# Sign in to the browser-only accounts (Facebook profile, X, Threads) in a plain Chrome window
# (no automation flags), so the sites treat it like any normal Chrome and its own password
# autofill works. The sign-in is kept in that Chrome profile; the app never sees or saves a
# username or password. Accounts with an official sign-in (YouTube, Instagram, Facebook Pages,
# TikTok) connect from the phone instead: Connect, then sign in on the platform's own page.
#   sh scripts/signin.sh --device skyler    the profile Skyler's phone posts from (use this)
#   sh scripts/signin.sh [set name]         a named set's profile, e.g. Northbound
# Quit that Chrome window (Cmd-Q) when done; the next post reopens it for posting.
BASE="$HOME/Library/Application Support/TaboostPoster"
[ -d "$BASE" ] || BASE="$HOME/Library/Application Support/NorthboundPoster"
if [ "$1" = "--device" ]; then
  [ -n "$2" ] || { echo "Which phone? e.g. sh scripts/signin.sh --device skyler"; exit 1; }
  DIR=$(node -e '
    const [file, want] = process.argv.slice(1);
    let all = {}; try { all = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch {}
    const d = Object.values(all).find((x) => x.name.toLowerCase() === want.toLowerCase());
    if (d) console.log(d.profileDir);' "$BASE/devices.json" "$2")
  [ -n "$DIR" ] || { echo "No phone called \"$2\" yet. Open the link on that phone and enter the name first."; exit 1; }
else
  DIR="$BASE${1:+/accounts/$1}/chrome-profile"
fi
mkdir -p "$DIR"
pkill -f -- "--user-data-dir=$DIR" 2>/dev/null; sleep 2
open -na "Google Chrome" --args --user-data-dir="$DIR" --no-first-run \
  https://www.facebook.com/ https://x.com/login https://www.threads.net/login
echo "Sign in, then Cmd-Q that Chrome window. Posting reopens it automatically."
