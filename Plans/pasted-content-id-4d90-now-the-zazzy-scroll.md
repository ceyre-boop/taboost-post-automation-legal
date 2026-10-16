# Plan — Bulk multi-platform posting ("multitudes of videos in a minute")

## Context
"What they're paying for" boils down to one killer job: **a minute of the user's
effort posts many videos across every platform.** Today the engine posts **one
video to the selected platforms at a time** (`src/cli.ts post --video … --platform …`,
and the local dashboard upload form). The value the user described —
*drop in multitudes of videos → one click → they all go out everywhere; and a
specific video you upload gets sent out* — is **batch** posting, which doesn't exist yet.

This plan builds that batch capability on the **existing local engine** (TikTok +
Instagram already verified, drives the user's own Chrome, no credentials stored), so
it's usable immediately via `bun run dashboard` / the CLI. Billing, the desktop-app
wrapper (the user's "desktop app first" / one-time-license answers), and
auto-generated videos are **explicitly out of scope here** and sequenced after — this
plan is only the posting feature.

**Each paying user posts THEIR OWN uploaded videos** — the user supplies the clips and
they get sent out across their platforms ("the same video they specifically upload gets
sent out"). The auto-generated TABOOST-brand product/tip videos are a separate thing that
belongs only to TABOOST's own account; they are **not** part of this product and this
plan does not touch that pipeline.

## Scope
- **In:** post N user-provided videos × M connected platforms from one ~1-minute setup;
  live progress; resumable; human-spaced to avoid spam flags; dry-run by default.
- **In:** verify/fix the **YouTube** adapter so "every platform" is real (it's the one
  unverified platform — ISA ISC-11).
- **Out (later, noted):** Stripe/one-time-license billing, Tauri/Electron desktop
  packaging + license unlock, per-creator personalized videos, cloud scheduling.

## Design

### 1. Batch engine — `src/batch.ts` (new)
A pure orchestration layer over the existing per-post flow. Reuse, don't rewrite:
- `src/platforms/index.ts` adapters (`platform.post`), `src/browser.ts` `withBrowser`
  (it already **serializes** CDP attaches — posts must run one at a time anyway),
  `src/history.ts` `recordPost`.
- Input: `{ videos: {path, caption?}[], platforms: string[], live: boolean, spaceSec: number }`.
- Expands to a matrix of items `{video, platform, status, note}` and posts each
  **sequentially**, sleeping a randomized `spaceSec` (default ~45–90s) between live posts
  so the account doesn't look like a spam cannon; dry-runs run back-to-back.
- **Resumable batch state** reusing the weekly Job/JSON pattern (`src/weekly/paths.ts`):
  write the batch + per-item status to `~/Library/Application Support/TaboostPoster/batches/<id>.json`;
  on failure, `--resume <id>` re-runs only `pending`/`error` items.
- Caption strategy (keep setup to ~1 min): a shared caption applied to all, OR a
  per-file `<video>.txt` sidecar, OR filename-as-caption, OR none. Shared is the default.
- Dry-run by default; `live` only when explicitly set (mirrors the current safety rule).

### 2. CLI batch mode — `src/cli.ts` (extend)
Add without breaking single `post --video`:
- `post --dir <folder> [--caption "…"] [--platform tiktok,instagram,youtube] [--live] [--space 60]`
  — posts every `*.mp4/*.mov` in the folder to the listed platforms (default: all
  connected), spaced. Also accept repeated `--video a.mp4 --video b.mp4`.
- `batch:resume <id>`, `batch:list` thin wrappers over `src/batch.ts`.
- `--platform` now parses a comma list (today it's one id); default = all logged-in platforms.

### 3. Local dashboard — `dashboard/index.html` + `src/server.ts` (extend)
This is the "one minute of work" surface:
- Multi-file upload (`<input type=file multiple>`); show the chosen clips as a list.
- One shared caption box + optional per-clip caption override.
- Keep the existing platform checkboxes + the live/dry-run toggle.
- One **"Post all"** button → `POST /api/batch` (multipart, N files) → `runBatch` in
  `server.ts` (replaces/augments the single `runJob`), returns a batch id.
- **Progress grid** (clips × platforms) polled from `GET /api/batches/:id` showing
  queued → posting → ✓/✗ per cell, plus the existing job log + history panel.

### 4. YouTube verification — `src/platforms/youtube.ts`
Same method we used to verify Instagram: human logs in once in the tool's Chrome, then
a dry-run upload shakes out the YouTube Studio selectors; fix with `force`-clicks /
updated locators as needed; mark ISA ISC-11 when a dry run reaches the publish step.

## Files
- **New:** `src/batch.ts`, `Plans/…` (this file).
- **Edit:** `src/cli.ts` (batch args + comma platforms), `src/server.ts` (`/api/batch`,
  `/api/batches/:id`, `runBatch`), `dashboard/index.html` (multi-upload + progress grid),
  `src/platforms/youtube.ts` (verify/fix), `ISA.md` (new ISC for batch + YT result),
  `README.md` (batch usage).
- **Reuse (no change):** `src/platforms/{tiktok,instagram,youtube}.ts` `.post`,
  `src/browser.ts` `withBrowser`, `src/history.ts`, `src/weekly/paths.ts` Job pattern.

## Verification (end-to-end)
1. **CLI dry-run batch:** put 3 short test clips in a folder; `node src/cli.ts post --dir <folder> --platform tiktok,instagram` → each clip fills the upload + stops before publish; confirm `history.db` logged 6 `dry-run` rows and the batch JSON shows all `done`.
2. **Dashboard:** `bun run dashboard`, select the 3 clips, dry-run, watch the 3×2 progress grid complete green; screenshot via the Interceptor/real-Chrome flow.
3. **Spacing + resume:** kill mid-batch; `batch:resume <id>` finishes only the remaining items.
4. **One live post:** a single real clip to TikTok with `--live` to confirm real publish + the inter-post delay fires.
5. **YouTube:** after the human login, a dry-run upload reaches the YouTube publish screen.

## Sequenced after this (not built here)
Desktop app wrapper (Tauri/Electron around this same engine) + one-time **license**
unlock → then **billing** (one-time purchase issues the license the landing already
promises) → then per-creator content. The batch engine built here is what the desktop
app will ship.
