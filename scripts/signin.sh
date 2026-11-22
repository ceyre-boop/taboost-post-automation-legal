#!/bin/sh
# Sign in to Google/YouTube/TikTok in a plain Chrome window (no automation flags), so
# Google doesn't say "This browser or app may not be secure". The sign-in is kept in the
# set's own Chrome profile; the app never sees or saves a username or password.
# Chrome's own password autofill works here like any normal Chrome window.
#   sh scripts/signin.sh [set name]      e.g. sh scripts/signin.sh skyler
# Quit that Chrome window (Cmd-Q) when done; the next post reopens it for posting.
BASE="$HOME/Library/Application Support/TaboostPoster"
[ -d "$BASE" ] || BASE="$HOME/Library/Application Support/NorthboundPoster"
DIR="$BASE${1:+/accounts/$1}/chrome-profile"
mkdir -p "$DIR"
pkill -f -- "--user-data-dir=$DIR" 2>/dev/null; sleep 2
open -na "Google Chrome" --args --user-data-dir="$DIR" --no-first-run \
  https://accounts.google.com/ServiceLogin?continue=https://studio.youtube.com https://www.tiktok.com/login
echo "Sign in, then Cmd-Q that Chrome window. Posting reopens it automatically."
