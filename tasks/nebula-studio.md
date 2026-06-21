# Nebula Studio

**Phase**: 9 — the demo's end-of-line goal.
**Status**: Active — the Studio **build** task file.
**App**: `apps/nebula/`.
**Master task file**: [`nebula.md`](nebula.md).

> **Architecture is canonical in [`nebula-dev-flows.md`](nebula-dev-flows.md)** (the Cast, Decisions 1–11, and Flow 1 / 1b / 1c / 2 / 2b). This file is the **build plan**; it references those flows and does **not** restate the model. The **codegen + evaluation** work lives in [`nebula-agentic-development-engine.md`](nebula-agentic-development-engine.md) and comes later — this file wires only a *minimal, unevaluated* system prompt.

**Prerequisites (built):** Resources core (storage + validation/ontology + the `transaction()`/`subscribe()` engine), the Vue frontend (`@lumenize/nebula/frontend`, on `main`), structural DO scope isolation, and the 4th node type (`LumenizeContainer`/`NebulaContainer`, ADR-007 Accepted). **References:** `website/docs/nebula/coding-your-ui.md`; `docs/nebula-resources-design.md`.

## Goal

The conversational experience where a user-developer describes what they want, the agentic development engine generates their product (ontology + UI), and it runs live with real access control. Studio is the demo's wow moment — "I want to build X" → working app on screen, then iterate. The user-developer never opens a code editor: **describe → generate → preview (repeat)**.

> Demo-narrative storyboard is deferred until the generation loop is validated end-to-end — but it's a **cold start** (we may edit the video to trim any long waits).

## The participant model (build target)

Per `nebula-dev-flows.md`, the cast is **DevStudio** (server DO — orchestrates the agentic loop, sole writer + source-of-truth via a shell `Workspace` + local git), **DevContainer** (a disposable Cloudflare Container running real `vite`/HMR — DevStudio pushes source to it via `applyChanges`), **Studio UI** (the chat SPA, served from **Workers Assets**), and the **Preview app** (the running generated app, embedded in an iframe in Studio UI). Dev data is a plain **`Star` at the `{u}.{g}.dev` instance** (no `DevStar` class). All node↔node edges are mesh.

## DevContainer dev loop (build)

The dev-loop *flow* is Flow 1 / 1c; the build specifics:

- **`DevContainer extends NebulaContainer`**, bound `DEV_CONTAINER`, addressed at the `{u}.{g}.dev` instance (`generateBindingVariations` keeps it disjoint from `STAR`); a smart-match guard routes `*.*.dev` shell requests to it. Two ports: **`:5173` vite** (public, ungated — shell + HMR) and **`:9000` command-server** (**host-DO-only** — `exec`/`writeFile`/`viteControl`/git). `fetch()` is a three-way branch (WS verbatim / shell-buffer+inject / asset stream) and **strips `cf-container-target-port`** so the public path can never reach `:9000`.
- **Scope-injection choke point:** DevContainer injects the **server-derived** `activeScope`/`authScope` (from `lmz.instanceName`, never the request) into the shell HTML as `<meta name=nebula-scope>` — the wrong-Star footgun guard.
- **Command methods carry `@mesh(requireAdmin)`** (not bare `@mesh`); `writeFile` validates its path (no traversal).
- **Two entrypoint edits:** (M3) add `DEV_CONTAINER` to the serving-target switch; (M2) allow the HMR WebSocket via a distinct `onBeforeConnect` touch-point (ungated, like the shell).
- **Deps are baked** into the container image (curated UI-lib set — DaisyUI, Lucide [ISC], etc.) → **zero `npm install` on cold boot** (CF containers have no persistent volume, so baking is the only durable store; `standard-1`/½-vCPU clears the `vite build` starvation bar). Cold boot = boot + DevStudio re-pushing the full source tree (Flow 1c).
- **vite fully owns SFC compile** — the Star never compiles, there is no in-DO compile machinery. vite diagnostics come back as method-return data over the command channel for the agentic loop to read.
- **Deploy:** local container-image push works via **Docker Desktop + WARP** (`[[cf-container-deploy-proxy]]`); CI workflow is the headless fallback.

**Test strategy (vitest-pool-workers reality, `[[container-no-construct-pool-workers]]`):** `extends Container` can't construct under vitest-pool-workers, so test the composed seam via non-Container harnesses + pure prototype tests — the entrypoint serving-target gate (inert stub-DO bindings), the HMR-WS allow gate, the scope-injection as a pure derivation, the `writeFile` path guard; assembled-construction e2e is a deploy-gated `it.skip`. Dev runs under local `wrangler dev` on **Docker Desktop**; deployed e2e gates on the first full `apps/nebula` Worker deploy.

### Dev-data reset (`resetDevData`, on Star@.dev)

The wipe re-homes onto the plain `Star` (the dev data Star at `{u}.{g}.dev`); its **trigger** is the Flow 1b server→client prompt (`nebula-dev-flows.md` Decision 11), not breaking-change detection.

- **`@mesh(requireAdmin)`, hard-guarded to `.dev`**: `if (!instanceName.endsWith('.dev')) throw`. Body = `blockConcurrencyWhile(deleteAll() → onStart())`.
- `onStart()` must be a **complete re-init**: reconstruct DagTree / Resources / Subscriptions, recreate schema + `ROOT`, and **null `Star.#row`/`#facet`** so no stale validator-facet cache survives. Founder root-admin **reseeds** on the next admin call's `onBeforeCall` first-touch.
- **Caveats:** if `svc.alarms` is ever used, evict the cached Alarms service too; the bounded in-flight-write edge (generation-counter hardening) is deferred under the single-admin demo contract.
- **Data bargain:** additive ontology changes preserve data; breaking ones reset it (the user decides via the wipe prompt). Standing guard: **every added `@mesh` method on the dev Star is admin-gated** (a `@mesh`-surface-freeze test). The `dev` 3rd-segment slug is reserved.
- **Out of scope:** URL-level branching, seeding a dev Star from prod (fork-to-test), concurrent `dev-<name>` sandboxes (`tasks/on-hold/nebula-branches.md`).

### Publish (Flow 2) — *post-demo, imminent*

Publish is a fast DevStudio-orchestrated command (Studio UI → DevStudio → DevContainer → Galaxy), not a file push. Per Flow 2/2b: **DevContainer runs `vite build` → pushes the built bundle + assets (R2 asset set) to Galaxy**; Galaxy is the **published-only** immutable app-version registry; a deployed (prod) Star **lazy-pulls** on version mismatch (Flow 2b). One unified version: app-version = ontology version (Decision 9).

- **Security:** Galaxy publish/admin methods carry `@mesh(requireAdmin)` — `<id>.*` scope widening admits descendant non-admins, so re-validate every browser-supplied field server-side. **Test patterns:** maintain the B5 frozen non-admin allow-list; a genuinely-minted in-scope non-admin must be **rejected + write nothing**; assert publish atomicity via debug-sink markers.
- **Post-demo seams** (none demo-blocking — the demo *is* the dev loop; prod serve = Flow 2b, out of demo scope):
  - **Binary file-assets (`ArrayBuffer` resources) — *right after demo*.** Generated apps will want a custom logo / images / fonts almost immediately; store + serve binary assets (as `ArrayBuffer`-valued resources or in the asset set).
  - **Custom-domain routing — *down the road*.** Map a user-developer's own domain onto their app. We do **NOT** chase "clean URLs": the `bindingName` + `{u}.{g}.{s}` instance-name convention is baked into how mesh routes, and fighting it is a permanent footgun. The scoped URL stays the URL — users won't parse "star", but they recognize the three dot-segments (company · product · their org).
  - **Prod version catch-up — *right after demo*.** When a prod Star first sees a newer app-version, Flow 2b lazy-pulls that version's validator/ontology from Galaxy; static assets serve from the edge regardless, so this is just the brief catch-up window (the first version-bearing op waits on the pull). *(The earlier "`Star.onRequest` can't await → loading-shell + reload" framing was old-in-DO-serve salvage and no longer applies — serving is static.)*

## Studio-generated artifacts

The engine generates two artifacts that must stay coherent (the UI references entity/field names and access patterns that match the current ontology exactly):

1. **Ontology** — a `.d.ts` file (TypeScript types + annotations; see `nebula-agentic-development-engine.md` for the `@title`/`@description`/`@inverse` conventions). DevStudio compiles it to a runtime validator (dev) / Galaxy compiles for prod; the Star never compiles. Resources are served by the platform's `Resources` engine, configured entirely by the ontology.
2. **UI** — `.vue` Single-File Components (`<script setup>`, TS) bound to the factory's reactive store (`store.resources.*` / `store.ui.*`). Components import `{ store, client }` from the scaffolded `nebula.ts`; NebulaClient stays out of component code. Patterns: `website/docs/nebula/coding-your-ui.md`.

**Source-of-truth = DevStudio's shell `Workspace`** (SQLite + R2) + local git (isomorphic-git). There is no separate VFS and (now) no "files-as-resources" model — the source tree lives in DevStudio; DevStudio pushes it to the DevContainer (`applyChanges`) and re-pushes on cold boot. The agentic loop reads/writes the tree locally against the Workspace (the LLM hot path).

### Bootstrap files (baked framework skeleton + a seeded app)

The **framework skeleton** (vite config, `index.html`, `main.ts`, the `nebula.ts` bootstrap, HMR wiring) is **baked into the container image** (same for every app, version-coupled to the container/vite). DevStudio **pushes the per-app source** (`App.vue`, components, ontology `.d.ts`); first-run seeds a minimal `App.vue` + starter ontology (`nebula-dev-flows.md` "Flow 0 · new app"). `nebula.ts` is the one bootstrap file the Studio LLM may extend (per-type conflict resolvers, first-run resource bootstrap):

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

**Why baked — and the planned relaxation.** The long pole in container cold-start is **npm unpacking**; baking the approved **Vue + DaisyUI + Lucide** set into the image removes it entirely for those apps (together with the no-persistent-volume fact from *DevContainer dev loop* — there's nowhere to cache an install across instances). This is a **short-term optimization**: Cloudflare is adding **Container snapshots** (tracked in `nebula-dev-flows.md` § *Future capabilities*). Once snapshots land, we tolerate **one long `npm install` on first build** (the snapshot captures the result) and **open up the dependency surface** — dev-users can pull in more client-side libraries and version their dependencies at will. The invariant that never relaxes: the Studio system prompt always forces server-side **Resources** (no dev-user-authored server logic outside that surface).

### Same-origin requirement (verification checkpoint)

Generated apps + the Studio UI must serve all scripts **same-origin under strict `script-src 'self'`** (no CDN / `unsafe-eval` / inline import map). Under the canonical model this is satisfied **for free** by Workers Assets (Studio UI, Decision 3) + vite static serving (Preview app) — so it's a *verification checkpoint*, not a build task. Styling/icons (DaisyUI, Lucide [ISC — correct `ATTRIBUTIONS.md`]) are ordinary baked container deps. Prod = `vite build` → Workers Assets (no running container; ~28× CSS win vs the retired in-DO bundle).

## Minimal codegen system prompt (unevaluated)

For the demo, wire a **single minimal system prompt** that hands the engine: the current ontology `.d.ts` (read locally from DevStudio's Workspace), the Nebula API `.d.ts` (resource ops, `client.orgTree.*`, permissions, subscriptions — types-as-API-docs, ADR-001), and the `coding-your-ui.md` patterns. **Do not over-invest here** — prompt iteration, few-shot, model/prompt evals, and the rigorous regression suite all live in [`nebula-agentic-development-engine.md`](nebula-agentic-development-engine.md). The viability is already proven (Kimi one-shots compilable Nebula UI and self-corrects in a thin loop); the demo bar is "compiles + runs + feature present + access-control enforced," not a quality score.

## Authoring environment — chat-first + live preview

**Web, chat-first.** ~90% of time is in chat; there is **no editable code editor and no file tree** outside the chat window — and **no separate pinned-ontology pane** either. When the engine shows code (incl. the ontology), it's **read-only within the chat**, surfaced inline and asked about. The recourse for "wrong code" is to talk to the engine, not edit it (a user edit desyncs the LLM's mental model). No "drop to the editor" escape hatch by default.

- **Persistent split:** chat one side, **live preview** (the feedback signal) always visible on the other.
- **Preview mechanism:** in-window **iframe** (same-origin per Decision 3 — auth via JWT over `/gateway`, shell via `/dev-container`); fallback = seamlessly **launch (or focus) a separate browser window** on the preview URL (window-handle reuse). **Auto-update is HMR** (vite `js-update`, patched in place ~milliseconds — not a full reload).
- **Preview-element highlight — *post-demo; the planned way to work*:** (the native gesture): the user clicks an element in the running preview; the engine maps the click to the source range; the user describes the change. They think in the preview, not in files. A text-span highlight in a chat-surfaced file is the precision fallback. Feasible because the Preview app is a **same-origin iframe** in Studio UI — Studio UI can read its DOM/state directly to do the click→source mapping. (Shares the "observable preview" machinery with the engine's rendered-output self-feedback — see *Iteration loop*.)
- **Speech-to-text correction lane — *post-demo; the planned way to work*:** show the transcript in an editable field before send; optional auto-send after N seconds of silence with cancel + edit.

## Iteration loop

The engine must see what's broken to fix it.

- **Runtime-error feedback:** the loop self-corrects from *runtime* failures, not just compile errors — the kimi-ui-gen viability run needed this (it caught an invented `op:'set'` that compile can't). **Demo:** the engine reads recent runtime/validation failures via `get_recent_errors`. **Post-demo (rich):** extend `@lumenize/debug` to tail into the chat, namespace-scoped, with the engine subscribing to *suspect* namespaces so it focuses instead of drowning. (Compile errors are a separate demo channel — vite diagnostics as method-return data, see *DevContainer dev loop*.)
- **Rendered-output self-feedback — *post-demo (big lift)*:** beyond runtime errors, let the engine observe the *running preview itself* and self-correct — the user says "element A floats over B" (or the engine notices unprompted) and it keeps adjusting CSS/HTML until fixed, autonomously. Two tiers: **structural** (DOM + computed styles + state) is cheap-ish — Studio UI reads the **same-origin Preview iframe** and serializes it to the engine; **visual** (pixel-level overlap/layout) is the harder tier — screenshot → vision model. Increasingly tractable (headless-browser-driven-by-AI is now common; Claude Code ships preview self-feedback). Shares the "observable preview" machinery with the preview-element-highlight gesture (*Authoring environment*).
- **Agentic surface** (the tools the engine calls):
  - **Edit source** — `writeSource(path, content)`: the engine's core action. DevStudio commits it, then pushes the change to the DevContainer → vite HMR (Flow 1). The **ontology `.d.ts` is edited exactly the same way** — it's just another source file.
  - **Read source** — the engine reads from DevStudio's Workspace directly (relevant files + the **pinned ontology** ride in context; on-demand reads as needed). No `get_current_ontology` — redundant now that the ontology is a source file, not a Galaxy-fetched registry entry.
  - **Runtime errors** — `get_recent_errors` (demo); `subscribe_debug_namespace` / `unsubscribe_debug_namespace` (post-demo). See *Runtime-error feedback* above for the why + the demo/post-demo split.
  - **Publish** *(post-demo — imminent)* — `publish()` (Flow 2).
  - *(Migrations are future + fuzzy — no concrete tool surface; see* Future capabilities *§ Lazy schema migration.)*

## Conversation flow

Cold-start interview is the wow moment.

- **Interview pattern:** start with the **core entity** → relationships → workflows → access patterns; reflect back; generate a **draft ontology early** as a live, correctable artifact.
- **Tone:** thoughtful product manager, not a form — make + flag assumptions, don't ask about every detail.
- **Wizard-style flow (the phases):** **context first** — understand *who* the user-developer is so the wizard tailors its detail + tone, then the product **vision & scale** (single-person / small-team / enterprise / multi-tenant), which surfaces the **access-control model** early. The Studio LLM can lean on [`website/docs/nebula/access-control.md`](../website/docs/nebula/access-control.md) — *the same app implemented two different ways* — to propose the right model for the situation. Then the **ontology** (the data-model interview above, validated coherent) → the **UI** (against the validated ontology); back-and-forth throughout. (A migration-validation gate is post-demo; the demo wipes the dev Star on breaking edits via the Flow 1b prompt.)

## Future capabilities (tracked, not demo)

**Standalone** future directions (whole capabilities with no single home). Feature-specific post-demo items live *inline* with what they extend — e.g. Publish § *Post-demo seams*, *Iteration loop* (rendered-output self-feedback), *Authoring environment* (preview-element highlight) — and many smaller ones are in `backlog.md`.

- **Lazy schema migration** (the future of the breaking-edit wipe): a per-Star **copy-on-read** runner — runs against the routed Star's own SQLite with **no Star-identity awareness** (identical on `.dev` and prod; Decision 11 lockstep). Hard boundary: **default-fill is the parser's job, not migration's** (additive `@default` fills on next write; migrations are *only* for renames / type-changes / required-adds / computed). When built, it rides the **per-resource ontology-version stamp + `OntologyStaleError`**, never a Galaxy registry. **Many moving pieces, not one `propose_migration` tool (TBD):** the **non-deterministic** lazy-migration code is **proposed by the Studio LLM** and applied by that copy-on-read runner; separately, **deterministic SQL-schema migrations** only become necessary once user-developers can define their own **indexable fields**. Production-polish schema evolution (cross-resource callbacks, version skew, error UX) is the broader on-hold surface: `tasks/on-hold/nebula-5.5-schema-evolution.md`. (Folded from `tasks/archive/nebula-lazy-schema-migrations.md`.)
- **Enterprise BYO-agent:** power users on their own coding agents (Claude Code / Cursor) expect a real **git + filesystem** surface, not the checkpoint metaphor. Worked example: GitHub-Enterprise + Claude-Code → push-to-main webhook/GH-Action → `git.clone` into a build DO's `Workspace` → build → push the built bundle to Galaxy (runs on `WorkspaceFileSystem` today, no Artifacts dep). Strongest argument for a post-demo desktop authoring shell. (Folded from `tasks/archive/nebula-file-storage-backend.md`.)
- **Built-artifact (compiled bundle) store** behind Galaxy's version API — keep the API backend-agnostic so the store choice (R2 asset set today / KV / shell `Workspace` / Artifacts) stays a `StateBackend` swap, not an API change. (If a SQLite-table backend is ever chosen, a PK change — e.g. adding `version` → `(version, path)` — is a full table rebuild under a schema-version latch, not an `ALTER`.)
- **In-app AI chat** (every Nebula app auto-gets one): post-Studio RAG against the app's own data; same agentic substrate (`nebula-agentic-development-engine.md` § Two agentic contexts).
- **DevStudio Skills** (the open `SKILL.md` standard): `tasks/on-hold/nebula-skills.md`.

## Out of scope (demo)

- Server-side ORM enforcement of relationships and referential integrity (UI handles client-side).
- Long-term Studio-session archival / cleanup.

## Success criteria

- [ ] User-developer describes a data model in natural language → working ontology + resources on the dev Star.
- [ ] Generated code reaches the DevContainer (`applyChanges`) and passes schema validation.
- [ ] Preview shows live UI components backed by real Resources, updating via HMR.
- [ ] describe → generate → preview → adjust cycle feels fast (HMR sub-second; full regenerate a few seconds).
- [ ] Cold-start interview produces a usable **first version of the app** (ontology + UI) in under 5 minutes (demo target).

## Build sequencing

> **Phase numbering** continues from the experiment-validation **Phases 0–3** (node-type smoke · command channel · scope-injection · egress + sizing) that ran on the now-archived [`nebula-container-dev-loop.md`](archive/nebula-container-dev-loop.md) — full history there and in the `project_studio_uibuild_pivot` memory. This file picks up at **3.5** (real `apps/nebula` integration) and **4** (teardown).

1. **Phase 3.5 — `apps/nebula` DevContainer integration** (the dev loop above): real `DevContainer` + vite image + `DEV_CONTAINER` binding + `containers` block + `fetch()` branch + command-channel `@mesh(requireAdmin)` + the two entrypoint edits. Mechanism-validated on the (torn-down) experiments; the e2e gates on the first full `apps/nebula` Worker deploy. Ships mechanism-only (`it.skip` for the deploy-gated e2e).
2. **Phase 4 — in-DO teardown** (gated on 3.5 — deleting sooner would remove Studio's only preview path). This is the biggest pivot in the repo, so aim to get **all** the vestigial code *now* — a long tail discovered months later is the usual failure mode. Method:
   - **Salvage, then targeted residual-grep delete** of the retired in-DO serve/compile machinery: `getPlatformAsset` · `compileSFC` · `rewriteServedSpecifiers` · `platform-assets` · `bundle-tsc`. ⚠️ `bundle-tsc` = `apps/nebula`'s SFC bundler (`scripts/bundle-tsc.mjs` + `vendor/tsc-transpile.bundle.mjs`) **only** — NOT `packages/ts-runtime-parser-validator`'s (the validator's compiler, used by Galaxy — stays). **Keep** the reload channel (→ publish-refresh signal) and `nodejs_compat`.
   - **Static vestigial sweep** beyond the known symbols: for each remaining symbol/file, grep for any `src` reference — defined-but-never-imported = dead. `tsc --noUnusedLocals` / `--noUnusedParameters` for local dead code. (A dead-export/-file tool — `knip` / `ts-prune` — would automate it; **ask before adding the dep**.)
   - **Coverage-driven cascade loop:** run `vitest --coverage`; delete a dead symbol → re-run. Tests still green ⇒ safe (didn't cut live code); any **survivor whose coverage drops to ~0** was only reached *through* what you deleted → confirm it has no remaining `src` reference → delete → repeat until coverage stabilizes. (The deletions also lift toward the Branch >80% / Statement >90% targets — dead code was dragging them down.)
   - **Verify:** full suite green · `type-check` clean · coverage targets met.
3. **Codegen + eval** — `nebula-agentic-development-engine.md` (wire the minimal prompt here; quality/eval there).
