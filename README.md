# Northbound Poster

Northbound Studio's first automation: add one video, and it goes to every platform you use. It posts from the user's **own** logged-in browser. No API keys, no app review, no passwords or tokens ever touch this code.

It was called TABOOST Poster until 2026-11-18. The repo keeps its old name so the published legal pages and download links keep working.

## Official sign-in: Connect on the platform's own page (2026-11-22, branch `official-connect`)

On the phone, **Post to** shows every platform as *Official · <account>*, *The Mac's browser*, or **Connect**. Connect opens the platform's own sign-in in Safari, so saved passwords and Face ID just work, and the phone page updates itself when it's done.

| Platform | How it posts | Choose who | Song |
|---|---|---|---|
| YouTube | official upload (resumable; a private test uploads private) | her channel | credit line |
| Instagram | official Reel; **Creator or Business account linked to a Facebook Page** | each professional account; "Personal account (the Mac's browser)" | credit line, or Instagram's own song attached at 1% |
| Facebook | official Page Reel (3-90 s; longer is a Page video); a private test leaves a draft | each Page; "My profile (the Mac's browser)" | credit line |
| TikTok | official upload **to her TikTok inbox as a draft**: she adds the song (volume 0), pastes the caption (one tap copies it), posts | her account | she adds it in TikTok |
| X, Threads | the Mac's browser, as before | | credit line |
| LinkedIn | official post on her profile (optional) | | credit line |

Also: **a caption per platform** (counters against each limit, a YouTube title line), **a song** ("🎵 Song by Artist", per platform), and **Private test** (nothing public). Posts run through the batch engine: saved as they go, recovered after a restart, never sent twice.

Posting permissions (OAuth tokens) live only in the macOS Keychain (service `com.northbound.post-everywhere`). No password is ever typed into or kept by the app. Disconnect revokes the permission at the platform.

### Setting it up (once, about an hour)

1. `cp .env.example .env && chmod 600 .env` (git ignores it). You type the values in yourself; never paste them in a chat.
2. Every developer app below registers the same redirect URI: `https://northbound-dev.com/connect/callback.html`.
3. **Google (YouTube):** console.cloud.google.com, new project, enable *YouTube Data API v3*. OAuth consent screen: External, add Skyler's Google address as a test user, then **Publish app** (unverified is fine; in Testing mode sign-ins expire every 7 days). Credentials: OAuth client ID, type *Web application*, the redirect URI above. Put the id and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. **Meta (Facebook Pages + Instagram):** developers.facebook.com, Create app, type *Business*, use cases "Manage everything on your Page" and "Instagram (Facebook login)". Facebook Login for Business: add the redirect URI (Strict mode on), create a configuration with `pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, business_management`; its id is `META_LOGIN_CONFIG_ID`. App roles: add Skyler as a Tester (she accepts on Facebook). App settings: privacy policy URL. `META_APP_ID` / `META_APP_SECRET`. While the app is in Development mode only people on the app see its posts: switch it to **Live** after the private test.
5. **TikTok:** developers.tiktok.com, create an app; add *Login Kit* (Web, the redirect URI) and *Content Posting API* with **Upload** only; scopes `user.info.basic`, `video.upload`. Add a sandbox and Skyler as a target user. `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`. If the sandbox refuses uploads, submit the app for review.
6. **LinkedIn (optional):** developer.linkedin.com, create an app (needs a Company Page), products *Share on LinkedIn* and *Sign In with OpenID Connect*, the redirect URI. `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
7. `npm run connect-check` shows what's set (names only), whether the return page answers, and what's connected. Then restart the poster and tap Connect on the phone.

The browser-only accounts sign in at the Mac: `sh scripts/signin.sh --device skyler`.

## Post Everywhere: the app (2026-11-21)

`bun run app` starts the app at http://127.0.0.1:4747. It is the same posting engine with a front end a non-technical person can use alone:

- **First run:** welcome, connect accounts, done. Each Connect opens the app's own Chrome window and the person signs in there. The app never asks for, sees or stores a password or token. **Disconnect** clears that one site's session from the app's Chrome and nothing else.
- **Post:** drag in videos, a caption per clip or one shared caption, pick accounts, set the time between posts (on by default), then **Preview** (fills everything in and stops before the Post button) or **Post now**.
- **Progress:** a live clip by platform grid: Waiting, Posting, Done, Failed. Every failure has a plain-English problem and fix (`explain()` in `src/app.ts`), with the raw message under Details, and **Try failed again** re-runs only what failed.
- **History:** what went where and when, with a link to the person's own posts on that platform.
- Seven platforms are offered. Pinterest is hidden until it has posted for real.
- Nothing is tied to one person's machine: all data is in the user's own app folder (see below), and a brand-new empty folder goes through first-run cleanly.

Tests: `npm test` (settings, naming, the platform list, the failure messages, devices, weekly, the post maker, security, phone-link mode, the adapters' caption and site rules) and `bun run typecheck`.

## The post maker (2026-11-21)

The **Make** screen makes posts as well as posting them:

1. **Your business, once:** name, what you do, who it's for, 3 to 10 facts you're happy to say, words never to use, the call to action, a brand colour, a feel (upbeat, calm, bold), 3 to 30 photos and an optional logo. iPhone HEIC photos are converted with the Mac's own `sips`. Saved per set of accounts in `<set folder>/maker/`.
2. **Ideas:** each one is built on one fact and never repeats a post already made or thrown away.
3. **Make:** the app writes the on-screen script and one caption per account, then renders a 1080×1920 MP4 (H.264 + AAC, 15 to 25 seconds) in a headless copy of the person's Chrome: photos with a slow zoom, burnt-in text inside the platforms' safe areas, brand colour, logo end card, and music the page generates itself (nothing licensed). About 5 to 10 seconds to render.
4. **Review:** the video plays in the page, every caption can be changed (each checked against its platform's limit), then Preview or Post now through the normal batch engine.
5. **Make and post by itself:** N posts a week, at most 2 a day. It can't be switched on in the first 24 hours after a set's accounts are first connected, and it's off until switched on.

### Second round (2026-11-22, branch `video-maker`)

- **Six looks** (`src/maker/formats.ts`), each with its own layout in `dashboard/render.html` and its own rules in `checks.ts`: Quick tips, 1-2-3 steps, Myth vs fact (the myth is struck through), Problem and fix, A question people ask (a speech bubble), and One number (counted up, only for a fact with a number). Ideas come in as many different looks and facts as possible.
- **Your clips** (`src/maker/clips.ts`): add an MP4 or MOV (up to 1 GB, written to disk as it arrives; length, size, sound and codec are read from the file; ProRes is refused with how to export). Say what it shows, pick at most 56 seconds of it, and **Finish this clip**: it's fitted to an upright screen (over a blurred copy of itself when it's wide), with the title, captions in turn, the clip's own sound under the music, and the end card. Clips are also mixed in behind the photo looks.
- **This week** (`src/maker/plan.ts`): **Plan my week** picks 3 to 5 posts (unused clips first, then varied looks) on spread-out days at midday and evening, makes them one at a time, and waits. Nothing posts until it's approved; an approved post goes out at its time while the app is open, and one more than 6 hours late waits for the person again. "Plan a new week by itself" re-plans when the week ends, and each post still needs approval.
- Voice is not built yet (decided 2026-11-22: later, with a paid voice service or Colin's own recording).

Checks before anything is shown (`src/maker/checks.ts`): every number must come from the person's facts, never-say words and unbacked claims (guaranteed, #1, licensed, cheapest…) are refused, on-screen text must fit, and every chosen account needs a caption within its limit. A script that fails goes back to the AI once with the problems; a second failure makes nothing and says why.

The AI follows `HOSTING.md`: Northbound hosting by default, or the person's own API key; never the Max plan. Every request is logged with its estimated cost in `usage.jsonl`.

## Where it stands (2026-11-18)

| Platform | State |
|---|---|
| TikTok, Instagram, YouTube, X, Facebook, LinkedIn, Threads | Post for real and delete for real. One clip went up on all seven in about a minute and was then taken down on each (2026-11-18) |
| Pinterest | Uploads, then needs a board on the account; untested past that, no delete step |

## Test post (post, then delete)

`node src/cli.ts post --video clip.mp4 --caption "..." --live --delete-after` posts for real and takes the post straight back down. In the dashboard, tick **Post for real** and then **Test post**. `node src/cli.ts delete --caption "..." --platform x,tiktok` removes an earlier post.

The post is found again by the first line of its caption, on the account's own post list. If nothing matches, nothing is deleted. Facebook moves the post to its trash for 30 days; the others delete outright. TikTok held the test clip as "Content under review" and visible to "Only me" until it was deleted, so a brand-new clip may not be public on TikTok the moment it posts.

A rehearsal ("dry run") fills in everything and stops before the Post button. A platform is only marked `verified` in `src/platforms/` after it has posted for real.

## A second set of accounts

`POSTER_ACCOUNT=northbound bun run dashboard` keeps a separate set of signed-in accounts with its own browser, so a business account never mixes with a personal one. Use the same variable with `login`, `status` and `post`.

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
- Batches are **resumable** — state lives in the data folder under `batches/`.
- **Dashboard** (`bun run dashboard`, http://127.0.0.1:4747): select many clips, pick platforms once, hit **Post all**, watch the clip×platform progress grid.
- Engine: `src/batch.ts` (orchestrates the per-platform adapters; one Chrome attach at a time).

Data lives in `~/Library/Application Support/NorthboundPoster/` (Chrome profile + `history.db`). A machine that used the tool before the rename keeps `TaboostPoster/`. Delete the folder to log out everywhere.

## Weekly product video (TABOOST's own content, not part of the product)

This and `src/pipeline/` are what Colin uses to make videos for TABOOST's own accounts. They are not sold with Northbound Poster and keep the TABOOST name.

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
