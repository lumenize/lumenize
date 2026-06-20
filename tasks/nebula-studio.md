# Nebula Studio

**Phase**: 9 — the demo's end-of-line goal.
**Status**: Active — the Studio **build** task file.
**App**: `apps/nebula/`.
**Master task file**: [`nebula.md`](nebula.md).

> **Architecture is canonical in [`nebula-dev-flows.md`](nebula-dev-flows.md)** (the Cast, Decisions 1–11, and Flow 1 / 1b / 1c / 2 / 2b). This file is the **build plan**; it references those flows and does **not** restate the model. The **codegen + evaluation** work lives in [`nebula-agentic-development-engine.md`](nebula-agentic-development-engine.md) — this file wires only a *minimal, unevaluated* system prompt.

**Prerequisites (built):** Resources core (storage + validation/ontology + the `transaction()`/`subscribe()` engine), the Vue frontend (`@lumenize/nebula/frontend`, on `main`), structural DO scope isolation, and the 4th node type (`LumenizeContainer`/`NebulaContainer`, ADR-007 Accepted). **References:** `website/docs/nebula/coding-your-ui.md`; `docs/nebula-resources-design.md`.

## Goal

The conversational experience where a user-developer describes what they want, the agentic development engine generates their product (ontology + UI), and it runs live with real access control. Studio is the demo's wow moment — "I want to build X" → working app on screen. The user-developer never opens a code editor: **describe → generate → preview → adjust**.

> Demo-narrative storyboard is deferred until the generation loop is validated end-to-end.

## The participant model (build target)

Per `nebula-dev-flows.md`, the cast is **DevStudio** (server DO — orchestrates the agentic loop, sole writer + source-of-truth via a shell `Workspace` + local git), **DevContainer** (a disposable Cloudflare Container running real `vite`/HMR — DevStudio pushes source to it via `applyChanges`), **Studio UI** (the chat SPA, served from **Workers Assets**), and the **Preview app** (the running generated app, embedded in an iframe). Dev data is a plain **`Star` at the `{u}.{g}.dev` instance** (no `DevStar` class). All node↔node edges are mesh.

## DevContainer dev loop (build)

The dev-loop *flow* is Flow 1 / 1c; the build specifics:

- **`DevContainer extends NebulaContainer`**, bound `DEV_CONTAINER`, addressed at the `{u}.{g}.dev` instance (`generateBindingVariations` keeps it disjoint from `STAR`); a smart-match guard routes `*.*.dev` shell requests to it. Two ports: **`:5173` vite** (public, ungated — shell + HMR) and **`:9000` command-server** (**host-DO-only** — `exec`/`writeFile`/`viteControl`/git). `fetch()` is a three-way branch (WS verbatim / shell-buffer+inject / asset stream) and **strips `cf-container-target-port`** so the public path can never reach `:9000`.
- **Scope-injection choke point:** DevContainer injects the **server-derived** `activeScope`/`authScope` (from `lmz.instanceName`, never the request) into the shell HTML as `<meta name=nebula-scope>` — the wrong-Star footgun guard.
- **Command methods carry `@mesh(requireAdmin)`** (not bare `@mesh`); `writeFile` validates its path (no traversal).
- **Two entrypoint edits:** (M3) add `DEV_CONTAINER` to the serving-target switch; (M2) allow the HMR WebSocket via a distinct `onBeforeConnect` touch-point (ungated, like the shell).
- **Deps are baked** into the container image (curated UI-lib set — DaisyUI, Lucide [ISC], etc.) → **zero `npm install` on cold boot** (CF containers have no persistent volume, so baking is the only durable store; `standard-1`/½-vCPU clears the `vite build` starvation bar). Cold boot = boot + DevStudio re-pushing the full source tree (Flow 1c).
- **vite fully owns SFC compile** — the Star never compiles, there is no in-DO compile machinery. vite diagnostics come back as method-return data over the command channel for the agentic loop to read.
- **Deploy:** local container-image push works via **Docker Desktop + WARP** (`[[cf-container-deploy-proxy]]`); CI workflow is the headless fallback.

**Test strategy (pool-workers reality, `[[container-no-construct-pool-workers]]`):** `extends Container` can't construct under vitest-pool-workers, so test the composed seam via non-Container harnesses + pure prototype tests — the entrypoint serving-target gate (inert stub-DO bindings), the HMR-WS allow gate, the scope-injection as a pure derivation, the `writeFile` path guard; assembled-construction e2e is a deploy-gated `it.skip`. Dev runs under local `wrangler dev` on **Docker Desktop**; deployed e2e gates on the first full `apps/nebula` Worker deploy.

### Dev-data reset (`resetDevData`, on Star@.dev)

The wipe re-homes onto the plain `Star` (the dev data Star at `{u}.{g}.dev`); its **trigger** is the Flow 1b server→client prompt (`nebula-dev-flows.md` Decision 11), not breaking-change detection.

- **`@mesh(requireAdmin)`, hard-guarded to `.dev`**: `if (!instanceName.endsWith('.dev')) throw`. Body = `blockConcurrencyWhile(deleteAll() → onStart())`.
- `onStart()` must be a **complete re-init**: reconstruct DagTree / Resources / Subscriptions, recreate schema + `ROOT`, and **null `Star.#row`/`#facet`** so no stale validator-facet cache survives. Founder root-admin **reseeds** on the next admin call's `onBeforeCall` first-touch.
- **Caveats:** if `svc.alarms` is ever used, evict the cached Alarms service too; the bounded in-flight-write edge (generation-counter hardening) is deferred under the single-admin demo contract.
- **Data bargain:** additive ontology changes preserve data; breaking ones reset it (the user decides via the wipe prompt). Standing guard: **every added `@mesh` method on the dev Star is admin-gated** (a `@mesh`-surface-freeze test). The `dev` 3rd-segment slug is reserved.
- **Out of scope:** URL-level branching, seeding a dev Star from prod (fork-to-test), concurrent `dev-<name>` sandboxes (`tasks/on-hold/nebula-branches.md`).

### Publish (Flow 2)

Publish is a fast DevStudio-orchestrated command (Studio UI → DevStudio → DevContainer → Galaxy), not a file push. Per Flow 2/2b: **DevContainer runs `vite build` → pushes the built bundle + assets (R2 asset set) to Galaxy**; Galaxy is the **published-only** immutable app-version registry; a deployed (prod) Star **lazy-pulls** on version mismatch (Flow 2b). One unified version: app-version = ontology version (Decision 9).

- **Security:** Galaxy publish/admin methods carry `@mesh(requireAdmin)` — `<id>.*` scope widening admits descendant non-admins, so re-validate every browser-supplied field server-side. **Test patterns:** maintain the B5 frozen non-admin allow-list; a genuinely-minted in-scope non-admin must be **rejected + write nothing**; assert publish atomicity via debug-sink markers.
- **Gotcha (only if a bundle store keeps an `AppBundle` table):** adding a `version` column changes the PK to `(version, path)` → a schema migration (create-new / copy / drop / rename under a schema-version latch).
- **Post-demo seams:** sync `Star.onRequest` can't await a cold lazy-pull → a loading-shell + async ensure-version + reload; clean-URL / custom-domain routing; binary file-assets (`ArrayBuffer` resources); prod cold-start (unused compile machinery behind a Worker Loader facet).

## Studio-generated artifacts

The engine generates two artifacts that must stay coherent (the UI references entity/field names and access patterns that match the current ontology exactly):

1. **Ontology** — a `.d.ts` file (TypeScript types + annotations; see `nebula-agentic-development-engine.md` for the `@title`/`@description`/`@inverse` conventions). DevStudio compiles it to a runtime validator (dev) / Galaxy compiles for prod; the Star never compiles. Resources are served by the platform's `Resources` engine, configured entirely by the ontology.
2. **UI** — `.vue` Single-File Components (`<script setup>`, TS) bound to the factory's reactive store (`store.resources.*` / `store.ui.*`). Components import `{ store, client }` from the scaffolded `nebula.ts`; NebulaClient stays out of component code. Patterns: `website/docs/nebula/coding-your-ui.md`.

**Source-of-truth = DevStudio's shell `Workspace`** (SQLite + R2) + local git (isomorphic-git). There is no separate VFS and (now) no "files-as-resources" model — the source tree lives in DevStudio; DevStudio pushes it to the DevContainer (`applyChanges`) and re-pushes on cold boot. The agentic loop reads/writes the tree locally against the Workspace (the LLM hot path).

### Bootstrap files (baked framework skeleton + a seeded app)

The **framework skeleton** (vite config, `index.html`, `main.ts`, the `nebula.ts` bootstrap, HMR wiring) is **baked into the container image** (same for every app, version-coupled to the container/vite). DevStudio **pushes the per-app source** (`App.vue`, components, ontology `.d.ts`); first-run seeds a minimal `App.vue` + starter ontology (`nebula-dev-flows.md` "Flow 0 · new app"). `nebula.ts` is the one bootstrap file the LLM may extend (per-type conflict resolvers, first-run resource bootstrap):

```typescript
import { createNebulaClient } from '@lumenize/nebula/frontend';
export const { client, store, ready } = createNebulaClient({
  appVersion: __APP_VERSION__,    // injected by the serving layer
  authScope: __AUTH_SCOPE__,      // parent galaxy {u}.{g}
  activeScope: __ACTIVE_SCOPE__,  // {u}.{g}.dev in dev; the deployed star in prod
});
try { await ready; } catch { window.location.assign('/login'); }
```

`appVersion`/`authScope`/`activeScope` are **injected by the serving layer** (DevContainer in dev; the static-serve in prod) — server-derived, never request-supplied (the scope-injection choke point above).

### Same-origin requirement (verification checkpoint)

Generated apps + the Studio UI must serve all scripts **same-origin under strict `script-src 'self'`** (no CDN / `unsafe-eval` / inline import map). Under the canonical model this is satisfied **for free** by Workers Assets (Studio UI, Decision 3) + vite static serving (Preview app) — so it's a *verification checkpoint*, not a build task. Styling/icons (DaisyUI, Lucide [ISC — correct `ATTRIBUTIONS.md`]) are ordinary baked container deps. Prod = `vite build` → Workers Assets (no running container; ~28× CSS win vs the retired in-DO bundle).

## Minimal codegen system prompt (unevaluated)

For the demo, wire a **single minimal system prompt** that hands the engine: the current ontology `.d.ts` (read locally from DevStudio's Workspace), the Nebula API `.d.ts` (resource ops, `client.orgTree.*`, permissions, subscriptions — types-as-API-docs, ADR-001), and the `coding-your-ui.md` patterns. **Do not over-invest here** — prompt iteration, few-shot, model/prompt evals, and the rigorous regression suite all live in [`nebula-agentic-development-engine.md`](nebula-agentic-development-engine.md). The viability is already proven (Kimi one-shots compilable Nebula UI and self-corrects in a thin loop); the demo bar is "compiles + runs + feature present + access-control enforced," not a quality score.

## Authoring environment — chat-first + live preview

**Web, chat-first.** ~90% of time is in chat; there is **no editable code editor and no file tree** outside the chat window. When the engine shows code, it's **read-only within the chat**. The recourse for "wrong code" is to talk to the engine, not edit it (a user edit desyncs the LLM's mental model). No "drop to the editor" escape hatch by default.

- **Persistent split:** chat one side, **live preview** (the feedback signal) always visible on the other.
- **Preview mechanism:** in-window **iframe** (same-origin per Decision 3 — auth via JWT over `/gateway`, shell via `/dev-container`); fallback = seamlessly **launch (or focus) a separate browser window** on the preview URL (window-handle reuse). **Auto-update is HMR** (vite `js-update`, patched in place ~milliseconds — not a full reload).
- **Preview-element highlight** (the native gesture): the user clicks an element in the running preview; the engine maps the click to the source range; the user describes the change. They think in the preview, not in files. A text-span highlight in a chat-surfaced file is the precision fallback.
- **Speech-to-text correction lane:** show the transcript in an editable field before send; optional auto-send after N seconds of silence with cancel + edit.

## Iteration loop

The engine must see what's broken to fix it.

- **Remote debug tail:** extend `@lumenize/debug` to tail into the chat (namespace-scoped; the engine subscribes to suspect namespaces). Primary runtime-failure signal.
- **Agentic surface** (tools the engine calls): `get_current_ontology` (the pinned `.d.ts`, read from DevStudio's Workspace); `subscribe_debug_namespace(ns)` / `unsubscribe_debug_namespace(ns)`; `get_recent_errors(namespace?, since?)`; **`applyChanges(files)`** (DevStudio pushes source to the DevContainer → vite HMR — Flow 1) and **`publish()`** (Flow 2); *(future)* `propose_migration(from, to)` via the Star-local lazy runner.

## Conversation flow

Cold-start interview is the wow moment.

- **Interview pattern:** start with the **core entity** → relationships → workflows → access patterns; reflect back; generate a **draft ontology early** as a live, correctable artifact.
- **Tone:** thoughtful product manager, not a form — make + flag assumptions, don't ask about every detail.
- **Wizard-style flow:** ontology first (validated coherent) → UI second (against the validated ontology); supports back-and-forth. (A migration-validation gate is post-demo; the demo wipes the dev Star on breaking edits via the Flow 1b prompt.)

## Future capabilities (tracked, not demo)

- **Lazy schema migration** (the future of the breaking-edit wipe): a per-Star **copy-on-read** runner — runs against the routed Star's own SQLite with **no Star-identity awareness** (identical on `.dev` and prod; Decision 11 lockstep). Hard boundary: **default-fill is the parser's job, not migration's** (additive `@default` fills on next write; migrations are *only* for renames / type-changes / required-adds / computed). When built, it rides the **per-resource ontology-version stamp + `OntologyStaleError`**, never a Galaxy registry. (Folded from `tasks/archive/nebula-lazy-schema-migrations.md`.)
- **Enterprise BYO-agent:** power users on their own coding agents (Claude Code / Cursor) expect a real **git + filesystem** surface, not the checkpoint metaphor. Worked example: GitHub-Enterprise + Claude-Code → push-to-main webhook/GH-Action → `git.clone` into a build DO's `Workspace` → build → push the built bundle to Galaxy (runs on `WorkspaceFileSystem` today, no Artifacts dep). Strongest argument for a post-demo desktop authoring shell. (Folded from `tasks/archive/nebula-file-storage-backend.md`.)
- **Built-artifact (compiled bundle) store** behind Galaxy's version API — keep the API backend-agnostic so the store choice (R2 asset set today / KV / shell `Workspace` / Artifacts) stays a `StateBackend` swap, not an API change.
- **In-app AI chat** (every Nebula app auto-gets one): post-Studio RAG against the app's own data; same agentic substrate (`nebula-agentic-development-engine.md` § Two agentic contexts).
- **DevStudio Skills** (the open `SKILL.md` standard): `tasks/on-hold/nebula-skills.md`.

## Out of scope (demo)

- Server-side ORM enforcement of relationships (UI handles client-side).
- Production migration polish (cross-resource callbacks, version skew, error UX) — `tasks/on-hold/nebula-5.5-schema-evolution.md`.
- Cross-Star prod→dev data migration; long-term session archival; a fine-tuned Nebula model (→ engine file).

## Open questions

- Demo narrative: full cold start vs jump-in partway (leaning cold start).
- Does the pinned ontology view live in the UI alongside the chat?
- "File open for review" richness — plain vs syntax-highlighted read-only.
- Preview-element-highlight gesture — click / click-and-hold / hover-with-shift?

## Success criteria

- [ ] User-developer describes a data model in natural language → working ontology + resources on the dev Star.
- [ ] Generated code reaches the DevContainer (`applyChanges`) and passes schema validation.
- [ ] Preview shows live UI components backed by real Resources, updating via HMR.
- [ ] describe → generate → preview → adjust cycle feels fast (HMR sub-second; full regenerate a few seconds).
- [ ] Cold-start interview produces a usable draft ontology in under 5 minutes (demo target).

## Build sequencing

1. **Phase 3.5 — `apps/nebula` DevContainer integration** (the dev loop above): real `DevContainer` + vite image + `DEV_CONTAINER` binding + `containers` block + `fetch()` branch + command-channel `@mesh(requireAdmin)` + the two entrypoint edits. Mechanism-validated on the (torn-down) experiments; the e2e gates on the first full `apps/nebula` Worker deploy. Ships mechanism-only (`it.skip` for the deploy-gated e2e).
2. **Phase 4 — in-DO teardown:** salvage-first residual-grep deletion of the retired in-DO serve/compile machinery (`getPlatformAsset` / `compileSFC` / `rewriteServedSpecifiers` / `platform-assets` / `bundle-tsc`); **keep** the reload channel (becomes the publish-refresh signal) and `nodejs_compat`. Gated on Phase 3.5 (deleting it sooner would remove Studio's only preview path).
3. **Codegen + eval** — `nebula-agentic-development-engine.md` (wire the minimal prompt here; quality/eval there).
