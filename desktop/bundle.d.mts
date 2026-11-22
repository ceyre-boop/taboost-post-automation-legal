export const FLAVORS: string[];
export function stripDevOnly(text: string): string;
export function bundle(opts: { flavor: "me" | "client"; outdir: string }): Promise<{ outdir: string; swapped: string[] }>;
