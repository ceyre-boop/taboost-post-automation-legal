// Which build of the app this is.
//
// Run from Terminal ("dev"), the app behaves as it always has. The packaged Mac apps swap
// this file at bundle time (desktop/build.mjs):
//   flavor.me.ts      Colin's own copy, for his Mac only.
//   flavor.client.ts  Everyone else's copy. Its default AI is the person's own API key.
export type Flavor = "dev" | "me" | "client";
export const FLAVOR: Flavor = "dev";
export const DEFAULT_AI_MODE: "hosted" | "byo" = "hosted";
