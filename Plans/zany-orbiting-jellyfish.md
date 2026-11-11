# Phone poster: stable link + sign in from the phone + remembered device

## Context
Skyler's link `http://192.168.4.47:4747/m?k=<KEY>` died because the Mac changed networks (it is now 10.32.198.136). Logins can only be done on the Mac's screen, and every phone shares one Chrome profile (currently holding whatever accounts were already signed in). Colin wants:
1. A link that keeps working for at least a month on the same Wi-Fi.
2. Skyler signs into her accounts **from her phone**, once; on later visits her phone is recognised and her accounts are already connected.
3. Posting needs no changes. Skyler's first post is the live test for the untested platforms.

## 1. Stable link (survives IP changes, reboots, crashes)
- **Name, not IP:** print and save `http://TABOOSTs-MacBook-Pro.local:4747/m?k=<KEY>`. iPhones resolve `.local` over Bonjour on the same Wi-Fi, so the link survives DHCP and network changes. Keep the existing access key (`access-token.txt`) so the key in the link never changes. Also print the IP link as a backup.
- **Always running:** new LaunchAgent `~/Library/LaunchAgents/com.taboost.poster-remote.plist` that runs `/usr/bin/caffeinate -ims node src/remote.ts --lan` with `RunAtLoad` + `KeepAlive` and logs to `APP_DIR/remote.log`. It restarts after crashes and after a reboot or login. caffeinate keeps the Mac awake while it runs.
- Stop the stray Nov 6 process (PID 2304) before loading the agent so they don't fight over 4747.
- `remote.ts`: add the `.local` hostname to `announce()` (from `scutil --get LocalHostName`, with `os.hostname()` as a fallback).
- **Limit to state plainly:** the Mac must stay on, plugged in, and logged in. With the lid shut on battery it sleeps no matter what.

## 2. Each phone gets its own Chrome profile (her accounts, remembered)
- **Device registry** `src/devices.ts`: `APP_DIR/devices.json` maps `deviceId → { name, profileDir, cdpPort, createdAt }`. Ports are allocated from 9230 upward. The profile lives at `APP_DIR/profiles/<deviceId>`.
- **Phone side:** the first visit asks "Who's posting?" (e.g. Skyler). The server creates the device and the page rewrites the URL to `…/m?k=KEY&d=DEVICEID`, saves it in localStorage, and tells her to bookmark it or **Add to Home Screen**. The `d` in the link is the real memory: Safari can wipe localStorage after 7 idle days, but a bookmarked link still carries the device. Every API call sends `x-taboost-device`.
- **Parameterise the Chrome engine (reuse, don't fork):**
  - `src/config.ts`: export `defaultProfile = { dir: PROFILE_DIR, port: CDP_PORT }`.
  - `src/chrome.ts`: `launchChrome(startUrl, profile)`, `killToolChrome(profile)`, `attach(profile)`. Everything takes `{dir, port}` instead of the constants.
  - `src/browser.ts`: `withBrowser(fn, startUrl, profile)` with one serial chain **per profile**, so Skyler's Chrome and Colin's don't block each other.
  - `src/server.ts`: `profileFor(req)` resolves the device header to its profile, or falls back to `defaultProfile`. `status()`, `openLogin()`, `runJob()` and `startBatch()` all pass it through. The desktop dashboard and CLI keep the default profile, so nothing Colin uses changes.
- **Sign in from the phone (remote login screen):**
  - Tapping a grey platform opens a full-screen "Sign in to TikTok" sheet on the phone. The server opens `loginUrl` in **her** profile's Chrome, sets a phone-sized viewport (`Emulation.setDeviceMetricsOverride` ~390×780, mobile UA), and streams the tab with CDP `Page.startScreencast` (JPEG frames).
  - `GET /api/remote/stream` is Server-Sent Events carrying frames (no new dependency; Node's http module handles it). `POST /api/remote/input` carries taps (`Input.dispatchMouseEvent`, scaled to the viewport), scroll (`mouseWheel`), typed text (`Input.insertText` from a hidden phone input, so the iOS keyboard appears), and Backspace/Enter/Tab (`dispatchKeyEvent`).
  - The sheet polls `isLoggedIn` every 2s. When the platform's session cookie appears, it closes the sheet, turns the chip green, and stops the screencast. A "Done" button closes it manually (e.g. after a 2FA prompt finishes).
  - Passwords pass through as keystrokes into the real login page and are never stored or logged. Only Chrome's own profile keeps the session, as today.
- Her Chrome window opens on the Mac's screen; that is fine and also lets Colin help her if a login gets stuck.

## 3. Posting
No change. She picks platforms, taps Post, and it runs in her profile. Unverified platforms keep their "beta" tag.

## Files
- edit: `src/config.ts`, `src/chrome.ts`, `src/browser.ts`, `src/server.ts`, `src/remote.ts`, `mobile/index.html`; callers of `launchChrome`/`attach` (`src/cli.ts`, `src/batch.ts`, `src/weekly/approve.ts`) move to the default profile
- new: `src/devices.ts`, `src/remote-view.ts` (screencast + input), `scripts/com.taboost.poster-remote.plist` (+ install script), `src/devices.test.ts`

## Verification
1. `bunx tsc --noEmit` and `node --test src/devices.test.ts src/weekly/weekly.test.ts` pass.
2. `launchctl load` the agent; `curl -o /dev/null -w %{http_code} "http://TABOOSTs-MacBook-Pro.local:4747/m?k=…"` → 200. Kill the node process and confirm launchd brings it back within seconds.
3. Open the link at iPhone width in Chrome (Interceptor). Enter the name "Test", confirm the URL gains `&d=`, and confirm a new profile dir and port appear in `devices.json`.
4. Tap X: frames render in the sheet, a tap on the username field focuses it, and typed text appears on the Mac's X login page. No real login needed for this check.
5. Reload the `&d=` link: the same device and profile come back. `/api/status` with that device shows its own login state, separate from the default profile (still all green).
6. Dry-run post (`live` omitted) via curl with the device header, on a platform logged into the test profile, reaches the final button.
7. Delete the "Test" device, then hand Colin the final link for Skyler.
