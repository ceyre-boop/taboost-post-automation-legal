// Remote login screen: lets a phone sign in to a platform inside the Mac's Chrome.
// We open the platform's login page in that profile's Chrome at a phone-sized viewport,
// stream it to the phone as JPEG frames (CDP Page.startScreencast) and replay the
// phone's taps and typing (CDP Input.*). Keystrokes go straight into the real login
// page; nothing here stores or logs them. Popups (e.g. "Continue with Google") are
// followed automatically and the view switches back when they close.
import { launchChrome } from "./chrome.ts";
import type { Profile } from "./config.ts";

export const VIEW_W = 390;
export const VIEW_H = 780;
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

type Listener = (ev: { type: "frame"; data: string } | { type: "info"; url: string; title: string } | { type: "closed" }) => void;

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; }

class RemoteView {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stack: { targetId: string; sessionId: string }[] = []; // top = what the phone sees
  private listeners = new Set<Listener>();
  lastFrame = "";
  closed = false;
  touched = Date.now();

  readonly profile: Profile;
  constructor(profile: Profile) { this.profile = profile; }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, 15_000);
    });
  }

  private get top() { return this.stack[this.stack.length - 1]; }
  private emit: Listener = (ev) => { for (const l of this.listeners) { try { l(ev); } catch {} } };

  async open(url: string): Promise<void> {
    await launchChrome("about:blank", this.profile);
    const ver = await (await fetch(`http://127.0.0.1:${this.profile.port}/json/version`)).json() as { webSocketDebuggerUrl: string };
    this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("could not connect to Chrome"));
    });
    this.ws.onmessage = (m) => this.onMessage(JSON.parse(String(m.data)));
    this.ws.onclose = () => this.shutdownLocal();
    await this.send("Target.setDiscoverTargets", { discover: true });
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    await this.focus(targetId);
    await this.send("Page.navigate", { url }, this.top.sessionId);
  }

  /** Attach to a tab, make it phone-shaped and start streaming it. */
  private async focus(targetId: string): Promise<void> {
    const prev = this.top;
    if (prev) await this.send("Page.stopScreencast", {}, prev.sessionId).catch(() => {});
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.stack.push({ targetId, sessionId });
    await this.send("Page.enable", {}, sessionId);
    await this.send("Emulation.setDeviceMetricsOverride", { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 2, mobile: true }, sessionId);
    await this.send("Emulation.setUserAgentOverride", { userAgent: MOBILE_UA, platform: "iPhone" }, sessionId);
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId).catch(() => {});
    await this.startCast();
  }

  private async startCast(): Promise<void> {
    const t = this.top; if (!t) return;
    await this.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEW_W * 2, maxHeight: VIEW_H * 2, everyNthFrame: 1 }, t.sessionId);
  }

  private onMessage(msg: any): void {
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!; this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    const t = this.top;
    switch (msg.method) {
      case "Page.screencastFrame":
        this.send("Page.screencastFrameAck", { sessionId: msg.params.sessionId }, msg.sessionId).catch(() => {});
        if (t && msg.sessionId === t.sessionId) { this.lastFrame = msg.params.data; this.emit({ type: "frame", data: msg.params.data }); }
        break;
      case "Target.targetCreated": {
        const info = msg.params.targetInfo;
        // A popup opened by the page she's looking at (e.g. Google sign-in): follow it.
        if (info.type === "page" && t && info.openerId === t.targetId) this.focus(info.targetId).catch(() => {});
        break;
      }
      case "Target.targetInfoChanged": {
        const info = msg.params.targetInfo;
        if (t && info.targetId === t.targetId) this.emit({ type: "info", url: info.url, title: info.title });
        break;
      }
      case "Target.targetDestroyed": {
        const i = this.stack.findIndex((s) => s.targetId === msg.params.targetId);
        if (i < 0) break;
        const wasTop = i === this.stack.length - 1;
        this.stack.splice(i, 1);
        if (!this.stack.length) { this.close(); break; }
        if (wasTop) this.startCast().catch(() => {}); // popup closed → back to the login page
        break;
      }
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    if (this.lastFrame) l({ type: "frame", data: this.lastFrame });
    return () => this.listeners.delete(l);
  }

  /** Phone input. x/y are 0..1 fractions of the streamed picture. */
  async input(ev: { type: string; x?: number; y?: number; dy?: number; text?: string; key?: string }): Promise<void> {
    const t = this.top; if (!t) throw new Error("sign-in window is closed");
    this.touched = Date.now();
    const s = t.sessionId;
    const px = Math.round((ev.x ?? 0) * VIEW_W), py = Math.round((ev.y ?? 0) * VIEW_H);
    if (ev.type === "tap") {
      await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: px, y: py }] }, s);
      await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s);
    } else if (ev.type === "scroll") {
      await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: px, y: py, deltaX: 0, deltaY: ev.dy ?? 0 }, s);
    } else if (ev.type === "text" && ev.text) {
      await this.send("Input.insertText", { text: ev.text }, s);
    } else if (ev.type === "key" && ev.key) {
      const codes: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13 };
      const vk = codes[ev.key]; if (!vk) return;
      const base = { key: ev.key, code: ev.key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(ev.key === "Enter" ? { text: "\r" } : {}) }, s);
      if (ev.key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" }, s);
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, s);
    } else if (ev.type === "back") {
      await this.send("Runtime.evaluate", { expression: "history.back()" }, s);
    }
  }

  private shutdownLocal(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit({ type: "closed" });
    this.listeners.clear();
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }

  /** Close the sign-in tabs (the session cookies stay in the profile). */
  close(): void {
    const ids = this.stack.map((s) => s.targetId);
    this.stack = [];
    for (const id of ids) { try { this.ws.send(JSON.stringify({ id: this.nextId++, method: "Target.closeTarget", params: { targetId: id } })); } catch {} }
    setTimeout(() => { try { this.ws.close(); } catch {} }, 300);
    this.shutdownLocal();
  }
}

// One sign-in view per profile.
const views = new Map<string, RemoteView>();

export async function openView(profile: Profile, url: string): Promise<RemoteView> {
  views.get(profile.dir)?.close();
  const v = new RemoteView(profile);
  views.set(profile.dir, v);
  try { await v.open(url); }
  catch (e) { v.close(); views.delete(profile.dir); throw e; }
  return v;
}

export function getView(profile: Profile): RemoteView | null {
  const v = views.get(profile.dir);
  return v && !v.closed ? v : null;
}

export function closeView(profile: Profile): void {
  views.get(profile.dir)?.close();
  views.delete(profile.dir);
}

// Abandoned sign-in screens close themselves after 15 idle minutes.
setInterval(() => {
  for (const [k, v] of views) if (v.closed || Date.now() - v.touched > 15 * 60_000) { v.close(); views.delete(k); }
}, 60_000).unref();
