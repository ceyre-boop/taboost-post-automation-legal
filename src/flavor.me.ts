// Colin's own packaged copy (desktop/build.mjs --flavor=me). See flavor.ts.
export type Flavor = "dev" | "me" | "client";
export const FLAVOR: Flavor = "me";
export const DEFAULT_AI_MODE: "hosted" | "byo" = "byo";
