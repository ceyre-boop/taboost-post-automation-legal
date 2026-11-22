// The client build's provider: there is none. See dev-provider.ts.
export interface DevProvider { mode: string; label: string; think(system: string, user: string, plain: (msg: string) => Error): Promise<{ text: string; model: string; input: number; output: number }>; }
export const devProvider = (): DevProvider | null => null;
