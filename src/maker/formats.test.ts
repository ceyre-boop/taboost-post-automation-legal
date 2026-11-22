// node --test src/maker/formats.test.ts
// The maker's second round: six looks with their own rules, the person's own clips
// (read from the MP4 itself, finished into a post, or mixed in behind photo posts), and
// "Plan my week" (made in turn, posted only once approved, never hours late).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "pe-formats-"));
process.env.POSTER_APP_DIR = DIR;
for (const k of ["POSTER_DEV_MAX", "NORTHBOUND_AI_ENDPOINT", "NORTHBOUND_CLIENT_TOKEN", "ANTHROPIC_API_KEY", "POSTER_ANTHROPIC_BASE_URL"]) delete process.env[k];

const ai = await import("./ai.ts");
const brief = await import("./brief.ts");
const checks = await import("./checks.ts");
const write = await import("./write.ts");
const make = await import("./make.ts");
const store = await import("./store.ts");
const clips = await import("./clips.ts");
const plan = await import("./plan.ts");
const routes = await import("./routes.ts");

const B = {
  business: "Ridge Roofing", whatYouDo: "We repair and replace roofs for homeowners in Lansing.", audience: "Homeowners in Lansing",
  facts: "We have replaced 412 roofs since 2015\nMost repairs are done in 1 day\nEvery job is cleaned up the same day", avoid: "cheap", cta: "Call for a free quote", color: "#C8102E", mood: "bold",
};
const BR = () => brief.validateBrief(B);
const PL = ["tiktok", "x"];
const caps = () => Object.fromEntries(PL.map((p) => [p, { caption: "Most repairs are done in 1 day.", hashtags: ["#roofing"] }]));
afterEach(() => { ai.setThinker(null); plan.setPlanClock(null); });

/* ---------------- a tiny MP4, built box by box ---------------- */

const box = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
function mvhd(timescale: number, duration: number) { const b = Buffer.alloc(100); b.writeUInt32BE(timescale, 12); b.writeUInt32BE(duration, 16); return box("mvhd", b); }
function tkhd(w: number, h: number, upright = false) {
  const b = Buffer.alloc(84), m = 40;
  if (upright) { b.writeInt32BE(0x10000, m + 4); b.writeInt32BE(-0x10000, m + 12); } else { b.writeInt32BE(0x10000, m); b.writeInt32BE(0x10000, m + 16); }
  b.writeInt32BE(0x40000000, m + 32); b.writeUInt32BE(w * 65536, 76); b.writeUInt32BE(h * 65536, 80);
  return box("tkhd", b);
}
const hdlr = (kind: string) => { const b = Buffer.alloc(24); b.write(kind, 8, "latin1"); return box("hdlr", b); };
const stsd = (codec: string) => { const b = Buffer.alloc(16); b.writeUInt32BE(1, 4); b.writeUInt32BE(8, 8); b.write(codec, 12, "latin1"); return box("stsd", b); };
function mp4({ w = 1280, h = 800, secs = 30, audio = false, codec = "avc1", upright = false } = {}): Buffer {
  const video = box("trak", tkhd(w, h, upright), box("mdia", hdlr("vide"), box("minf", box("stbl", stsd(codec)))));
  const sound = box("trak", box("tkhd", Buffer.alloc(84)), box("mdia", hdlr("soun")));
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isomavc1", "latin1")), box("mdat", Buffer.alloc(2000)), box("moov", mvhd(600, secs * 600), video, ...(audio ? [sound] : []))]);
}
function upload(bytes: Buffer) { const s = new PassThrough() as PassThrough & { headers: Record<string, string> }; s.headers = { "content-length": String(bytes.length) }; s.end(bytes); return s as never; }
const plainOf = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { return (e as Error).message; } };

/* ---------------- clips ---------------- */

test("a clip's length, size, sound and codec are read from the MP4 itself, wherever its header sits", () => {
  const f = join(DIR, "probe.mp4");
  writeFileSync(f, mp4());
  assert.deepEqual(clips.probeFile(f), { seconds: 30, width: 1280, height: 800, audio: false, codec: "avc1" });
  writeFileSync(f, mp4({ w: 1920, h: 1080, upright: true, audio: true, codec: "hvc1", secs: 21 }));
  assert.deepEqual(clips.probeFile(f), { seconds: 21, width: 1080, height: 1920, audio: true, codec: "hvc1" }); // an iPhone held upright
  writeFileSync(f, Buffer.from("<html>not a video</html>"));
  assert.equal(clips.probeFile(f), null);
});

test("a clip is written to disk as it arrives, then checked: not a video, ProRes, or too short is refused in plain words", async () => {
  assert.match(await plainOf(clips.saveClip("", upload(Buffer.from("x".repeat(5000))), "notes.mp4")), /isn't a video the app can read/);
  assert.match(await plainOf(clips.saveClip("", upload(mp4({ codec: "apcn" })), "edit.mov")), /ProRes/);
  assert.match(await plainOf(clips.saveClip("", upload(mp4({ secs: 1 })), "blink.mp4")), /under 2 seconds/);
  assert.equal(clips.listClips("").length, 0);
  const c = await clips.saveClip("", upload(mp4({ secs: 30 })), "guided-build.mp4");
  assert.match(c.name, /^c-[a-f0-9]{12}\.mp4$/);
  assert.equal(c.file, "guided-build.mp4");
  assert.deepEqual([c.start, c.end, c.audio], [0, 30, false]);
  assert.ok(existsSync(clips.clipPath("", c.name)));
  assert.equal(clips.listClips("").length, 1);
  assert.equal(clips.listClips("northbound").length, 0); // each set keeps its own
  assert.equal(clips.isClipName("../brief.json"), false);
});

test("a post uses at most 56 seconds of a clip, and what it shows is cleaned", async () => {
  const c = await clips.saveClip("", upload(mp4({ secs: 120 })), "long.mov");
  assert.equal(c.end, 56);
  assert.match(await plainOf(Promise.resolve().then(() => clips.updateClip("", c.name, { start: 10, end: 80 }))), /at most 56 seconds/);
  const u = clips.updateClip("", c.name, { start: 10, end: 60, note: "  Walking\u0007 through a roof   check  " });
  assert.deepEqual([u.start, u.end], [10, 60]);
  assert.equal(u.note, "Walking  through a roof   check");
  assert.equal(clips.removeClip("", c.name), true);
  assert.equal(clips.removeClip("", c.name), false);
});

/* ---------------- the formats' own rules ---------------- */

const s = (over: Partial<import("./checks.ts").MadeScript>) => ({ hook: "Your roof is talking", points: ["Most repairs are done in 1 day"], cta: "Call for a free quote", platforms: caps(), ...over });

test("each format has its own rules", () => {
  const p = (x: Partial<import("./checks.ts").MadeScript>, extra = "") => checks.scriptProblems(s(x), BR(), PL, extra).join("\n");
  assert.equal(p({ format: "tips" }), "");
  assert.match(p({ format: "mythfact", points: ["a", "b", "c"] }), /exactly 2 points for a "Myth vs fact" post/);
  assert.equal(p({ format: "mythfact", points: ["Roof repairs take a week", "Most repairs are done in 1 day"] }), "");
  assert.match(p({ format: "steps", points: ["Call us", "We look"] }), /3 to 4 points/);
  assert.match(p({ format: "question", hook: "How long does a repair take" }), /question mark/);
  assert.equal(p({ format: "question", hook: "How long does a roof repair usually take?" }), ""); // a question may run to 12 words
  assert.match(p({ format: "number" }), /needs the number in "stat"/);
  assert.match(p({ format: "number", stat: "500" }), /"500" is not in the business's facts/);
  assert.equal(p({ format: "number", stat: "412", hook: "roofs replaced" }), "");
  // A clip post may use numbers from what the person said the clip shows, and nowhere else.
  assert.match(p({ format: "clip", hook: "A 3 step site build", points: ["Pick a look"] }), /"3" is not/);
  assert.equal(p({ format: "clip", hook: "A 3 step site build", points: ["Pick a look"] }, "Building a site in 3 steps"), "");
});

test("ideas come in varied looks: 'One number' only for a fact with a number in it, anything unknown becomes Quick tips", async () => {
  ai.setThinker(async (_t, _s, user) => {
    assert.match(user, /KINDS OF POST[\s\S]*mythfact[\s\S]*number/);
    return JSON.stringify({ ideas: [
      { title: "412 roofs and counting", angle: "a", fact: 1, format: "number" },
      { title: "The tidy finish nobody expects", angle: "b", fact: 3, format: "number" },
      { title: "Is a leak an emergency?", angle: "c", fact: 2, format: "question" },
      { title: "Myths about roof repair times", angle: "d", fact: 2, format: "mythfact" },
      { title: "A roof dance", angle: "e", fact: 2, format: "dance" },
    ] });
  });
  const ideas = await write.suggestIdeas(BR(), []);
  assert.deepEqual(ideas.map((i) => i.format), ["number", "tips", "question", "mythfact", "tips"]);
});

test("a clip's script is written from what the clip shows, its length and its sound", async () => {
  const c = await clips.saveClip("", upload(mp4({ secs: 28, w: 390, h: 844 })), "guided-build-390.mp4");
  const clip = clips.updateClip("", c.name, { note: "Walking through how a site gets built in 3 steps" });
  let prompt = "";
  ai.setThinker(async (_t, system, user) => { prompt = system + "\n" + user; return JSON.stringify(s({ hook: "Your site in 3 steps", points: ["Pick a look", "Add your words", "Go live"] })); });
  const idea = write.clipIdea(clip);
  assert.equal(idea.format, "clip");
  assert.match(idea.title, /^Your clip: Walking through/);
  const out = await write.writeScript(BR(), idea, PL, clip);
  assert.match(prompt, /THE CLIP: Walking through how a site gets built in 3 steps/);
  assert.match(prompt, /28 SECONDS LONG, upright, with no sound/);
  assert.match(prompt, /KIND OF POST: Your clip/);
  assert.equal(out.format, "clip");
  assert.deepEqual(out.points, ["Pick a look", "Add your words", "Go live"]);
});

/* ---------------- render jobs ---------------- */

test("a clip post is one card for the whole clip with captions taking turns, then the end card", async () => {
  const c = clips.updateClip("", (await clips.saveClip("", upload(mp4({ secs: 30 })), "a.mp4")).name, { start: 2, end: 26, note: "x" });
  const p = store.newMade("", write.clipIdea(c), PL);
  p.script = { ...s({ format: "clip", points: ["one", "two", "three"] }) };
  const job = make.buildJob(p, BR(), "", c);
  assert.equal(job.format, "clip");
  assert.deepEqual(job.cards.map((k) => k.kind), ["clip", "end"]);
  assert.equal(job.cards[0].seconds, 24);
  assert.deepEqual(job.cards[0].media, { type: "clip", name: c.name, from: 2 });
  const lines = job.cards[0].lines!;
  assert.equal(lines.length, 3);
  assert.ok(lines[0].from > 0 && lines.every((l, i) => l.to > l.from && (i === 0 || l.from === lines[i - 1].to)));
  assert.equal(lines.at(-1)!.to, 24);
  assert.deepEqual(job.clip, { name: c.name, start: 2, end: 26, width: 1280, height: 800, audio: false, bytes: c.bytes });
});

test("a 'One number' post opens on the number; photo posts mix stretches of clips in behind the photos", async () => {
  const p = store.newMade("", { title: "t", angle: "a", fact: 0, format: "number" }, PL);
  p.script = s({ format: "number", stat: "412", hook: "roofs replaced", points: ["Most repairs are done in 1 day"] });
  p.media = make.pickMedia(["p1.jpg", "p2.jpg"], [], 2, 7);
  const job = make.buildJob(p, BR(), "");
  assert.deepEqual(job.cards.map((k) => k.kind), ["stat", "point", "end"]);
  assert.equal(job.cards[0].stat, "412");
  const c = { name: "c-000000000000.mp4", start: 5, end: 25 } as import("./clips.ts").Clip;
  const media = make.pickMedia(["p1.jpg", "p2.jpg", "p3.jpg"], [c], 5, 11);
  assert.equal(media.length, 5);
  assert.ok(media.some((m) => m.type === "clip") && media.some((m) => m.type === "photo"));
  for (const m of media.filter((x) => x.type === "clip")) assert.ok(m.from! >= 5 && m.from! <= 20);
  assert.deepEqual(make.pickMedia(["p1.jpg", "p2.jpg", "p3.jpg"], [c], 5, 11), media); // the same post looks the same if made again
});

/* ---------------- plan my week ---------------- */

const at = (y: number, mo: number, d: number, h = 10) => new Date(y, mo - 1, d, h, 0, 0).getTime();

test("a week's plan is 3 to 5 posts on spread-out days from tomorrow, at midday and in the evening", () => {
  const now = at(2026, 11, 23); // a Monday morning
  const four = plan.slotTimes(4, now).map((t) => new Date(t));
  assert.deepEqual(four.map((d) => d.getDate()), [24, 26, 28, 30]);
  assert.deepEqual(four.map((d) => d.getHours()), [12, 18, 12, 18]);
  assert.equal(plan.slotTimes(3, now).length, 3);
  assert.equal(plan.slotTimes(5, now).length, 5);
  assert.ok(plan.slotTimes(5, now).every((t) => Date.parse(t) > now));
});

test("nothing in a plan posts until it's approved; approved posts go at their time, never early, never hours late", () => {
  const slot = { at: new Date(at(2026, 11, 24, 12)).toISOString(), idea: { title: "t", angle: "", fact: 0 }, madeId: "m-0000000001", approved: false };
  const ready = { status: "ready" } as import("./store.ts").MadePost;
  assert.equal(plan.slotState(slot, ready, at(2026, 11, 24, 13)), "ready");
  assert.equal(plan.slotDue(slot, ready, at(2026, 11, 24, 13)), false);
  const ok = { ...slot, approved: true };
  assert.equal(plan.slotDue(ok, ready, at(2026, 11, 24, 11)), false);   // before its time
  assert.equal(plan.slotDue(ok, ready, at(2026, 11, 24, 13)), true);    // an hour after
  assert.equal(plan.slotDue(ok, ready, at(2026, 11, 24, 19)), false);   // seven hours late: it waits for the person
  assert.equal(plan.slotState(ok, ready, at(2026, 11, 24, 19)), "missed");
  assert.equal(plan.slotState({ ...slot, madeId: "" }, null), "waiting");
  assert.equal(plan.slotState(slot, { status: "discarded" } as never), "tossed");
  assert.equal(plan.slotState({ ...slot, problem: "gone" }, null), "failed");
});

test("the plan timer posts an approved post that's due through the normal engine, and leaves the rest alone", async () => {
  const set = "planset";
  const m = store.newMade(set, { title: "Roof trouble", angle: "", fact: 0 }, PL);
  m.status = "ready"; m.script = s({}); m.captions = caps(); store.saveMade(m);
  mkdirSync(store.madeDir(set, m.id), { recursive: true }); writeFileSync(store.videoPath(set, m.id), Buffer.alloc(2000));
  const due = at(2026, 11, 24, 12);
  plan.savePlan(set, { every: false, perWeek: 3, platforms: ["tiktok", "x", "youtube"], plannedAt: "", slots: [{ at: new Date(due).toISOString(), idea: m.idea, madeId: m.id, approved: false }] });
  const posted: unknown[][] = [];
  const ctx = { batchRunning: () => false, startPost: (...a: unknown[]) => { posted.push(a); return "b-1"; } };
  plan.setPlanClock(() => due + 60_000);
  assert.equal(await routes.planTick(set, 0, ctx as never), "idle");     // not approved
  const p = plan.readPlan(set); p.slots[0].approved = true; plan.savePlan(set, p);
  plan.setPlanClock(() => due - 60_000);
  assert.equal(await routes.planTick(set, 0, ctx as never), "idle");     // approved, not time yet
  assert.equal(posted.length, 0);
  plan.setPlanClock(() => due + 60_000);
  assert.equal(await routes.planTick(set, 0, { ...ctx, batchRunning: () => true } as never), "waiting for posts to finish");
  assert.equal(await routes.planTick(set, 0, ctx as never), "posting");
  assert.equal(posted.length, 1);
  const [video, captions, platforms, live] = posted[0] as [string, Record<string, string>, string[], boolean];
  assert.equal(video, store.videoPath(set, m.id));
  assert.deepEqual(platforms, ["tiktok", "x"]); // only accounts the post has a caption for
  assert.equal(live, true);
  assert.match(captions.x, /Most repairs are done in 1 day\.\n\n#roofing/);
  assert.equal(store.readMade(set, m.id)!.status, "posting");
  assert.equal(await routes.planTick(set, 0, ctx as never), "idle");     // never twice
});

test("a week is planned from the person's unused clips first, then ideas in as many looks as possible", async () => {
  const set = "weekset";
  brief.saveBrief(set, B);
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(200).fill(1)]);
  for (let i = 0; i < 3; i++) brief.savePhoto(set, JPG);
  const c = await clips.saveClip(set, upload(mp4({ secs: 28 })), "guided-build.mp4");
  clips.updateClip(set, c.name, { note: "Walking through a site build" });
  await clips.saveClip(set, upload(mp4({ secs: 10 })), "no-note.mp4"); // says nothing about itself, so it isn't planned
  ai.setThinker(async () => JSON.stringify({ ideas: [
    { title: "Repairs in a day, really", angle: "a", fact: 2, format: "tips" },
    { title: "Another quick tip about roofs", angle: "b", fact: 2, format: "tips" },
    { title: "Does a leak mean a new roof?", angle: "c", fact: 2, format: "question" },
    { title: "412 roofs since 2015", angle: "d", fact: 1, format: "number" },
    { title: "What happens on the day", angle: "e", fact: 3, format: "steps" },
  ] }));
  const ideas = await routes.planIdeas(set, 4);
  assert.equal(ideas.length, 4);
  assert.equal(ideas[0].format, "clip");
  assert.equal(ideas[0].clip, c.name);
  assert.equal(new Set(ideas.map((i) => i.format)).size, 4); // four different looks
  assert.ok(!ideas.some((i) => i.title === "Another quick tip about roofs"));
});

/* ---------------- what the review found, pinned ---------------- */

const readyPost = (set: string, title: string, withCaps = true) => {
  const m = store.newMade(set, { title, angle: "", fact: 0 }, PL);
  m.status = "ready"; m.script = s({}); if (withCaps) m.captions = caps(); store.saveMade(m);
  mkdirSync(store.madeDir(set, m.id), { recursive: true }); writeFileSync(store.videoPath(set, m.id), Buffer.alloc(2000));
  return m;
};
const noPost = { batchRunning: () => false, startPost: () => { throw new Error("must not post"); } };

test("a post with no caption for the plan's accounts doesn't hold up the others: it's marked and the next one goes", async () => {
  const set = "capset";
  const a = readyPost(set, "No captions here", false), b = readyPost(set, "Has captions");
  const due = at(2026, 11, 24, 12);
  plan.savePlan(set, { every: false, perWeek: 3, platforms: ["tiktok", "x"], plannedAt: "", slots: [
    { at: new Date(due).toISOString(), idea: a.idea, madeId: a.id, approved: true },
    { at: new Date(due).toISOString(), idea: b.idea, madeId: b.id, approved: true },
  ] });
  const posted: string[] = [];
  plan.setPlanClock(() => due + 60_000);
  assert.equal(await routes.planTick(set, 0, { batchRunning: () => false, startPost: (v: string) => { posted.push(v); return "b"; } } as never), "posting");
  assert.deepEqual(posted, [store.videoPath(set, b.id)]);
  const p = plan.readPlan(set);
  assert.equal(p.slots[0].approved, false);
  assert.match(p.slots[0].problem!, /no caption for the accounts/);
});

test("days that have gone by aren't made; a failed automatic re-plan waits a day instead of trying every minute", async () => {
  const set = "pastset";
  brief.saveBrief(set, B);
  for (let i = 0; i < 3; i++) brief.savePhoto(set, Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(100).fill(i)]));
  const long = at(2026, 11, 10, 12);
  plan.savePlan(set, { every: true, perWeek: 3, platforms: ["tiktok"], plannedAt: new Date(at(2026, 11, 9)).toISOString(), slots: [{ at: new Date(long).toISOString(), idea: { title: "Old idea", angle: "", fact: 0 }, madeId: "", approved: false }] });
  let calls = 0;
  ai.setThinker(async () => { calls++; throw new ai.AiError("The AI is down.", false); });
  plan.setPlanClock(() => at(2026, 11, 24, 9));
  assert.equal(await routes.planTick(set, 0, noPost as never), "plan failed");   // not "making" the old day
  assert.equal(await routes.planTick(set, 0, noPost as never), "idle");          // and not trying again a minute later
  assert.equal(calls, 1);
  assert.equal(plan.readPlan(set).slots[0].madeId, "");
});

test("a new week keeps approved posts still to come, and throws away only what wasn't approved", () => {
  const set = "keepset";
  const keep = readyPost(set, "Approved and coming"), drop = readyPost(set, "Never approved");
  const now = at(2026, 11, 24, 9);
  plan.setPlanClock(() => now);
  plan.savePlan(set, { every: false, perWeek: 3, platforms: ["tiktok"], plannedAt: "", slots: [
    { at: new Date(now + 3 * 3600_000).toISOString(), idea: keep.idea, madeId: keep.id, approved: true },
    { at: new Date(now + 5 * 3600_000).toISOString(), idea: drop.idea, madeId: drop.id, approved: false },
  ] });
  const p = routes.replacePlan(set, [{ title: "New one", angle: "", fact: 0, format: "tips" }], { perWeek: 3, platforms: ["tiktok"], every: false });
  assert.deepEqual(p.slots.map((x) => x.idea.title), ["Approved and coming", "New one"]);
  assert.equal(p.slots[0].approved, true);
  assert.equal(store.readMade(set, keep.id)!.status, "ready");
  assert.equal(store.readMade(set, drop.id)!.status, "discarded");
});

test("a clip upload that stops halfway is refused and leaves nothing behind; a fragmented MP4 says how to fix it", async () => {
  const half = new PassThrough() as PassThrough & { headers: Record<string, string> };
  half.headers = { "content-length": "999999" };
  half.write(Buffer.alloc(5000));
  const p = clips.saveClip("abortset", half as never, "half.mp4");
  setTimeout(() => half.destroy(), 20);
  assert.match(await plainOf(p), /stopped before it finished/);
  assert.deepEqual((await import("node:fs")).readdirSync(clips.clipsDir("abortset")).filter((f) => f.startsWith(".upload")), []);
  const frag = Buffer.concat([box("ftyp", Buffer.from("iso5\0\0\0\0iso5", "latin1")), box("moov", mvhd(600, 0), box("trak", tkhd(1280, 720), box("mdia", hdlr("vide"))), box("mvex", box("trex", Buffer.alloc(24))))]);
  assert.match(await plainOf(clips.saveClip("", upload(frag), "stream.mp4")), /streaming format/);
});
