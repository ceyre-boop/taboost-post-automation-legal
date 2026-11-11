import { test } from "node:test";
import assert from "node:assert/strict";
import { numbersIn, normNum, type Fact } from "./facts.ts";
import { tooClose, jaccard } from "./similar.ts";
import { scriptProblems } from "./checks.ts";
import { validateBrief, wordBudget } from "./brief.ts";
import type { Script } from "./script.ts";

const brief = validateBrief({
  business: "t", audience: "a", promise: "p", tone: "t", banned_claims: ["guaranteed", "get rich"],
  platforms: ["tiktok", "instagram"], sources: [{ path: "x", kind: "text" }],
  script: { seconds: 20, words_per_second: 2.5, hook_max_words: 6 },
});
const fact: Fact = { id: "f#1", subject: "Earbuds", text: "Earbuds — Items Sold: 75,371; Total Commission Rate: 18%", location: "x row 2", numbers: ["75,371", "18%"] };

const ok = (over: Partial<Script> = {}): Script => ({
  idea: {} as any, seconds: 20,
  hook: "These earbuds quietly sold out",
  point: "Creators moved 75,371 pairs of these earbuds on TikTok Shop, and every sale pays an 18% commission to the creator who made it happen.",
  number: "75,371", cta: "Join TABOOST, link in bio",
  platforms: {
    tiktok: { hook: "75,371 sold. Here's why", caption: "c", hashtags: ["#TikTokShop"] },
    instagram: { hook: "These earbuds quietly sold out", caption: "c", hashtags: ["#creator"] },
  },
  checks: {} as any, ...over,
});

test("numbers are read exactly and normalised", () => {
  assert.deepEqual(numbersIn("75,371 sold at $17.49, 18%."), ["75,371", "$17.49", "18%"]);
  assert.equal(normNum("75,371"), normNum("75371"));
  assert.notEqual(normNum("75,371"), normNum("75,000"));
});

test("a clean script passes", () => {
  assert.deepEqual(scriptProblems(ok(), fact, brief), []);
  assert.equal(wordBudget(brief), 50);
});

test("an invented or rounded number fails", () => {
  const p = scriptProblems(ok({ point: ok().point.replace("75,371", "75,000") }), fact, brief);
  assert.ok(p.some((x) => x.includes('"75,000"')));
});

test("a banned claim fails, case-insensitive", () => {
  assert.ok(scriptProblems(ok({ cta: "Guaranteed results, link in bio" }), fact, brief).some((x) => x.includes("guaranteed")));
});

test("long hook, overlong script and missing platform fail", () => {
  const long = ok({ hook: "one two three four five six seven", point: "word ".repeat(60) + "75,371" });
  delete (long.platforms as any).instagram;
  const p = scriptProblems(long, fact, brief).join("\n");
  assert.match(p, /hook .* 7 words/);
  assert.match(p, /budget 50/);
  assert.match(p, /missing variant for instagram/);
});

test("too-close detection: same fact or heavy word overlap", () => {
  const prior = [{ factId: "f#1", title: "JLab earbuds sold 75,371 units" }];
  assert.match(tooClose({ factId: "f#1", title: "anything" }, prior)!, /same source fact/);
  assert.match(tooClose({ factId: "f#2", title: "JLab earbuds sold 75,371 units fast" }, prior)!, /overlap/);
  assert.equal(tooClose({ factId: "f#3", title: "Coins and Diamonds are not cash" }, prior), null);
  assert.ok(jaccard("a b c", "x y z") === 0);
});
