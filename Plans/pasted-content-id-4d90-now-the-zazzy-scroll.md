# Plan — More platforms for the cross-platform poster

## Context
The paid product is: a creator uploads one video, picks their socials, and it posts to
all of them. The bulk-posting engine for that is **already built and shipped**
(`src/batch.ts`, parallel per-clip, dashboard + CLI). Its value now scales with the
number of platforms, and the user's direction is explicit: *"as many options as we can
provide the better."* Today only **TikTok** and **Instagram** are verified; **YouTube**
is drafted but unverified. This plan adds more platform adapters.

The architecture makes this cheap per platform: every platform is a `Platform`
(`src/platforms/types.ts`) registered in the `PLATFORMS` map
(`src/platforms/index.ts:6`). The batch engine, `loggedInPlatforms()`, the CLI
`--platform` list, and the dashboard checkboxes all enumerate that map — **so a new
adapter + one registry line makes it appear everywhere automatically. No engine, CLI,
or dashboard changes are needed.** The only real work is each platform's web upload
flow, which must be reverse-engineered against a real login (exactly how Instagram was
verified: write best-effort selectors → dry-run → fix → verify).

(Separate track, NOT in this plan: the user's personal auto-generated TABOOST/creator-tip
videos posted to TikTok only. That's `src/weekly/` + the batch poster, for Colin's own
account — unrelated to this product work.)

## Scope
- **In:** new platform adapters, in priority order: **YouTube** (verify the existing
  draft) → **Facebook** → **X/Twitter** → **LinkedIn** → **Pinterest** → **Threads**.
  Each: write/fix adapter → register → one-time human login → dry-run to the publish
  screen → harden selectors → mark ISA ISC. Order is adjustable.
- **In:** a small "unverified" marker in the dashboard so users don't trust a
  not-yet-verified platform on a live post.
- **Out:** Snapchat (no real web video-upload surface); anything needing an official API
  or stored credentials (violates the no-API/no-credential design); the personal
  TikTok video-generation track.

## The adapter pattern (reuse — template off `src/platforms/tiktok.ts` + `instagram.ts`)
Each `src/platforms/<name>.ts` implements `Platform`:
- `id`, `label`, `loginUrl`, `host` (regex).
- `isLoggedIn(page)` — read a session cookie for the site via
  `page.context().cookies(url)` (e.g. TikTok `sessionid`; Facebook `c_user`/`xs`;
  LinkedIn `li_at`; X `auth_token`; Pinterest `_pinterest_sess`; Google `SID`/`__Secure-3PSID`).
- `post(page, {video, caption, dryRun}, log)` — `page.goto(uploadUrl)`; if redirected to
  login, throw the "log in in the window" error; `input[type=file]` `setInputFiles(video)`;
  dismiss one-off modals; fill the text field(s); **if `dryRun` return before the publish
  click**; else click publish and confirm success by a **positive signal** (redirect or a
  success dialog), never by timeout (the TikTok lesson, `tiktok.ts:86-103`).
- Reuse: `src/platforms/instagram.ts`'s `click({ force: true })` trick for sites that
  nest the real button inside another `role=button`.

### Per-platform caption mapping (`PostInput.caption` is one string)
- TikTok / Instagram / Threads / X / LinkedIn / Facebook: use the whole caption as the
  post text. (X has a ~280-char limit — truncate with a note in the log.)
- YouTube: first line = title, rest = description (already done in `youtube.ts`).
- Pinterest: first line = pin title, rest = description; **must also pick a board** —
  select the first/most-recent board by default (document this).

## Per-platform workflow (repeatable; each needs ONE human login)
1. Write `src/platforms/<name>.ts` (best-effort selectors from the live upload page).
2. Register it in `src/platforms/index.ts` `PLATFORMS`.
3. `node src/cli.ts login --platform <name>` — the user signs in once in the tool's
   Chrome, passing any human/2FA check; the session persists in the profile.
4. `node src/cli.ts post --video <clip> --platform <name>` (dry run) — drives the flow;
   screenshot the publish screen.
5. Fix selectors/waits until the dry run reaches the publish screen cleanly.
6. Mark the ISA ISC for that platform; a later **user-approved** `--live` single post
   confirms real publishing.

## Files
- **New:** `src/platforms/facebook.ts`, `x.ts`, `linkedin.ts`, `pinterest.ts`,
  `threads.ts` (one per platform, as reached).
- **Edit:** `src/platforms/index.ts` (register each), `src/platforms/youtube.ts`
  (fix on first verify), `ISA.md` (ISC per platform), `dashboard/index.html` (tiny
  "unverified" tag on platforms not yet proven), `README.md` (platform list).
- **No change:** `src/batch.ts`, `src/cli.ts`, `src/server.ts` core (platform-agnostic).

## Verification (per platform, end-to-end)
1. `login` → `status` shows `logged in`.
2. Dry-run `post --video <clip> --platform <name>` reaches the publish screen (screenshot
   via the real-Chrome flow); no thrown error.
3. One **user-approved** `--live` post publishes and is confirmed by a positive signal.
4. Finally, a mixed dry-run batch (`post --dir <folder> --platform tiktok,instagram,<new>…`)
   shows every cell green in the dashboard grid — proving "upload once → all selected."

## Sequencing
One platform per login session, starting with **YouTube** (nearest — adapter drafted,
just needs the Google login that timed out earlier). Each subsequent platform is the
same short loop. Breadth grows one verified platform at a time; unverified drafts are
labeled so no one trusts them live.
