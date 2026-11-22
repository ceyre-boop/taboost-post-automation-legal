// node --test src/maker/maker.test.ts
// The post maker without the server: the brief, the checks, writing ideas and scripts
// (with a stand-in model), the AI modes and cost log, and what can never happen.
import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "pe-maker-"));
process.env.POSTER_APP_DIR = DIR;
for (const k of ["POSTER_DEV_MAX", "NORTHBOUND_AI_ENDPOINT", "NORTHBOUND_CLIENT_TOKEN", "ANTHROPIC_API_KEY", "POSTER_ANTHROPIC_BASE_URL"]) delete process.env[k];

const ai = await import("./ai.ts");
const brief = await import("./brief.ts");
const checks = await import("./checks.ts");
const write = await import("./write.ts");
const store = await import("./store.ts");
const make = await import("./make.ts");

const B = {
  business: "Ridge Roofing", whatYouDo: "We repair and replace roofs for homeowners in Lansing.", audience: "Homeowners in Lansing",
  facts: "We have replaced 412 roofs since 2015\nMost repairs are done in 1 day\nEvery job is cleaned up the same day", avoid: "cheap\nbest", cta: "Call for a free quote", color: "#C8102E", mood: "bold",
};
const PLATFORMS = ["tiktok", "instagram", "youtube", "x", "facebook", "linkedin", "threads"];
const goodScript = () => ({
  hook: "Your roof is talking", points: ["Most repairs are done in 1 day", "We have replaced 412 roofs since 2015"], cta: "Call for a free quote",
  platforms: Object.fromEntries(PLATFORMS.map((p) => [p, { caption: p === "youtube" ? "Is your roof talking to you?\nMost repairs take 1 day." : "Most repairs are done in 1 day. Call for a free quote.", hashtags: ["#roofing", "#lansing"] }])),
});

/* ---------------- the brief ---------------- */

test("a brief needs a name, what they do, customers, 3 facts and a call to action, and is cleaned", () => {
  const b = brief.validateBrief(B);
  assert.deepEqual(b.facts.length, 3);
  assert.deepEqual(b.avoid, ["cheap", "best"]);
  assert.equal(b.color, "#c8102e");
  assert.equal(b.mood, "bold");
  assert.throws(() => brief.validateBrief({ ...B, business: "" }), /business name/);
  assert.throws(() => brief.validateBrief({ ...B, facts: "one\ntwo" }), /at least 3 facts/);
  assert.throws(() => brief.validateBrief({ ...B, cta: "" }), /what you want people to do/);
  assert.equal(brief.validateBrief({ ...B, color: "red; background:url(x)" }).color, "#4f5bd5");
  assert.equal(brief.validateBrief({ ...B, mood: "evil" }).mood, "upbeat");
  assert.equal(brief.validateBrief({ ...B, facts: "- a fact with a dash\n• a bullet fact\n\n* star fact" }).facts[0], "a fact with a dash");
});

test("each set of accounts keeps its own brief and photos", () => {
  brief.saveBrief("", B);
  brief.saveBrief("northbound", { ...B, business: "Northbound" });
  assert.equal(brief.readBrief("")!.business, "Ridge Roofing");
  assert.equal(brief.readBrief("northbound")!.business, "Northbound");
  assert.match(brief.makerDir("northbound"), /accounts\/northbound\/maker$/);
  assert.equal(brief.makerDir("../../etc"), join(DIR, "accounts", "etc", "maker"));
});

/* ---------------- photos ---------------- */

const JPG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("photos are judged by their bytes, not their names, and saved under app-made names", () => {
  assert.equal(brief.sniff(JPG), "jpg");
  assert.equal(brief.sniff(PNG), "png");
  assert.equal(brief.sniff(Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(brief.sniff(Buffer.from("GIF89a...")), null);
  const n = brief.savePhoto("", JPG);
  assert.match(n, /^p-[a-f0-9]{12}\.jpg$/);
  assert.throws(() => brief.savePhoto("", Buffer.from("not a photo at all")), /isn't a photo/);
  assert.throws(() => brief.savePhoto("", Buffer.alloc(brief.LIMITS.photoBytes + 1, 0xff)), /over 25 MB/);
  assert.equal(brief.savePhoto("", PNG, true), "logo.png");
  assert.equal(brief.logoName(""), "logo.png");
  assert.equal(brief.removePhoto("", "../brief.json"), false);
  assert.equal(brief.removePhoto("", "logo.png"), true);
  assert.equal(brief.logoName(""), "");
});

test("an iPhone HEIC photo is converted to JPEG with the Mac's own tool", { skip: process.platform !== "darwin" }, () => {
  const src = join(DIR, "src.png"), heic = join(DIR, "src.heic");
  writeFileSync(src, PNG);
  const made = spawnSync("/usr/bin/sips", ["-s", "format", "heic", src, "--out", heic], { stdio: "ignore" });
  if (made.status !== 0 || !existsSync(heic)) return; // this Mac can't write HEIC; nothing to test
  const bytes = readFileSync(heic);
  assert.equal(brief.sniff(bytes), "heic");
  const n = brief.savePhoto("", bytes);
  assert.match(n, /\.jpg$/);
  assert.equal(brief.sniff(readFileSync(join(brief.photosDir(""), n))), "jpg");
  assert.equal(readdirSync(brief.photosDir("")).filter((f) => f.startsWith(".upload")).length, 0); // the temp copy is gone
});

test("making needs a brief and at least 3 photos", () => {
  assert.match(brief.notReady("nobody"), /business details/);
  for (const n of brief.listPhotos("")) brief.removePhoto("", n);
  brief.savePhoto("", JPG); brief.savePhoto("", JPG);
  assert.match(brief.notReady(""), /at least 3 photos or clips \(you have 2\)/);
  brief.savePhoto("", JPG);
  assert.equal(brief.notReady(""), "");
});

/* ---------------- the checks ---------------- */

const BR = () => brief.validateBrief(B);

test("a good script passes", () => {
  assert.deepEqual(checks.scriptProblems(goodScript(), BR(), PLATFORMS), []);
});

test("a number that isn't in the facts is refused, however it's written", () => {
  const s = goodScript(); s.points[0] = "Repairs take 2 hours";
  assert.match(checks.scriptProblems(s, BR(), PLATFORMS).join("\n"), /"2" is not in the business's facts/);
  const t = goodScript(); t.platforms.x.caption = "Only $99 this week!";
  assert.match(checks.scriptProblems(t, BR(), PLATFORMS).join("\n"), /"\$99" is not/);
  const ok = goodScript(); ok.points[0] = "412 roofs and counting";
  assert.deepEqual(checks.scriptProblems(ok, BR(), PLATFORMS), []);
});

test("never-say words and unbacked claims are refused; the call to action's own words are allowed", () => {
  const s = goodScript(); s.hook = "The best roofers around";
  assert.match(checks.scriptProblems(s, BR(), PLATFORMS).join("\n"), /"best", which the business said never to use/);
  const g = goodScript(); g.points[1] = "Every repair is guaranteed for life";
  assert.match(checks.scriptProblems(g, BR(), PLATFORMS).join("\n"), /claims "guaranteed"/);
  const l = goodScript(); l.platforms.instagram.caption = "Licensed and insured roofers.";
  assert.match(checks.scriptProblems(l, BR(), PLATFORMS).join("\n"), /claims "Licensed"/);
  assert.deepEqual(checks.scriptProblems(goodScript(), BR(), PLATFORMS).filter((p) => /free/.test(p)), []); // "free quote" is in their call to action
  const f = goodScript(); f.platforms.linkedin.caption = "Feel free to call us.";
  assert.deepEqual(checks.scriptProblems(f, BR(), PLATFORMS), []);
});

test("on-screen text must fit and every platform needs a caption within its limit", () => {
  const s = goodScript(); s.hook = "This is a hook that is far too long to read";
  assert.match(checks.scriptProblems(s, BR(), PLATFORMS).join("\n"), /hook is 11 words/);
  const p = goodScript(); p.points = [];
  assert.match(checks.scriptProblems(p, BR(), PLATFORMS).join("\n"), /1 to 3 points/);
  const x = goodScript(); x.platforms.x.caption = "a".repeat(270);
  assert.match(checks.scriptProblems(x, BR(), PLATFORMS).join("\n"), /x: the caption with hashtags is \d+ characters; x allows 280/);
  const y = goodScript(); y.platforms.youtube.caption = "T".repeat(120) + "\nmore";
  assert.match(checks.scriptProblems(y, BR(), PLATFORMS).join("\n"), /youtube: the first line is the video title/);
  const m = goodScript(); delete (m.platforms as Record<string, unknown>).threads;
  assert.match(checks.scriptProblems(m, BR(), PLATFORMS).join("\n"), /no caption for threads/);
  const h = goodScript(); h.platforms.tiktok.hashtags = ["#has space"];
  assert.match(checks.scriptProblems(h, BR(), PLATFORMS).join("\n"), /isn't a usable hashtag/);
  const b = goodScript(); b.points[0] = "Call [Name] today";
  assert.match(checks.scriptProblems(b, BR(), PLATFORMS).join("\n"), /blank like \[Name\]/);
  assert.equal(checks.fullCaption({ caption: "Hello", hashtags: ["roof", "#lansing"] }), "Hello\n\n#roof #lansing");
});

test("videos stay between 10 and 30 seconds", () => {
  const s = goodScript();
  const secs = checks.videoSeconds(s);
  assert.ok(secs >= 10 && secs <= 30, `got ${secs}`);
  assert.equal(checks.cardSeconds("x", "hook"), 2.8);
  assert.equal(checks.cardSeconds("one two three four five six seven eight nine ten eleven twelve thirteen fourteen", "point"), 5.5);
});

/* ---------------- writing, with a stand-in model ---------------- */

afterEach(() => ai.setThinker(null));

test("ideas: each tied to a real fact, fresh against what was posted, at most six", async () => {
  ai.setThinker(async (task) => {
    assert.equal(task, "ideas");
    return JSON.stringify({ ideas: [
      { title: "Why most roof repairs take one day", angle: "a", fact: 2 },
      { title: "Why most roof repairs take only one day", angle: "a near copy", fact: 2 },
      { title: "412 roofs later: what we learned", angle: "b", fact: 1 },
      { title: "A fact that does not exist", angle: "c", fact: 9 },
      { title: "", angle: "no title", fact: 1 },
      { title: "The clean-up nobody talks about", angle: "d", fact: 3 },
      { title: "Storm season checklist for homeowners", angle: "e", fact: 1 },
    ] });
  });
  const ideas = await write.suggestIdeas(BR(), ["The clean-up nobody talks about"]);
  assert.deepEqual(ideas.map((i) => i.title), ["Why most roof repairs take one day", "412 roofs later: what we learned", "Storm season checklist for homeowners"]);
  assert.deepEqual(ideas.map((i) => i.fact), [1, 0, 0]);
});

test("a script that fails the checks goes back once with the problems, then passes", async () => {
  const prompts: string[] = [];
  ai.setThinker(async (task, _s, user) => {
    assert.equal(task, "script");
    prompts.push(user);
    if (prompts.length === 1) { const bad = goodScript(); bad.points[0] = "Repairs take 2 hours"; return JSON.stringify(bad); }
    return "Here it is:\n```json\n" + JSON.stringify(goodScript()) + "\n```";
  });
  const s = await write.writeScript(BR(), { title: "t", angle: "a", fact: 1 }, PLATFORMS);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /YOUR LAST DRAFT FAILED THESE CHECKS[\s\S]*"2" is not in the business's facts/);
  assert.equal(s.points[0], "Most repairs are done in 1 day");
  assert.deepEqual(Object.keys(s.platforms), PLATFORMS);
});

test("a script that fails twice makes nothing, and says why in plain words", async () => {
  ai.setThinker(async () => { const bad = goodScript(); bad.hook = "Only $49 roof checks this week"; return JSON.stringify(bad); });
  await assert.rejects(write.writeScript(BR(), { title: "t", angle: "a", fact: 0 }, PLATFORMS), (e: any) => /couldn't write a post that passed its checks/.test(e.plain));
});

test("hashtags come back normalised, and a missing platform is caught", async () => {
  ai.setThinker(async () => { const s = goodScript() as any; s.platforms.x.hashtags = ["roofing", "  #lansing "]; delete s.platforms.linkedin; return JSON.stringify(s); });
  await assert.rejects(write.writeScript(BR(), { title: "t", angle: "a", fact: 0 }, PLATFORMS), (e: any) => /no caption for linkedin/.test(e.plain));
  ai.setThinker(async () => { const s = goodScript() as any; s.platforms.x.hashtags = ["roofing", "  #lansing "]; return JSON.stringify(s); });
  const s = await write.writeScript(BR(), { title: "t", angle: "a", fact: 0 }, PLATFORMS);
  assert.deepEqual(s.platforms.x.hashtags, ["#roofing", "#lansing"]);
});

/* ---------------- made posts and render jobs ---------------- */

test("a made post is stored per set, its render job has a photo per card and an end card", () => {
  const p = store.newMade("", { title: "Why most roof repairs take one day", angle: "a", fact: 1 }, PLATFORMS);
  assert.ok(store.isMadeId(p.id));
  assert.equal(store.isMadeId("../x"), false);
  p.script = goodScript();
  p.photos = make.pickPhotos(["a.jpg", "b.jpg", "c.jpg"], 3, 42);
  const job = make.buildJob(p, BR(), "logo.png");
  assert.deepEqual(job.cards.map((c) => c.kind), ["hook", "point", "point", "end"]);
  assert.ok(job.cards.filter((c) => c.kind !== "end").every((c) => c.photo));
  assert.equal(new Set(job.cards.filter((c) => c.photo).map((c) => c.photo)).size, 3);
  assert.equal(job.cards.at(-1)!.text, "Call for a free quote");
  assert.equal(job.logo, "logo.png");
  assert.deepEqual(make.pickPhotos(["a", "b", "c"], 3, 42), make.pickPhotos(["a", "b", "c"], 3, 42)); // the same post looks the same if re-rendered
  store.saveMade(p);
  assert.equal(store.listMade("").length, 1);
  assert.equal(store.listMade("northbound").length, 0);
  store.discardMade("", p.id);
  assert.deepEqual(store.usedTitles(""), ["Why most roof repairs take one day"]); // a thrown-away idea isn't suggested again
});

/* ---------------- the AI modes and the cost log ---------------- */

const seen: { body: any; headers: Record<string, any> }[] = [];
const readBody = (req: IncomingMessage) => new Promise<string>((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s)); });
const backend = createServer(async (req, res) => { seen.push({ body: JSON.parse(await readBody(req)), headers: req.headers }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: '{"ideas":[]}', model: "claude-haiku-5-5", usage: { input_tokens: 300, output_tokens: 40 } })); });
const anthropic = createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  seen.push({ body, headers: req.headers });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1000, output_tokens: 200 } }));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => anthropic.listen(0, "127.0.0.1", r));
const port = (s: typeof backend) => (s.address() as { port: number }).port;
after(() => { backend.close(); anthropic.close(); });
beforeEach(() => { seen.length = 0; for (const k of ["POSTER_DEV_MAX", "NORTHBOUND_AI_ENDPOINT", "NORTHBOUND_CLIENT_TOKEN", "ANTHROPIC_API_KEY", "POSTER_ANTHROPIC_BASE_URL"]) delete process.env[k]; ai.forgetApiKey(); });
const KEY = "sk-ant-" + "p".repeat(40);
const plain = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { return (e as { plain?: string }).plain ?? String(e); } };

test("a new install is in Hosted mode, and with no backend it says so and calls nothing", async () => {
  assert.equal(ai.readMode(), "hosted");
  assert.equal(ai.aiStatus().ready, false);
  assert.match(await plain(ai.think("ideas", "s", "u")), /Northbound hosting isn't set up yet/);
  assert.equal(seen.length, 0);
});

test("Hosted sends the task and text to NORTHBOUND_AI_ENDPOINT with the client's token, never a model key", async () => {
  process.env.NORTHBOUND_AI_ENDPOINT = `http://127.0.0.1:${port(backend)}/v1/think`;
  process.env.NORTHBOUND_CLIENT_TOKEN = "tok-1";
  await ai.think("ideas", "SYS", "USER", "hosted");
  assert.deepEqual(seen[0].body, { app: "post-everywhere", task: "ideas", system: "SYS", user: "USER" });
  assert.equal(seen[0].headers.authorization, "Bearer tok-1");
  assert.equal(seen[0].headers["x-api-key"], undefined);
  for (const bad of ["http://evil.example/x", "nope"]) { process.env.NORTHBOUND_AI_ENDPOINT = bad; assert.equal(ai.hostedEndpoint().url, ""); }
});

test("BYO-key uses the client's key: Haiku for ideas, Sonnet for the script, no tools", async () => {
  process.env.POSTER_ANTHROPIC_BASE_URL = `http://127.0.0.1:${port(anthropic)}`;
  ai.saveApiKey(KEY);
  assert.equal(statSync(join(DIR, "secrets.json")).mode & 0o777, 0o600);
  await ai.think("ideas", "s", "u", "byo");
  await ai.think("script", "s", "u", "byo");
  assert.deepEqual(seen.map((s) => s.body.model), ["claude-haiku-5-5", "claude-sonnet-5-5"]);
  for (const s of seen) {
    assert.equal(s.headers["x-api-key"] ?? String(s.headers.authorization).replace(/^Bearer /, ""), KEY);
    assert.equal(s.body.tools, undefined);
  }
});

test("each request is logged with tokens and estimated cost, and the log holds no text or key", async () => {
  process.env.POSTER_ANTHROPIC_BASE_URL = `http://127.0.0.1:${port(anthropic)}`;
  ai.saveApiKey(KEY);
  const before = ai.readUsage().length;
  await ai.think("ideas", "SECRET SYSTEM", "SECRET USER", "byo");
  await ai.think("script", "s", "u", "byo");
  const rows = ai.readUsage().slice(before);
  assert.deepEqual(rows.map((r) => [r.mode, r.task, r.model, r.est_cost_usd]), [["byo", "ideas", "claude-haiku-5-5", 0.0002], ["byo", "script", "claude-sonnet-5-5", 0.004]]);
  assert.doesNotMatch(readFileSync(join(DIR, "usage.jsonl"), "utf8"), /sk-ant|SECRET/);
});

test("the developer switch can't be reached from a .env file or a mode name", async () => {
  const { devProvider } = await import("./dev-provider.ts");
  writeFileSync(join(DIR, ".env"), "POSTER_DEV_MAX=1\n");
  assert.equal(devProvider(), null);
  assert.equal(ai.aiStatus().dev, false);
  for (const v of ["0", "true", "yes", ""]) { process.env.POSTER_DEV_MAX = v; assert.equal(devProvider(), null); }
  delete process.env.POSTER_DEV_MAX;
  assert.equal(ai.writeMode("claude" as never), "hosted");
  writeFileSync(join(DIR, ".env"), "");
});

test("no client path reaches the Max plan: Claude Code is started in one developer-only file, which only the developer providers import", () => {
  const dir = import.meta.dirname;
  const files = readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"));
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(src, /pipeline\/llm|askClaude/, `${f} imports the TABOOST pipeline's model`);
    assert.doesNotMatch(src, /sk-ant-[A-Za-z0-9]{10,}/, `${f} has a key in it`);
    const mentionsClaude = /["'`]claude["'`]|Claude Code|findClaude|runClaudeCode/.test(src);
    assert.equal(mentionsClaude, ["claude-code.ts", "dev-provider.ts", "dev-provider.me.ts"].includes(f), `${f} mentions Claude Code`);
    const usesClaude = /claude-code\.ts/.test(src);
    assert.equal(usesClaude, f === "dev-provider.ts" || f === "dev-provider.me.ts", `${f} imports the Claude Code runner`);
  }
  const ai = readFileSync(join(dir, "ai.ts"), "utf8");
  assert.doesNotMatch(ai, /POSTER_DEV_MAX|Claude Code|claude-code|\bMax\b/);
  assert.match(ai, /import \{ devProvider \} from "\.\/dev-provider\.ts";/);
  const stub = readFileSync(join(dir, "dev-provider.client.ts"), "utf8");
  assert.doesNotMatch(stub, /import|spawn|claude|POSTER_DEV_MAX/i);
  assert.match(stub, /export const devProvider = \(\): DevProvider \| null => null;/);
});
