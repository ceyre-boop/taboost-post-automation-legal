# Official APIs vs the browser: what each platform allows

Written 2026-11-22 for Post Everywhere. Every figure below comes from the platform's own help or developer pages, read that day; the link is next to it. Where a platform publishes nothing, this says so instead of guessing.

**As built (after rebasing on `video-maker`):** the app now has both paths. `video-maker` added official sign-in and publishers in `src/official/` (YouTube resumable upload, Facebook Page Reels, Instagram Reels for Creator/Business accounts, TikTok uploads to the inbox as drafts, LinkedIn), connected from the phone, with tokens in the macOS Keychain; the browser path covers everything else (personal Facebook profiles and Instagram accounts, X, Threads, and any platform not connected). Setup: README.md, "Setting it up". The recommendations below were written before that landed and still hold as the reasoning for which path to prefer.

**The short answer**

| Platform | Recommendation | Why |
|---|---|---|
| YouTube | **Both. API first, browser as the fallback.** Built on `video-maker` (`src/official/youtube.ts`, resumable), switched on by keys. | Since 2026-11-02 an unverified API project's uploads are no longer forced private, and an upload costs 1 unit of a 100-a-day bucket. Signing in happens on Google's own page in the person's normal browser, so Google's "this browser may not be secure" block doesn't apply. |
| TikTok | **Browser.** | Until TikTok audits the app, API posts are private-only, to at most 5 users a day, and TikTok's audit rejects tools that post to accounts you or your team manage. |
| Instagram | **Browser now; API later for business clients.** | Needs a professional (business or creator) account, App Review with Advanced Access and Business Verification. A personal account can't use it at all. |
| Facebook | **Browser.** | The API posts to Pages only; it has not been able to post to a personal profile since 2018. Skyler's personal profile could never be reached by API. |
| X | **Browser.** | No free tier: $0.015 a post, paid up front, plus the developer account. The browser path works today. |
| LinkedIn | **Browser now; API possible for a person's own profile.** | "Share on LinkedIn" is self-serve and posts video as the member. Company pages need the Community Management API review. |
| Threads | **Browser.** | App Review for `threads_content_publish`; the API needs the video at a public web address. |

Music: no API lets an app add a licensed commercial song (the kind that credits the artist) to a post. TikTok's website does, and the app uses it. See "Music" at the end.

---

## Upload limits on each website (what the app checks before posting)

The app takes any size of video. When a platform takes less than the clip, it posts a smaller copy there (made with macOS's own `avconvert`) and the original everywhere else, and says so in the progress grid. These numbers live in `src/platforms/limits.ts`.

| Platform | Largest file | Longest video | Other | Source (quote) |
|---|---|---|---|---|
| TikTok | Not published for the website | 60 minutes | | [TikTok Support, Camera tools](https://support.tiktok.com/en/using-tiktok/creating-videos/camera-tools): "Videos you upload in TikTok can be up to 60 minutes long." The website upload help ([Making a post](https://support.tiktok.com/en/using-tiktok/creating-videos/making-a-post)) gives no size. TikTok Studio showed our 3.28 GB, 5-minute 4K test file uploading and accepted it. |
| Instagram | Not published | 20 minutes | aspect 1.91:1 to 9:16, at least 30 fps and 720 px | [Record a reel](https://help.instagram.com/225190788256708): "You can record and edit videos up to 20 minutes with Instagram Reels." [Reel size](https://help.instagram.com/1038071743007909): "aspect ratio between 1.91:1 and 9:16 ... minimum frame rate of 30 FPS ... minimum resolution of 720 pixels." |
| YouTube | 256 GB | 12 hours (15 minutes until the account is verified) | | [Upload videos longer than 15 minutes](https://support.google.com/youtube/answer/71673): "The maximum file size you can upload is 256 GB or 12 hours, whichever is less." "By default, you can upload videos that are up to 15 minutes long." |
| X | 512 MB (Premium: 16 GB) | 2 min 20 s (Premium: 4 hours on x.com) | Premium over 2 hours must be 720p | [How to share videos on X](https://help.x.com/en/using-x/x-videos): "If you aren't subscribed to X Premium ... you can still upload videos up to 140 seconds long with a maximum file size of 512MB." "...upload videos shorter than 4 hours at 1080p with a maximum file size of 16GB." [Premium longer videos](https://help.x.com/en/using-x/premium-longer-videos). |
| Facebook | 10 GB | 240 minutes | Since June 2025 every video is a reel, "any length or orientation" | Meta's business help [How to upload videos](https://www.facebook.com/business/help/163131210928551) (10 GB, under 240 minutes; that page now redirects to the Reels help). [Creators blog](https://creators.facebook.com/blog/making-it-easier-to-create-videos-on-facebook): "Facebook Reels won't have any length or format restrictions after this change." |
| LinkedIn | 5 GB | 15 minutes | at least 3 s on desktop; 192 Kbps to **30 Mbps**; 10 to 60 fps; up to 4096×2304 | [Video sharing troubleshooting](https://www.linkedin.com/help/linkedin/answer/a548372): "Maximum file size: 5 GB ... Maximum video duration: 15 minutes ... Minimum video duration: 3 seconds when uploading from desktop ... Bit rates: 192 Kbps - 30 Mbps". A phone's 4K clip is often 50 to 100 Mbps, so LinkedIn usually gets a lighter copy. |
| Threads | 1 GB (not on a help page) | 5 minutes | | [Threads for Creators](https://creators.instagram.com/threads): "photos and videos, up to 5 minutes long." The 1 GB figure is from Meta's own assistant account on Threads, not a help page, so the app treats it as a cautious limit. |

What the app does with them (`planFor` in `src/platforms/limits.ts`):

- Bigger or longer than the platform takes: a smaller copy, cut to the platform's length if it's too long. X gets "X takes videos up to 512 MB and 2 min 20 s; this one got a smaller copy. It was cut to the first 2 min 20 s."
- A higher bit rate than LinkedIn processes: a lighter copy.
- Shorter than LinkedIn's 3 seconds: refused before posting, in those words (a copy can't fix it).
- X Premium's higher limits apply when the person says their X account has Premium (not built as a setting yet; see the checklist).
- YouTube's 15-minute limit for unverified channels isn't applied: the app can't tell whether a channel is verified, and YouTube says so on its own upload page when it applies.

Tested 2026-11-22 through the app's own server: a 1.1 GB, 90-second H.264 clip and a 3.3 GB, 5-minute 4K HEVC clip. X got copies of 172 MB and 178 MB (the second cut to 2 min 20 s, made in 25 seconds); YouTube, Facebook and TikTok took the originals.

---

## YouTube Data API

**What posting needs**
- A Google Cloud project with the YouTube Data API v3 switched on, and an OAuth client of type "Desktop app". No app review to start.
- The person signs in to Google once, in their normal browser, and allows "Manage your YouTube videos" (`youtube.upload`). The app keeps the refresh token in the set's folder, readable only by that Mac user.
- Unverified projects: "Videos uploaded from unverified API projects are not restricted to private viewing mode." ([videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert); the change is dated November 2, 2026 in the [revision history](https://developers.google.com/youtube/v3/revision_history), reversing the July 2020 rule.)

**Consent screen states** ([Manage app audience](https://support.google.com/cloud/answer/15549945))
- *Testing*: up to 100 listed test users, and "authorizations by a test user expire seven days from the time of consent", refresh token included. That would mean signing in again every week, so it is only for trying it out.
- *In production, unverified*: users see Google's "unverified app" warning, and there is a hard cap of 100 users in total. No weekly sign-in. Good enough for Colin's own channels and a first handful of clients.
- Google's device-code sign-in (a code typed at google.com/device) also allows the `youtube` scope ([limited-input devices](https://developers.google.com/identity/protocols/oauth2/limited-input-device)); it would let a phone or the Mac connect without any redirect page. `video-maker` uses the redirect flow through northbound-dev.com instead.
- *Verified*: no warning, no cap. Needs brand verification and sensitive-scope verification (privacy policy on a verified domain, a demo video). Allow days to a few weeks.
- A Workspace admin can mark the app Trusted for that organisation's own accounts, which lifts the 7-day and 100-user limits for them.

**Quota and cost**
- `videos.insert`: "a quota cost of 1 unit in the Video Uploads quota bucket" ([videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)); the default bucket is 100 uploads a day per project (Google's quota page; more by a compliance audit). Deleting a video costs 50 units of the separate 10,000-unit daily bucket.
- Free. Max file 256 GB.

**What it can't do**
- No music from YouTube's Audio Library, and no Shorts music. A vertical video of 3 minutes or less becomes a Short by itself.
- Brand-account channels: the person picks the channel on Google's consent screen.

**Recommendation: API, browser as the fallback. Built** (on `video-maker`). It removes the three YouTube problems seen this week: Google blocking sign-in in an automated Chrome, drafts left behind by a preview, and Studio's page changing under the app. The browser path keeps working without keys, and its previews now delete the draft Studio keeps. Colin's steps: README.md "Setting it up", summarised in `docs/COLIN-CHECKLIST.md`.

---

## TikTok Content Posting API

**What posting needs**
- A TikTok developer account and app with Login Kit and the Content Posting API, the `video.publish` scope (Direct Post) or `video.upload` (send to the creator's inbox to finish in the app).
- "As a developer, you can use this API in an unverified status, but all content uploaded via this endpoint will be restricted to private viewing mode. To lift this restriction, your API client must undergo an audit." ([Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post))
- "Unaudited API Clients can allow up to 5 users to post in a 24 hour window. All user accounts using the API client to post must be set to private at the time of posting." (same page)
- The audit's [content sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines) list as **not acceptable**: "A utility tool to help upload contents to the account(s) you or your team manages." Post Everywhere for clients is a wider tool, but the audit is a real risk.

**Quotas, cost, time**: free; the audit's turnaround isn't published. File size up to 4 GB through the API ([media transfer guide](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide)).

**What it can't do**: add a sound from TikTok's library. The "upload to inbox" mode hands the video to the TikTok app, where the creator finishes it in TikTok's own editor (that is where a song from TikTok's library can be added).

**Recommendation: browser.** TikTok Studio's web upload took our 3.28 GB 4K file and holds Post until the upload and its own checks are finished. Revisit the API only for the inbox mode, which fits the "add the song in TikTok" case.

---

## Instagram (Instagram API with Instagram Login, or with Facebook Login)

**What posting needs**
- An Instagram **professional** account (business or creator). Personal accounts can't post through the API.
- With Instagram Login: no Facebook Page needed ([Instagram API with Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login)). With Facebook Login: the account linked to a Page.
- Permission `instagram_business_content_publish` (or `instagram_content_publish`). For accounts the developer doesn't own or manage: App Review for Advanced Access and Business Verification ([Content Publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)).
- Reels: `media_type=REELS` with the video at a public web address (`video_url`), or a resumable upload, which the page says is "Only for apps that have implemented Facebook Login for Business."

**Quotas**: "100 API-published posts within a 24-hour moving period" (the same page also says 50 elsewhere). Free.

**What it can't do**: post for a personal account; add a licensed song. The Instagram Audio API (June 2026, Facebook Login only) attaches royalty-free music from Meta's Sound Collection or original sounds, not commercial tracks ([changelog](https://developers.facebook.com/documentation/instagram-platform/changelog/)). `audio_name` only renames the reel's own audio.

**Recommendation: browser now.** Revisit for business clients once Colin has a verified Meta business and wants to go through App Review.

---

## Facebook (Pages API, Reels Publishing API)

**What posting needs**
- A Page access token from someone who can create content on the Page; permissions `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` ([Reels Publishing API](https://developers.facebook.com/documentation/video-api/guides/reels-publishing)). App Review for Advanced Access when the Pages aren't the developer's own.
- "You can only publish Reels to Facebook Pages." Personal profiles: the `publish_actions` permission was removed in 2018 and nothing replaced it.

**Quotas**: "30 API-published posts within a 24-hour moving period" per Page for reels; reels via the API are 3 to 90 seconds.

**What it can't do**: post to a personal profile (Skyler's case); longer than 90-second reels; add a song (the [music recommendations](https://developers.facebook.com/documentation/video-api/guides/music-recommendations) endpoint returns titles and artists but has no way to attach one).

**Recommendation: browser.** The browser posts to a profile or to a Page (the app switches to the chosen one first), with no 90-second cap.

---

## X API

**What posting needs**: a developer account and app, OAuth 2.0 user sign-in with `tweet.write` and `media.write`.

**Cost**: "pay-per-usage pricing", credits bought in advance; "Post: Create" is $0.015 a request ([pricing](https://docs.x.com/x-api/getting-started/pricing)). The pricing page doesn't describe a free tier for new developers. Video goes through the chunked media upload first.

**What it can't do**: music; anything the account itself can't (the 512 MB / 140 s limits still apply without Premium).

**Recommendation: browser.** It already posts and deletes reliably, costs nothing, and X's page has stable `data-testid` hooks.

---

## LinkedIn

**What posting needs**
- As a person: the self-serve "Share on LinkedIn" product gives `w_member_social`; video is registered, uploaded, then posted with `shareMediaCategory: VIDEO` ([Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)). Limit 150 requests a member a day.
- As a company page: `w_organization_social`, only through the Community Management API, which needs an application and review ([Getting access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access)); the member must be an admin or content admin of the page.
- LinkedIn access tokens last 60 days, so the person signs in again every two months unless refresh tokens are granted.

**Recommendation: browser now; the member API is the cheapest one to add later** (self-serve, no review) if LinkedIn's page becomes a problem. Company pages stay on the browser (the app switches to the page first).

---

## Threads API

**What posting needs**: a Meta app with the Threads use case, `threads_basic` and `threads_content_publish`, App Review with a screencast ([permissions](https://developers.facebook.com/docs/permissions)). Video posts take a public `video_url`; Meta suggests waiting about 30 seconds before publishing ([Threads posts](https://developers.facebook.com/documentation/threads/posts)).

**Quotas**: "250 API-published posts within a 24-hour moving period" ([overview](https://developers.facebook.com/documentation/threads/overview)). Free.

**Recommendation: browser.** The API's public-address rule means hosting each video on the internet first.

---

## Music: adding a song, credited, at 0%

What creators like Skyler want: the song shows on the post (the artist is credited, and the platform knows it's licensed), with the song's volume at 0 so only her own drumming is heard.

| Platform | On its website | Through its API |
|---|---|---|
| TikTok | **Yes.** TikTok Studio's upload page has a **Sounds** button that opens its editor: search TikTok's library (commercial songs, for example "The Final Countdown · Europe"), add one as its own track, and mute that track ("-∞ dB") so only the video's own sound plays. Seen and used 2026-11-22 on Northbound's TikTok; its "Music copyright check" said "No issues found". | No. The inbox mode sends the video to the app, where a song can be added. |
| Instagram | No song picker in the web composer. | Royalty-free Sound Collection and original sounds only (Facebook Login). |
| YouTube | Studio's Editor adds tracks from YouTube's Audio Library (free tracks, not commercial songs). Shorts songs are phone-app only. | No. |
| Facebook | No song picker in the web composer. | No way to attach a recommended song. |
| X, LinkedIn, Threads | No music features. | No. |

What the app does (built on the Post screen, "Song in this video"): the person types the song once.

- **TikTok:** the app adds it from TikTok's library in TikTok Studio's editor, at 0% when "only my own sound" is ticked, and TikTok shows the song on the post. It only takes a result whose title and artist match; otherwise it posts without a song and says so (a wrong song would credit the wrong artist). Previewed for real on 2026-11-22; not posted live (Northbound's TikTok is signed in as @taboost.colin, see the checklist).
- **Every platform:** an optional credit line, "Song: The Final Countdown by Europe", added to the caption of the platforms chosen (on X the caption is shortened so it still fits in 280).
- The app says plainly that a credit line names the artist, doesn't license the song, and doesn't stop a platform's copyright check from muting, blocking or claiming the video. For a credited song at 0% on Instagram or Facebook, the person adds it in that platform's phone app.

The other web uploaders were checked for a song picker: YouTube Studio offers only its free Audio Library (in its separate Editor, after upload); Instagram's, Facebook's, X's, LinkedIn's and Threads' web composers have none.
