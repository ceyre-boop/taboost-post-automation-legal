# Colin's checklist (things only you can do)

From the creator-ready work on 2026-11-22, rebased on `video-maker` (which added official sign-in). Each step says exactly where to go. Nothing here asks you to share a password or key with anyone: you type keys into a file on your own Mac.

## 1. Get the fixes running (5 minutes)

The new code is on branch `creator-ready` (on top of `video-maker`). Nothing that's running now has it.

1. Merge `creator-ready` into the branch you run from.
2. Restart the phone service so phones get it: `launchctl kickstart -k gui/$(id -u)/com.taboost.poster-remote`
3. Skyler's phone link is a second phone service started by hand on port 4749 (`POSTER_ACCOUNT=skyler node src/remote.ts --lan --port 4748`). Stop it (Ctrl-C in its Terminal, or `kill` its process) and start it again the same way.
4. Rebuild your Mac app so Post Everywhere (Colin).app has it: `bun run build:me`, then quit and reopen the app.
5. Ask Skyler to try her drum video again from her bookmarked phone link. Her 147 MB .mov failed only because the service ran the old code. She can tick **Private test** first (on browser platforms it's a preview: nothing is posted).

## 2. Official sign-in (developer apps and keys: about an hour)

`video-maker` connects YouTube, Facebook Pages, Instagram (Creator/Business), TikTok (inbox drafts) and LinkedIn through their own sign-in pages, from the phone. It needs your developer apps and keys. Follow **README.md, "Setting it up (once, about an hour)"**, steps 1 to 7:

- Copy the keys file: `cp .env.example .env && chmod 600 .env`, then type the values in yourself.
- Google: https://console.cloud.google.com/projectcreate, enable the YouTube Data API v3 (https://console.cloud.google.com/apis/library/youtube.googleapis.com), consent screen External and **Publish app** (https://console.cloud.google.com/auth/audience; in Testing, sign-ins run out every 7 days), OAuth client of type *Web application* (https://console.cloud.google.com/auth/clients/create) with redirect URI `https://northbound-dev.com/connect/callback.html`.
- Meta: https://developers.facebook.com/apps/create/ (Business app, Facebook Login for Business configuration).
- TikTok: https://developers.tiktok.com/apps/ (Login Kit + Content Posting API, Upload).
- LinkedIn (optional): https://www.linkedin.com/developers/apps/new
- Then `npm run connect-check`, restart, and tap **Connect** on the phone page.

Since 2026-11-02 YouTube no longer forces an unverified project's uploads to private (docs/OFFICIAL-APIS.md), so YouTube's official upload is public-ready without an audit.

## 3. Sign-ins I couldn't do (I never type passwords)

- **Check that Google allows the Mac's new sign-in window.** In the Mac app: Accounts, then YouTube, then **Connect**. A plain Chrome window opens (no automation, so Google shouldn't refuse it, and Chrome fills in saved passwords). Sign in, press **Done** in the app, and the card should say Connected with "Stays signed in until about Dec 2027". I tested the window opening and closing, but not a Google sign-in in it.
- **Northbound's Instagram, LinkedIn and Threads** aren't signed in, so I couldn't preview or test those. Connect them in Accounts (Northbound set).
- **Northbound's TikTok is signed in as @taboost.colin.** If the Northbound set should post to Northbound's own TikTok, Disconnect TikTok there and Connect the right account. I only previewed on TikTok, never posted.
- **YouTube's daily upload limit:** Northbound's channel hit "Daily upload limit reached" after a day of tests. To lift it for good, verify the channel once (a text message): https://www.youtube.com/verify. Otherwise it resets after 24 hours.

## 4. Things to try that need an account with more than one identity

The phone page's account pickers (from `video-maker`) choose a Facebook Page or the profile, and which Instagram account. Northbound has one of each, so I couldn't try choosing between several. When you have a Facebook profile that runs a Page, or two Instagram accounts, try a **Private test** from the phone with each.

## 5. Small things to tell me

- **X Premium:** if Northbound's X has Premium, X takes 16 GB and 4 hours, and the app could stop making smaller copies for it. There's no setting for this yet.
- **TikTok's size limit:** TikTok's help pages don't publish one for the website. If TikTok Studio's upload page shows a maximum size, tell me the number.
- **Live test posts:** I made test posts on Northbound's YouTube (unlisted), X and Facebook, and each was deleted straight after (see the report). Facebook keeps deleted posts in its trash for 30 days: https://www.facebook.com/me/allactivity?category_key=trash, if you want them gone sooner.
- **Facebook's "Review audience" notice:** while posting, the app answered Facebook's one-time "Review audience: all video posts are now reels" notice and a follow-up "Update settings" with **Continue**, which keeps the audience already chosen (Friends on Northbound). Check Facebook's default audience if you want it different.
