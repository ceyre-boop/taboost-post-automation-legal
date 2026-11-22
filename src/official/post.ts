// One official post: the right publisher for the platform, with a working permission.
import { PROVIDER_OF } from "./connections.ts";
import { tokensFor } from "./oauth.ts";
import { youtubePost } from "./youtube.ts";
import { facebookPost, instagramPost } from "./meta.ts";
import { tiktokPost } from "./tiktok.ts";
import { linkedinPost } from "./linkedin.ts";
import type { Log, OfficialPost, OfficialResult } from "./types.ts";

const PUBLISHERS: Record<string, (t: any, p: OfficialPost, log: Log, clicked: () => void) => Promise<OfficialResult>> = {
  youtube: youtubePost, facebook: facebookPost, instagram: instagramPost, tiktok: tiktokPost, linkedin: linkedinPost,
};
export const hasOfficial = (platform: string) => !!PUBLISHERS[platform];

export async function postOfficial(device: string, platform: string, p: OfficialPost, log: Log, clicked: () => void): Promise<OfficialResult> {
  const publish = PUBLISHERS[platform];
  const provider = PROVIDER_OF[platform];
  if (!publish || !provider) throw new Error(`${platform} has no official posting; it posts from the Mac's browser.`);
  const t = await tokensFor(device, provider);
  return publish(t, p, log, clicked);
}
