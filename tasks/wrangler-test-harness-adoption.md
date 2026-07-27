# Wrangler `createTestHarness()` Adoption

**Status**: Design drafted, not reviewed — spike complete, `/review-task` not yet run
**Spike**: `experiments/wrangler-test-harness/RESULTS.md` (2026-07-27, all green)

## Objective

Swap the engine under our one `wrangler dev` boot abstraction from *subprocess + stdout scrape*
to wrangler's `createTestHarness()`, and bring the whole repo onto a single wrangler version so a
bare `wrangler` from the repo root stops being a different version from the one the packages run.

## Design intent

### What this is really for

**Not speed.** Measured back-to-back on the same apps/nebula config: `spawnWranglerDev` **5742 ms**
vs. `createTestHarness().listen()` **4008–4832 ms**. Real, ~25%, and not worth touching five call
sites for. The ~2-min figure in `live.md` is the cold Docker image build, which both paths pay.

**Not cheap resets either.** `reset()` looked like the win on a trivial fixture (3.3× faster than a
boot) and collapses to **1.1×** on apps/nebula (3613 ms vs. 4008 ms) because it re-does the
container and remote-binding setup. ⚠️ **Do not design per-scenario isolation around `reset()`** —
the spike hypothesized exactly that and measured it false.

**The reason is capability we do not have at all today.** The `/live` harness and the ui-smoke,
browser, and chromium lanes can observe the running system **only through its public API**;
pool-workers can see inside a DO but is a different tier and cannot run the DevContainer. The
harness closes that gap from outside the isolate:

- `getDurableObjectStorage(cls, {name}).exec(sql)` runs SQL **inside** the target DO and returns
  rows to Node. Verified against real Nebula classes — `NebulaAuthRegistry` returned `Identities`,
  `InviteTokens`, `MagicLinks`, `RefreshTokenIndex`, `Scopes`.
- `evictDurableObject(cls, {name, webSockets:'hibernate'})` forces a cold DO while preserving
  durable storage, and the hibernated socket **re-delivers to the new incarnation**. This is
  ADR-003's central resiliency claim — a traveling handler running on a storage-restored caller —
  drivable against the real stack for the first time. Nothing under `wrangler dev` can force it today.
- `getLogs()` returns structured `{timestamp, level, message}` including DO-side `console.log`,
  replacing `onStdio` chunk-scraping that is eyeball-only behind `HARNESS_DEBUG`/`UI_SMOKE_DEBUG`
  and cannot be asserted on.
- `vars`/`secrets` as objects replace `--var K:V` argv, and `secrets` overrides `.dev.vars`
  **without mutating the file** — what the turnstile-canary scenario works around today.

⚠️ These are exploration/verification instruments (`live.md`), **not** a new automated-test tier.
`testing.md` still owns the committed vitest regression net. A finding made with `getLogs()` or
`evictDurableObject` that is worth locking in becomes a vitest test there.

### Why the engine and not the call sites

`spawnWranglerDev` is *already* the boot abstraction, with consumers in both `apps/nebula` and
`packages/mesh`. Re-implementing its internals means one file changes, all consumers keep working,
and the new capabilities arrive as extra fields on what it already returns. Migrating five call
sites individually would mean maintaining two ways to boot a worker for the duration — and per
`workflow.md`, a second boot path in a surface re-read every session is exactly the interim
someone pays to unlearn.

### The one real blocker

`TestHarnessOptions` is **only** `{ root?, workers }` — no `--local`, `--local-protocol`,
`--persist-to`, `--log-level`, or port control. The harness **always** establishes a remote proxy
session for remote bindings and hard-fails without valid credentials (reproduced with
`CLOUDFLARE_API_TOKEN=bogus`; boot died in 662 ms with *"Failed to establish remote session due to
an authentication issue"*). apps/nebula declares two remote bindings — `AI` and `send_email` with
`remote: true` — and the no-creds lanes pass `--local` today precisely to drop them.

`WorkerInput` accepts an inline `config` object as an alternative to `configPath`, so the no-creds
path becomes: read the wrangler config, strip the remote bindings, pass it inline. **Phase 2 does
not land until that lane is proven**, because it is the CI lane.

## Decisions

| # | Decision | Rationale / rejected alternative |
|---|---|---|
| D1 | Re-implement the boot utility's **internals** over `createTestHarness`; consumers keep their current call shape | Rejected per-lane migration — two boot paths to maintain and unlearn. Rejected rewriting all five consumers — churn with no gain |
| D2 | Version floor **`^4.114.0`**, declared only because we depend on a 4.112+ API | `getDurableObjectStorage` first appears in **4.112.0**; `createTestHarness`/`evictDurableObject`/`listDurableObjectIds`/`getLogs` already exist in 4.111.0. The declared range is **documentation of a real dependency**, not the version mechanism — see D3 |
| D3 | 🚨 **`@cloudflare/vitest-pool-workers` is the version knob. Bump it; wrangler and miniflare follow.** Never bump wrangler on its own | pool-workers depends on wrangler **exactly**, 1:1 — 0.18.5→4.111.0, 0.18.6→4.112.0, 0.18.7→4.113.0, 0.18.8→4.114.0 (and miniflare moves with it). All 13 packages that declare wrangler also declare pool-workers, never one alone, so the repo is uniform **because pool-workers hard-pinned it** and npm deduped our carets onto that exact version. ⇒ bumping our `wrangler` caret alone would resolve it to the newer version while pool-workers' nested dep stays pinned to the old one — **two copies, which is the problem this task exists to prevent.** The triple is a Cloudflare-tested combination; take it as one |
| D4 | Do **not** add a root `package.json` `overrides` entry | It does force one version everywhere, but a **changed** override is silently ignored by `npm install`, `npm update`, `npm dedupe`, `--force`, and `--package-lock-only` alike — only deleting `package-lock.json` re-resolves it. Set-once is fine; every bump becomes a full lockfile regeneration, which is worse than the problem. Verified in a scratch monorepo |
| D5 | No-creds lane rides an **inline stripped config**, not a `--local` equivalent | None exists. Gating Phase 2 on it rather than shipping a locally-green change that reds CI |
| D6 | **Do not** build per-scenario isolation on `reset()` | Measured 1.1× on the real config. The fixture's 3.3× does not generalize |
| D7 | Keep the **fresh-boot-per-run** model the lanes already use | Follows from D6 |

## What is NOT in scope

- **vitest-pool-workers suites.** Different tier — `runInDurableObject`, `isolatedStorage`, the
  debug sink, direct DO stubs all stay exactly as they are. `createTestHarness` does not replace them.
- **Deployed-worker e2e** (`packages/auth/test/e2e-email*`, `packages/fetch/test/` against
  `@lumenize/test-endpoints`). ADR-009 makes the deployed loop the real path; running it locally
  would be the mock-the-external-service reflex, not an improvement.
- **MSW / outbound `fetch` mocking**, the headline of CF's changelog post. Against ADR-009 and
  `testing.md` for our email and Turnstile paths. Do not adopt it for those.
- **Deploy-only truths** — the stale `running` flag and persist-before-`ctx.abort()` remain
  verifiable only on deployed CF (`containers.md`, `durable-objects.md`).

## Phase 1: One wrangler version across the repo

**Goal**: A bare `wrangler` from the repo root is the same version the packages run, and the floor
declares what we actually depend on.

Today `packages/*`, `apps/*`, `tooling/*` are uniformly 4.111.0, but the **root-hoisted**
`node_modules/wrangler` is **4.86.0**, hoisted from stale `experiments/`. That is the live footgun
in `durable-objects.md`: an older wrangler **silently ignores** the `exports` DO registry, so no
class is SQLite-backed and every `ctx.storage.kv.*` throws an opaque 500 with no config error.

This phase stands on its own — it is worth doing whether or not Phase 2 proceeds.

⚠️ **This is not a wrangler bump, it is a toolchain-triple bump** (D3). Moving pool-workers
0.18.5 → 0.18.8 also moves **miniflare 4.20260710.0 → 4.20260722.0**, and miniflare is the workerd
runtime under every pool-workers test. Behavior can change; budget for a full-suite run and treat
an unexplained new failure as a real signal, not flake.

**Success Criteria**:
- [ ] Every `package.json` that declares **`@cloudflare/vitest-pool-workers`** declares `^0.18.8`
      (or the then-current version). Enumerate with
      `grep -l 'vitest-pool-workers' packages/*/package.json apps/*/package.json tooling/*/package.json`
- [ ] The same files' `wrangler` range is raised in lockstep to match whatever that pool-workers
      version pins exactly (`npm view @cloudflare/vitest-pool-workers@<v> dependencies.wrangler`).
      ⚠️ The set of files declaring each is currently identical — **verify that still holds** rather
      than assuming it; a package declaring one without the other is the split D3 warns about
- [ ] `npm install`, then `npm ls wrangler --all` reports **exactly one** resolved version
      tree-wide, and `npm ls @cloudflare/vitest-pool-workers --all` likewise
- [ ] `node -p "require('./node_modules/wrangler/package.json').version"` at the repo root reports
      that same version — this is the check that proves the root-hoist footgun is closed
- [ ] Stale experiments still pinning an old wrangler are handled per `workflow.md` — either
      bumped, or their entry removed from the root `workspaces` list and `git rm`'d once their
      results are captured. Enumerate with
      `grep -l '"wrangler"' experiments/*/package.json` and check each against the `workspaces` list.
      These are the ones with **no** pool-workers, which is exactly why they drifted
- [ ] `npm run type-check` clean; full `npm test` run by Larry and no worse than before the bump
- [ ] Record the rule in `workflow.md` under a "Toolchain bumps" note: **pool-workers is the knob,
      never bump wrangler alone (D3)**, plus D4's `overrides` caveat — so the next session does not
      re-derive either. `durable-objects.md` already states the `exports`-needs-4.111 floor; make
      sure the two do not drift apart

## Phase 2: Re-engine the boot utility

**Goal**: `packages/testing/src/spawn-wrangler-dev.ts` boots via `createTestHarness()` instead of
`spawn()`, with every existing consumer unchanged in behavior.

Consumers — enumerate with `grep -rn 'spawnWranglerDev' packages apps --include='*.ts'`
(5 at time of writing: the `/live` harness core, and the ui-smoke, browser, and chromium
global-setups in `apps/nebula`, plus the browser global-setup in `packages/mesh`).

Translate the `extraArgs` in use today. Each existing `--var K:V` becomes a `vars` entry;
`--log-level` has no equivalent and drops. The three that need judgment:

- **`--local`** — per D5, an inline stripped config. Prove it in the no-creds lane before landing.
- **`--local-protocol https`** (`apps/nebula/test/browser`) — likely vestigial. The lane's
  same-origin vite proxy terminates TLS server-side, and ui-smoke already runs plain
  `http://localhost`, a secure context where `Secure; SameSite=Strict` cookies flow. Verify by
  running that lane over http before deleting the flag; if it is load-bearing, this lane stays on
  the old path and that is recorded here, not silently.
- **`--persist-to`** (`apps/nebula/test/chromium`) — no equivalent found. Determine what the lane
  actually needs from a custom state dir; if it is load-bearing, same treatment.

The function no longer spawns anything, so the name lies. Rename it and the `@lumenize/testing/wrangler`
subpath export accordingly — it is a public subpath but appears in **no** website doc (verified),
so the blast radius is the five call sites.

**Success Criteria**:
- [ ] The utility boots via `createTestHarness`; no `child_process` and no stdout scraping remain
      in it
- [ ] All five consumers pass unchanged except for the rename
- [ ] The no-creds lane (no `CLOUDFLARE_API_TOKEN`, no wrangler OAuth) boots green — this is the
      CI lane and the phase does not land without it
- [ ] `--local-protocol https` and `--persist-to` each either removed with a one-line note on why
      they were vestigial, or documented here as load-bearing with their lane left on the old path
- [ ] Ready-timeout and cleanup behavior preserved — see `apps/nebula/harness/FINDINGS.md` on the
      SIGINT-to-workerd-child fix in the ready-timeout path; do not regress it
- [ ] `npm test` green; the ui-smoke lane green locally with Docker

## Phase 3: Surface the new capabilities, with a consumer

**Goal**: The capabilities that justify this task are reachable from the lanes, and at least one
real consumer proves each — a capability with no consumer is the YAGNI trap `workflow.md` names.

**Success Criteria**:
- [ ] The boot result exposes structured logs, DO SQL access, and DO eviction, thinly wrapped —
      the wrapper adds our ergonomics, not a second abstraction over wrangler's
- [ ] `bootDevStack` in the `/live` harness core exposes them on `DevStack` so scenarios can use them
- [ ] At least one existing `/live` scenario asserts on a **transient or server-side** surface it
      previously could not reach — `testing.md`'s self-healing-end-state trap is exactly what DO SQL
      access is for
- [ ] A new scenario drives the eviction path: force `evictDurableObject(..., 'hibernate')` on a DO
      with a live client socket, and confirm the client's in-flight work completes across the cold
      incarnation. This is the ADR-003 claim; if it does **not** hold, that is a finding and a
      task-file entry, not something to paper over
- [ ] Anything found here that is worth locking in becomes a vitest test per `live.md` — state
      explicitly which findings were promoted and which were left as exploration

## Phase 4: Rules and docs

**Goal**: The next session reaches for the right instrument without re-deriving this.

**Success Criteria**:
- [ ] `live.md` names the DO-introspection and eviction capabilities as part of the `/live` harness,
      keeping the exploration-vs-`testing.md` boundary explicit
- [ ] `testing.md` § "What a skipped test needs to run" reflects that some previously
      un-runnable cases (forced DO eviction, DO storage inspection outside the isolate) now have a
      home, and says which
- [ ] `durable-objects.md`'s root-vs-package wrangler-version warning is updated or retired
      depending on what Phase 1 leaves true
- [ ] `experiments/wrangler-test-harness/` pruned per `workflow.md` once its results are captured
      here — remove its `workspaces` entry and `git rm`

## Notes

- **Sequencing**: independent of the in-flight `tasks/nebula-identity-data-model.md`. Phase 1 is
  standalone and low-risk; Phases 2–4 are tooling work with no product dependency, so this can wait
  for a seam rather than interrupt.
- **Open question for review**: whether Phase 3's wrapper belongs in `@lumenize/testing` (where the
  boot utility lives) or in the `apps/nebula` harness. `@lumenize/testing` is the MIT package and
  the capability is generic, which argues for the package — but there is no non-Nebula consumer
  today.
- The spike deliberately did **not** test multi-worker mode or `scheduled()`. Multi-worker is
  interesting for a future gateway/tenant split; `scheduled()` becomes relevant with
  `tasks/nebula-outside-world.md`. Neither is in scope here.
