# How this app gets its AI

Decided by Colin on 2026-11-21. Final. Also recorded in Northbound's `Plans/DECISIONS.md`, items 49 to 53. This file travels with the app so the rule is never lost.

## The policy

**How client-facing automations get their AI:**

- **Never route a client's AI through Colin's personal Claude Max plan.** Reselling a personal subscription breaks Anthropic's terms and risks the account the whole business runs on. Max is only for Colin's own internal agents and development, never client work.
- **Client AI goes through the Anthropic API, under Northbound's own API key,** via a small Northbound backend (on the Mac mini or a cloud server). Billing is separate from Max usage.
- **Three modes, defaulting to Hosted:**
  1. **Hosted (default):** the app calls Northbound's backend endpoint (config: `NORTHBOUND_AI_ENDPOINT`), which holds the key. The client signs in once and never sees a key.
  2. **BYO-key:** the client supplies their own Anthropic API key (the cheaper tier, for technical users).
  3. **Never the Max plan** for any client-facing call.

## How this app follows it

This copy is for **Post Everywhere**, which uses AI only in the post maker. Every AI call in the maker goes through one module, `src/maker/ai.ts`. Nothing else in `src/maker/` talks to a model.

Post Everywhere also contains TABOOST's own internal content pipeline (`src/pipeline/`, `src/weekly/`), which runs on Colin's Max plan for Colin's own use. The post maker never imports it, and a test fails if it does.

| Mode | Where the call goes | Who holds the key |
|---|---|---|
| `hosted` (default) | `POST` to `NORTHBOUND_AI_ENDPOINT` | Northbound's backend |
| `byo` | The Anthropic API, through the official SDK | The client, in their own app folder |

- No key is written in the code. The endpoint and the client's sign-in token come from the environment or a `.env` file in the app folder; a BYO key is saved in the app folder's `secrets.json` (readable by that user only) or read from `ANTHROPIC_API_KEY`.
- **Models:** the cheapest model that does the job. Suggesting ideas uses Claude Haiku 5.5. Writing the script and the captions uses Claude Sonnet 5.5, once per made post (twice if its first draft fails the checks).
- **Every request is logged** to `usage.jsonl` in the app folder: time, mode, task, model, tokens in and out, and the estimated cost. This is what the backend's per-client caps will be built on.
- **Tests** (`src/maker/maker.test.ts`) fail if a client-facing path can reach Claude Code, the Max plan, or the TABOOST pipeline's model.

## The developer switch (Colin's own Mac only)

Colin chose to keep one switch for his own testing: starting the app with the environment variable `POSTER_DEV_MAX=1` makes it use Claude Code on that Mac instead of the API. It exists so development does not spend API money.

- It is **not** in the app's Settings, is **not** stored in any settings or `.env` file, and cannot be turned on by any request to the app. It only works when the variable is set in the environment of the process that starts the app.
- When it is on, the dashboard shows a red "Developer mode" banner on every screen and every call is logged with mode `dev-max`.
- **Never start a client's install with this variable set.** A client install has no reason to have it, and the packaged app must not set it.

## Hosted mode today

The Northbound backend is not built yet. Until it is:

- With no `NORTHBOUND_AI_ENDPOINT` set, Hosted mode stops with a clear message: "Northbound hosting isn't set up yet." The app tells the person they can add their own API key in the meantime.
- The app is fully usable in BYO-key mode.

### Where the backend plugs in (TODO)

`hosted()` in `src/maker/ai.ts` is the only place to change. The contract the app already speaks:

```
POST {NORTHBOUND_AI_ENDPOINT}
Authorization: Bearer {NORTHBOUND_CLIENT_TOKEN}
Content-Type: application/json

{ "app": "post-everywhere", "task": "ideas" | "script", "system": "...", "user": "..." }
```

```
200 { "text": "...", "model": "claude-haiku-5-5", "usage": { "input_tokens": 0, "output_tokens": 0 } }
4xx/5xx { "error": "a sentence the person can read" }
```

What the backend still has to do:

1. **Sign-in.** Issue each client a token after they sign in once, and have the app store it (today it is read from `NORTHBOUND_CLIENT_TOKEN`). The app has no sign-in screen yet.
2. **Choose the model** per task on the server (the app sends the task, not a model name), so prices can change without shipping the app.
3. **Enforce per-client caps** from the same token and cost figures the app logs.
4. **Keep nothing.** The business details and prompts pass through to the Anthropic API and are not stored. Photos never leave the Mac: the video is made on the Mac itself.

The endpoint must be `https`. The app refuses a plain `http` endpoint unless it is on this Mac (for development).
