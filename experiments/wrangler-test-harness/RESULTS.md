# Spike: wrangler `createTestHarness()` vs. our `spawnWranglerDev`

**Date**: 2026-07-27 · **wrangler**: 4.114.0 (experiment-local) · **Verdict**: adopt, for the
capabilities — **not** for the speed.

Run it: `npx tsx spike.ts` (Stage A, ~1 s) · `npx tsx spike.ts --nebula` (adds Stage B, ~10 s
with a warm Docker image) · `npx tsx baseline.ts` (times today's path for comparison).

## The question

We already boot `wrangler dev` as a subprocess and scrape stdout for "Ready on"
(`@lumenize/testing/wrangler` → `spawnWranglerDev`, 5 consumers). CF shipped
`createTestHarness()` on 2026-07-21. What does it buy beyond what we do today?

## Results — all green, 0 failures

| Q | Question | Result |
|---|---|---|
| Q1 | Boots + `fetch()` at all? | ✅ fixture boots in **88–225 ms** |
| Q2 | `getDurableObjectStorage().exec()` — DO SQLite from Node | ✅ returned real rows |
| Q3 | `evictDurableObject()` — force a cold DO | ✅ incarnation changed, SQLite survived |
| Q3-ws | …with `webSockets: 'hibernate'` | ✅ **socket survived and re-delivered on the COLD incarnation** |
| Q4 | `getLogs()` — structured runtime logs | ✅ `{timestamp, level, message}`, captured DO-side `console.log` |
| Q5 | `reset()` vs. boot (fixture) | ✅ 52–68 ms vs. 88–225 ms (3.3×), storage wiped, overrides survive |
| Q6 | `vars`/`secrets` as objects | ✅ both override config and `.dev.vars`, no argv, no file mutation |
| Q7 | Boots **apps/nebula** incl. the DevContainer? | ✅ **4.0–4.8 s**, `/_version` → 200 |
| Q8 | Introspection against **real Nebula DO classes**? | ✅ `NebulaAuthRegistry` → `Identities`, `InviteTokens`, `MagicLinks`, `RefreshTokenIndex`, `Scopes` |
| Q9 | Do apps/nebula's **remote** bindings survive? | ✅ `env.AI.run()` **succeeded** through the harness |
| Q10 | `reset()` vs. boot (**apps/nebula**) | ⚠️ **3613 ms vs. 4008 ms — only 1.1×** |

## What actually pays — capability, not speed

**Boot time is a wash.** Same apps/nebula config, back to back:

| Path | Boot |
|---|---|
| `spawnWranglerDev` (subprocess + stdout scrape) | **5742 ms** |
| `createTestHarness().listen()` | **4008–4832 ms** |

~1.5 s, ~25%. Real but not a reason to convert anything. The ~2-min figure in `live.md` is the
**cold Docker image build**, which both paths pay identically.

**`reset()` does not buy per-scenario isolation on the real config** (Q10). It looked like the
headline win on the fixture (3.3×) and collapses to 1.1× on apps/nebula, because it re-does the
container and remote-binding setup. ⇒ **do not build a design on cheap `reset()`.**

**What does pay, because we have no equivalent today:**

1. **DO introspection from outside the isolate** (Q2, Q8). `getDurableObjectStorage(cls, {name}).exec(sql)`
   runs SQL *inside* the target DO and returns rows to Node. Today the `/live` and ui-smoke lanes can
   observe **only** through the public API; pool-workers can look inside but is a different tier and
   can't run the container. This is the out-of-isolate analogue of the debug-sink pattern.
2. **Forced eviction with hibernating-WS survival** (Q3, Q3-ws). `evictDurableObject(cls, {name,
   webSockets:'hibernate'})` tears the instance down, keeps durable storage, and the hibernated
   socket re-delivers to a **cold** incarnation. That is ADR-003's central resiliency claim — the
   traveling handler running on a storage-restored caller — made drivable against the real stack for
   the first time. There is no way to force this under `wrangler dev` today.
3. **Structured logs** (Q4) replacing `onStdio` chunk-scraping, which is eyeball-only behind
   `HARNESS_DEBUG`/`UI_SMOKE_DEBUG` and cannot be asserted on.
4. **Typed `vars`/`secrets`** (Q6) replacing `--var K:V` argv. `secrets` overrides `.dev.vars`
   *without mutating the file* — exactly what the turnstile-canary scenario works around today.
5. **`getEnv()`** (Q9) hands Node the worker's live bindings — we drove Workers AI directly from a
   Node script.

## Blockers found — `TestHarnessOptions` is only `{ root?, workers }`

There is **no** `--local`, `--local-protocol`, `--persist-to`, `--log-level`, or port option. Three
flags in current use have no direct equivalent:

- 🚨 **`--local`** — the real blocker. The harness **always** establishes a remote proxy session for
  remote bindings and **hard-fails without valid credentials**:
  > `Failed to establish remote session due to an authentication issue.`

  (Reproduced with `CLOUDFLARE_API_TOKEN=bogus`; boot died in 662 ms.) Today
  `bootDevStack`/`ui-smoke` pass `--local` in a no-creds lane precisely to drop `env.AI` and
  `send_email remote:true`. **Workaround:** `WorkerInput` accepts an **inline `config`** instead of
  a `configPath` — read the wrangler config, strip the remote bindings, pass it inline.
- **`--local-protocol https`** (`apps/nebula/test/browser`) — likely vestigial: the lane's
  same-origin vite proxy terminates TLS server-side, and ui-smoke already runs plain
  `http://localhost` (a secure context, so `Secure; SameSite=Strict` cookies flow). Verify before
  assuming.
- **`--persist-to`** (`apps/nebula/test/chromium`) — no equivalent found.

## Version floor

| API | First version |
|---|---|
| `createTestHarness`, `evictDurableObject`, `listDurableObjectIds`, `getLogs` | **4.111.0** (what we're on) |
| **`getDurableObjectStorage`** | **4.112.0** |

⇒ floor is **4.112.0**; recommend declaring **`^4.114.0`** (latest at time of writing).

## Repo-wide wrangler version state (2026-07-27)

`packages/*`, `apps/*`, `tooling/*` are uniformly **4.111.0** — including via
`@cloudflare/vitest-pool-workers`. **All drift is in `experiments/`**: 4.86.0 ×5, 4.98.0, 4.112.0,
4.113.0. The root-hoisted `node_modules/wrangler` is **4.86.0**, hoisted from those experiments —
which is the live footgun `durable-objects.md` documents (an older wrangler **silently ignores** the
`exports` DO registry, so every `ctx.storage.kv.*` throws an opaque 500).

🚨 **The declared `wrangler` range is not what decides our version — `@cloudflare/vitest-pool-workers`
is.** It depends on wrangler **exactly**, 1:1, and drags miniflare with it:

| pool-workers | wrangler | miniflare |
|---|---|---|
| **0.18.5** (ours) | 4.111.0 | 4.20260710.0 |
| 0.18.6 | 4.112.0 | 4.20260714.0 |
| 0.18.7 | 4.113.0 | 4.20260721.0 |
| 0.18.8 | 4.114.0 | 4.20260722.0 |

All 13 packages declaring `wrangler` also declare `pool-workers` — always paired, never one alone.
So the repo is uniform **because pool-workers hard-pinned it** and npm deduped our `^4.111.0` carets
onto that exact version. The drifting experiments are precisely the ones with **no** pool-workers.

⇒ **Bump pool-workers; wrangler and miniflare follow as a Cloudflare-tested triple. Never bump
wrangler alone** — our caret would resolve to the newer version while pool-workers' nested dep
stayed pinned to the old one, producing the two-copies problem outright.

Also verified in a scratch monorepo, and worth knowing but *not* the mechanism here:

- `npm update <pkg>` at the root does converge every workspace to the newest in-range version and
  collapses the physical copies to one, leaving declared ranges untouched. Correct in general —
  but on this dependency it must name **both** packages, or it splits the tree (above).
- ⚠️ `"overrides"` in the root `package.json` *does* force one version everywhere — but a **changed**
  override is silently ignored by `npm install`, `npm update`, `npm dedupe`, `npm install --force`,
  and `--package-lock-only` alike. Only deleting `package-lock.json` re-resolves it. Set-once is
  fine; bumping it is a lockfile regeneration.

## Recommendation

Re-implement `spawnWranglerDev`'s **internals** over `createTestHarness` rather than migrating five
call sites — it is already the boot abstraction, and the new capabilities surface as extra fields on
what it returns. See `tasks/wrangler-test-harness-adoption.md`.
