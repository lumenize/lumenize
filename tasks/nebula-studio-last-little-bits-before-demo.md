# Nebula Studio — last little bits before the demo

**Status**: handoff doc, written 2026-06-21 at the end of the big Phase 3.5 + Phase 4 build session (context running low). The Studio **build** (`nebula-studio.md` Phases 3.5 + 4) is **DONE + green + committed**; this file captures the *remaining* pre-demo work, the **#1 item being a deploy-blocking design gap** found during the Phase-4 teardown.

> **Canonical refs** (read these, trust them over this file where they conflict): architecture = [`nebula-dev-flows.md`](nebula-dev-flows.md) (Cast, Decisions 1–11, Flows 1/1b/1c/2/2b); build plan = [`nebula-studio.md`](nebula-studio.md); codegen+eval (the next phase) = [`nebula-agentic-development-engine.md`](nebula-agentic-development-engine.md); master = [`nebula.md`](nebula.md). Memory: `project_studio_uibuild_pivot` + `reference_shell_isomorphic_git_pool_workers`.

## What's already done (this session — `feat/nebula-studio`)

Phase 3.5 (DevContainer + DevStudio + `resetDevData`→Star) and Phase 4 (in-DO serve/compile teardown + DevStar→Star collapse + Galaxy lazy-pull removal) are built, green (unit+frontend 197 · baseline 225 · container+dev-studio 23 · deploy-gated `it.skip`s), type-check clean, coverage Stmts 90.39%/Branch 82%. Commits: `5b4e287` (3.5), `4787cea` (P4-1), `e24cac8` (P4-2), `176a35c` (coverage cfg), `7ee89bb` (doc fixups), `fcb1064` (this backlog item). NOT committed: nothing of ours is pending; `docs/` is owned by a separate session — **leave `docs/` alone**.

Key shape now: `DevStudio` (`src/dev-studio.ts`, shell `Workspace`+isomorphic-git, sole source-of-truth) compiles the ontology `.d.ts` → `Star.setOntology` (no Galaxy round-trip) and pushes source to `DevContainer` (`src/dev-container.ts`, vite preview) via `applyChanges`. The dev Star is a plain `Star` at `{u}.{g}.dev` (no DevStar/DEV_STAR). `resetDevData` is on `Star`, hard-guarded to `.dev`.

---

## 🔴 #1 — Live dev-loop version contract (DEPLOY-BLOCKING; the prerequisite for the first working live preview)

### The gap
In the **assembled live preview** (deploy-gated, so untestable under vitest-pool-workers — that's why the suites are green and this slipped through):

- `DevContainer.fetch()` (`src/dev-container.ts`, the `injectScopeMeta(...)` call) injects **`appVersion: 'dev'`** (a hardcoded constant) into the shell as `<meta name="nebula-scope">`.
- The `nebula.ts` bootstrap (`container/app/src/nebula.ts`) reads that meta and passes `appVersion` to `createNebulaClient({ appVersion, authScope, activeScope })`.
- The client sends `appVersion` on **every** `transaction`/`read`/`subscribe`.
- But `DevStudio.applyOntology` (`src/dev-studio.ts`) installs the ontology under a **content-hash version** — `version = (await git.hashBlob({ object: types })).oid` (a 40-hex oid) — via `Star.setOntology(row)`. So the Star's *current* version is that oid, never `'dev'`.
- `Star`'s Handler-1 (`transaction`/`read`/`subscribe` in `src/star.ts`) does `#isCachedVersion(appVersion)`; `'dev' !== <oid>` → **`OntologyStaleError` on every live op.** The preview never works.

### Why we can't just make the version `'dev'` (the obvious-but-wrong fix)
`Star.#installState` loads the validator via `getParserValidatorFacet(ctx, env.LOADER, bundleId = galaxyId/version, () => row.validatorBundle)`. The **Worker Loader cache is keyed by `bundleId` per-Worker-project** (`durable-objects.md` § Dynamic Worker Loader cache). A constant `version='dev'` → the loader caches the *first* validator and serves it for every later ontology edit → **stale validator, silently**. The version MUST be content-unique. (This is exactly why `applyOntology` uses `git.hashBlob`; there's a capable-of-failing test for it in `test/test-apps/dev-studio/dev-studio.test.ts` — "version is CONTENT-ADDRESSED".)

### Hard constraint
**Decision 11** (`nebula-dev-flows.md`): "setting the current ontology is a general Star op" — the `.dev` specialness is **only** `resetDevData`. So **do NOT add a `.dev`-special branch to the transaction/read/subscribe hot path.** The version-match (`OntologyStaleError`) IS the prod Flow-2b skew-detection mechanism and must keep working for prod.

### Recommended direction (design it first — maybe a quick `/review-task`-style pass)
**Inject the *real* current version into the shell + reload the preview when the ontology changes.** This matches prod (the prod static-serve injects the *published* app-version; Flow 2b) and reuses the **reload channel we deliberately kept** in Phase 4 (`Star.subscribeReload`/`broadcastReload`/`NebulaClient.handleReload` — currently trigger-less, documented as "the publish-refresh signal"):

1. **DevContainer must learn the current version.** It's server-derived (lives on the Star, set by DevStudio). Candidates: DevStudio passes it to DevContainer (e.g. `applyChanges` carries it, or a small `setAppVersion`) and `DevContainer.fetch()` injects that instead of `'dev'`; OR the shell fetches it from the Star on load (extra round-trip). Injecting (DevStudio→DevContainer) is cleaner + keeps it server-derived.
2. **On an ontology change, re-sync the live preview.** After `applyOntology` (new oid) the already-loaded shell still has the *old* injected version → fire the **reload channel** (`broadcastReload`) so the preview reloads and picks up the new version. This is the kept channel's reason for being, and it mirrors prod (publish → client reloads to the new published version). Wire the trigger: `DevStudio.applyOntology` (or the save flow) → after `setOntology`, signal reload.

Alternative (weigh, but likely worse): a *general* (not `.dev`-special) "use-current" sentinel the client can send to skip skew-detection — rejected-leaning because it weakens the prod skew contract for everyone.

### Code pointers
- `src/dev-container.ts` — `injectScopeMeta(...)` call in `fetch()` (the `appVersion: 'dev'` literal); `applyChanges`/command methods (where DevStudio could pass the version).
- `src/dev-studio.ts` — `applyOntology` (the `git.hashBlob` version + `setOntology` call); `syncToDevContainer`/`ensureUp` (the push path that could carry the version).
- `container/app/src/nebula.ts` — the bootstrap reading the meta.
- `src/star.ts` — `#isCachedVersion` / `#currentVersion` / the three Handler-1s; `subscribeReload`/`broadcastReload` (the kept channel, needs a trigger).
- `src/nebula-client.ts` — `handleReload` (client side of the reload channel).
- Tracked in `backlog.md` (§ Nebula, top) + `nebula-studio.md` Phase 4 part 2 note.

---

## Other remaining pre-demo bits

- **First full `apps/nebula` Worker deploy** — a milestone of its own (intersects `nebula-release-process.md`). It unblocks the deploy-gated `it.skip` e2e: the assembled-container fetch()/HMR/`applyChanges` round-trip + the cold-boot re-push (Flow 1c), which `extends Container` can't exercise under vitest-pool-workers ([[container-no-construct-pool-workers]]). The `wrangler.jsonc` `migrations` block (all DOs `new_sqlite_classes`) + `containers` block already exist. Deploy via Docker Desktop + WARP ([[cf-container-deploy-proxy]]). ⚠️ Prod `apps/nebula/wrangler.jsonc` `vars` must NOT gain any admin/bootstrap/test-mode var — the deploy-gated e2e admin setup uses a *separate* deployed test-harness wrangler (`nebula-studio.md` § Deploy-gated e2e admin setup).
- **The codegen engine itself** — `nebula-agentic-development-engine.md` (Kimi 2.7 loop driving `DevStudio.writeSource`). That file is under-specified/unreviewed; it's the next big phase and is where the version-contract resolution above will likely land (the live dev-loop UX is its concern). A *minimal unevaluated* system prompt is all the demo needs (`nebula-studio.md` § Minimal codegen system prompt); prompt iteration/evals are deferred.
- **Kept-but-uncovered code** (deliberate, don't delete): Galaxy `appendOntologyVersion`/`getLatestOntologyVersion`/etc. (→ rename to app-level at publish) + the reload channel (gets its trigger + coverage from the version-contract work above).

## Suggested sequencing
1. Resolve the version contract (#1) — design (inject-real-version + reload-on-change), then build + a deploy-gated e2e. This is the live-preview prerequisite.
2. First `apps/nebula` deploy → turn the `it.skip` e2es green on real infra.
3. Wire the minimal codegen prompt (`nebula-agentic-development-engine.md`) → the cold-start interview → first generated app.
