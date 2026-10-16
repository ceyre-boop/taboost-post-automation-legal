# TABOOST Poster

Posts to social platforms from the user's **own** logged-in browser. No API keys, no app review, no passwords or tokens ever touch this code.

## How it works (the RnR mechanism)

RnR's Backstage IM Messenger and TikTok Auto-Messenger do exactly one trick:

1. Launch the user's installed Google Chrome with a private profile folder and a localhost debugging port.
2. Tell the user to log in inside that window.
3. Attach Playwright over CDP to that Chrome and drive the page.

The profile folder keeps the session between runs. We do the same thing in TypeScript.

```
bun install
bun run login                     # opens Chrome, you log in to TikTok, we wait
bun run status                    # logged in or not
bun run post -- --video clip.mp4 --caption "hello"          # dry run: fills everything, never clicks Post
bun run post -- --video clip.mp4 --caption "hello" --live   # publishes
```

## Bulk posting — many videos, every platform, one go

Drop in a pile of your own clips and send them all out across every connected
platform. A minute of setup; the posting runs itself.

```
node src/cli.ts post --dir ~/clips --platform tiktok,instagram,youtube        # dry run every clip x platform
node src/cli.ts post --dir ~/clips --caption "shared caption" --live --space 60   # publish, ~60s apart
node src/cli.ts post --video a.mp4 --video b.mp4 --live                        # a few specific clips (all logged-in platforms)
node src/cli.ts batch:list                                                    # see batches + per-item status
node src/cli.ts batch:resume <id>                                             # finish the items that failed/were left
```

- No `--platform` = every platform you're logged into. Dry run unless `--live`.
- **Per-clip caption:** put `myclip.txt` next to `myclip.mp4`; otherwise `--caption` applies to all.
- Live posts are **spaced** (`--space` seconds, jittered) so the account doesn't look like a spam cannon.
- Batches are **resumable** — state lives in `~/Library/Application Support/TaboostPoster/batches/`.
- **Dashboard** (`bun run dashboard`, http://127.0.0.1:4747): select many clips, pick platforms once, hit **Post all**, watch the clip×platform progress grid.
- Engine: `src/batch.ts` (orchestrates the per-platform adapters; one Chrome attach at a time).

Data lives in `~/Library/Application Support/TaboostPoster/` (Chrome profile + `history.db`). Delete the folder to log out everywhere.

## Weekly product video (auto-generate + post)

Makes one official TABOOST product video a week from real catalog data, then waits for
your OK before it posts. Nothing publishes unattended.

```
bun run weekly                    # pick top-selling product, render a demo-style spot, stage it
bun run weekly:list               # see staged videos awaiting approval
node src/weekly/approve.ts <id>            # dry run the upload (safe)
node src/weekly/approve.ts <id> --live     # publish to TikTok
node src/weekly/approve.ts <id> --caption "your words"   # edit the caption first
node src/weekly/approve.ts <id> --skip     # drop it; that product won't resurface
```

- **The video** (`video/`, Remotion): vertical motion-graphics spot — official product
  photo (TikTok Shop `og:image`), real numbers (units sold, commission %), TABOOST teal +
  logo, hook and a recruiting CTA. Deterministic, $0 per render, no AI-generated footage.
- **The pick** (`src/weekly/catalog.ts`): top unfeatured seller from
  `~/TABOOST-Shop/data/shop/tap-products.csv` (override with `TABOOST_SHOP_DIR`). Posted
  products are remembered in `weekly/featured.json` so each week is new.
- **Schedule:** `scripts/com.taboost.weekly-video.plist` builds + stages every Monday 9am
  (`launchctl load`). It never posts on its own — you approve each one.

Scripts run on Node (TypeScript natively). Bun manages dependencies only; see `ISA.md` → Constraints for why.

## Legal pages

`index.html`, `privacy.html`, `terms.html` are the GitHub Pages site from the earlier TikTok API attempt and stay here so the published URL keeps working.
