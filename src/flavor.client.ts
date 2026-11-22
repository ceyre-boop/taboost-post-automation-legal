// The packaged copy clients get (desktop/build.mjs --flavor=client). See flavor.ts.
export type Flavor = "dev" | "me" | "client";
export const FLAVOR: Flavor = "client";
export const DEFAULT_AI_MODE: "hosted" | "byo" = "byo";
