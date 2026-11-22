// Song credit. Creators like Skyler play along to a song and want the artist credited on every
// platform. What each platform's own website offers was checked on 2026-11-22 (see "Music" in
// docs/OFFICIAL-APIS.md): only TikTok's lets the app pick a licensed song from its library and
// set it to 0% (TikTok Studio's Sounds editor, src/platforms/tiktok.ts).
// Elsewhere the app adds a credit line to the caption (withSongCredit in platforms/caption.ts),
// and says plainly what that does and doesn't do.

/** What the person can do on each platform, in the app's words. */
export const MUSIC_HELP: Record<string, string> = {
  tiktok: "TikTok Studio can add a song from TikTok's library, and set it to 0% so only your own sound is heard. TikTok then shows the song on the post.",
  instagram: "Instagram's website has no song picker. Songs are added in the Instagram app.",
  youtube: "YouTube Studio only offers its own free Audio Library, not commercial songs. YouTube finds a song in the video by itself and lists it under the video.",
  x: "X has no music features. The credit line is the way to name the song.",
  facebook: "Facebook's website has no song picker. Songs are added in the Facebook app.",
  linkedin: "LinkedIn has no music features. The credit line is the way to name the song.",
  threads: "Threads has no music features. The credit line is the way to name the song.",
};

/** Said wherever the credit line is offered. Never claims it prevents a copyright claim. */
export const CREDIT_NOTE = "A credit line names the artist. It doesn't license the song, and a platform can still mute, block or claim a video that uses it.";
