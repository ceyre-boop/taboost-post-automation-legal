---
phase: build
tier: E4
updated: 2026-10-14
---

# TABOOST Poster — Ideal State Artifact

## Problem
The first attempt at post automation went through the TikTok Content Posting API: developer app, review, API keys, privacy and terms pages (the HTML files still in this repo). Review is slow, scopes are narrow, and every agency using it would still depend on our app credentials. RnR's Auto-Messenger suite proves a different route works at scale with zero API: it drives the agency's own Chrome.

## Vision
Anyone installs the tool, logs into TikTok (and later other platforms) themselves inside a Chrome window the tool opens, and from then on the tool posts for them. We never hold a username, password, token or cookie export. The logged-in session lives only in a Chrome profile folder on the user's machine.

## Out of Scope
- Any server-side storage of user sessions or credentials.
- Bypassing captchas, rate limits or bot detection. If the platform asks for a puzzle, the user solves it in the window.
- Mass or multi-account posting from one machine.
- ~~Content generation. The tool posts what it is given.~~ **Amended 2026-10-15:** the Weekly
  Video pipeline (`src/weekly/`, `video/`) now *generates* one official TABOOST product
  video per week from real catalog data. Scope stays narrow: it is the account owner's own
  brand, own products, own numbers — a templated motion-graphics spot, not AI-generated
  footage, not third-party or deceptive content. The core poster is still content-agnostic.

## Principles
- The person owns the login. The tool only owns the clicks.
- Real Chrome, real profile, no headless. Same fingerprint as a human user of that machine.
- Dry run by default. Publishing requires an explicit flag.
- Recoverable, not clever. When the page is not where we expect, say so in plain words and pause for the human.

## Constraints
- Google Chrome must be installed. The tool launches the user's Chrome binary with its own `--user-data-dir` and a loopback-only `--remote-debugging-port`.
- Runtime is Node (TypeScript via native type stripping). Bun manages dependencies but cannot run the CDP attach: Bun 1.3.14 + playwright-core 1.64 `connectOverCDP` hangs on the websocket upgrade while Node 25 connects instantly (verified 2026-10-14). Revisit when Bun fixes it.
- Playwright `connectOverCDP` only. Never Playwright-managed Chromium, never cookie files written by us.

## Goal
`node src/cli.ts post --video x.mp4 --caption "..." --live` publishes a TikTok video from the user's own account with no credential ever passing through our code.

## Criteria
- [x] ISC-1: `status` launches Chrome on `~/Library/Application Support/TaboostPoster/chrome-profile` and attaches over CDP. Probe: `node src/cli.ts status` prints `logged in` or `NOT logged in`, exit 0. PASSED 2026-10-14.
- [x] ISC-2: A second run reuses the already-open Chrome instead of launching another. Probe: `cdpAlive()` short-circuit in `launchChrome`.
- [x] ISC-3: Login detection is cookie-based, read from the live context, never persisted by us. Probe: `grep -r cookies src` shows only `context().cookies()` reads; no file writes.
- [x] ISC-4: `login` waits until the user signs in, then reports success. Probe: `status` → `tiktok: logged in`. PASSED 2026-10-14 12:34.
- [x] ISC-5: `post` (dry run) opens TikTok Studio upload, attaches the file, types the caption, waits for Post to enable, and stops without clicking. Probe: real mp4, final log line is the DRY RUN line, screenshot shows caption + preview + Post enabled. PASSED 2026-10-14 12:35.
- [x] ISC-6: `post --live` publishes and records `posted` in `history.db`. PASSED 2026-10-14 12:49: TikTok Studio Posts list went 0 → 1 ("test").
- [x] ISC-9: Dashboard at http://127.0.0.1:4747 shows per-platform login state, Connect opens the login tab in the tool's Chrome, the post form fans out to selected platforms with a live job log. Probe: `bun run dashboard`; API dry-run job for TikTok finished `dry-run` in 24s. PASSED 2026-10-14 12:52.
- [x] ISC-10: Instagram adapter dry run passes on a live account. PASSED 2026-10-15: logged in as a real account (human passes IG's one-time "are you human" check in the window), dry run drove Create → attach video → Crop → Next → Next → caption → stopped on the Reel "Share" screen with the caption filled. Fix: IG nests the clickable Next/Share inside another role=button div, so strict clicks fail the hit-test; `click({ force: true })` lands on the real button (the topmost element at its center IS the button). IG now publishes these as Reels.
- [ ] ISC-11: YouTube adapter dry run passes on a live channel. Adapter written, UNVERIFIED (needs the one-time human YouTube/Google login, then a dry run).
- [x] ISC-12: Batch posting — N user-supplied videos × M platforms from one setup, posted sequentially with human-like spacing on live, resumable, dry-run by default. Probe: `node src/cli.ts post --dir <folder> --platform tiktok,instagram` → PASSED 2026-10-16: 3 clips × 2 platforms = 6/6 dry-run posts, 0 errors; `/api/batch` + `/api/batches/:id` drove 2 clips × TikTok 2/2 via the dashboard; `batch:resume` on a completed batch is a correct no-op. Engine: `src/batch.ts`.
- [x] ISC-7: Unknown platform id fails with the list of known ones. Probe: `getPlatform("x")` throws.
- [x] ISC-8: Typecheck clean. Probe: `bunx tsc --noEmit`.
- Anti-1: No file under `src/` reads or writes a password or token. Probe: `grep -riE "password|token|sessionid" src` matches only the cookie-name check in tiktok.ts.
- Anti-2: No network call to any TABOOST or third-party server from the tool. Probe: `grep -r "https://" src` shows only platform URLs.

## Test Strategy
Live probes against the real Chrome on this machine. Selectors on TikTok Studio are the fragile part; each is a locator with fallbacks and a loud error, verified by a human-attended dry run before any `--live`.

## Features
- F1 Chrome launcher and CDP attach (`src/chrome.ts`). DONE.
- F2 Platform interface (`src/platforms/`). TikTok VERIFIED live. Instagram + YouTube written, unverified.
- F3 CLI: `login`, `status`, `post` (`src/cli.ts`). DONE.
- F4 Local post history, SQLite via `node:sqlite` (`src/history.ts`). DONE.
- F6 Dashboard (`src/server.ts`, `dashboard/index.html`): accounts, connect, post form, job log, history. DONE.
- F5 Next: Instagram and YouTube adapters; a small desktop UI (RnR uses customtkinter; ours can be Tauri or Electron around this same core); schedule window and daily limit like RnR's `message_limit` / `time_start` / `time_end`.

## Decisions
- 2026-10-14 Mirror RnR's mechanism, not its stack. RnR: PyInstaller + customtkinter + Playwright, launches `/Applications/Google Chrome` with `--user-data-dir=<tmp>/chrome_backstage_im --remote-debugging-port=9225`, then `connectOverCDP("http://127.0.0.1:9225")`. The user logs in and clicks "I'm on Backstage — Go!". A `_repair_window` routine reloads or relaunches Chrome when the page drifts and pauses with "Backstage logged you out. Log in again" when it detects `/login`. We copy that shape in TypeScript.
- 2026-10-14 RnR also writes `backstage_cookies.json` next to its SQLite history. We deliberately do not: the profile folder already holds the session, and an exported cookie file is a liability we do not need.
- 2026-10-14 Runtime Node, not Bun, for the reason in Constraints. Deviation from the house rule, recorded here.
- 2026-10-14 Port 9226, not 9222 (used by Interceptor on this machine) and not 9225 (RnR).
- 2026-10-14 The legal HTML pages stay in this repo for now so the GitHub Pages URL keeps working; the tool lives alongside in `src/`.

## Changelog
- 2026-10-14 Conjecture: `button:has-text("Post")` is a safe fallback. Refutation: it matched the sidebar "Posts" first; two live runs clicked the wrong button and the tool reported "Done" anyway. Learning: exact-text selectors only, and "published" requires a positive signal (redirect to Posts or an upload dialog), never a timeout.
- 2026-10-14 TikTok asks "Continue to post?" when its copyright check is mid-run. Adapter now waits up to 90s for the check and answers "Post now" if still asked.
- 2026-10-14 TikTok Studio shows a one-off "Turn on automatic content checks?" modal that intercepts clicks. Added `dismissModals` (clicks Cancel/Not now/Skip only, never changes settings). Dry run then passed in 21s.
- 2026-10-14 First login attempts failed because the Wi-Fi had a Fortinet firewall MITM-ing tiktok.com (NET::ERR_CERT_AUTHORITY_INVALID). Not a tool bug; switched network.
- 2026-10-14 Conjecture: Bun can run the whole tool. Refutation: `connectOverCDP` timed out under Bun twice, raw websocket from Bun worked, Node + same playwright-core connected at once. Learning: the fault is in playwright-core's ws path under Bun, not Chrome or the flags.

## Verification
- 2026-10-14 12:35 `bun run post -- --video TikTok_Display_Feed_demo.mp4 --caption "test post from TABOOST Poster"` → Opening upload / Video handed / Caption typed / DRY RUN line. Screenshot: caption present, Post enabled, not clicked.
- 2026-10-14 `bunx tsc --noEmit` clean. `node src/cli.ts status` → `tiktok: NOT logged in (CDP :9226)` exit 0 with a fresh profile. Chrome window visible on `about:blank`.
