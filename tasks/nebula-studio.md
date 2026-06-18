# Nebula Studio

**Phase**: 9 — the demo's end-of-line goal.
**Status**: Active.
**App**: `apps/nebula/` (Studio is the authoring experience for user-developers).
**Master task file**: `tasks/nebula.md`.

**Prerequisites (built):** Resources core (storage + validation/ontology + the `transaction()`/`subscribe()` engine) and the Vue frontend (`@lumenize/nebula/frontend`, merged to `main` 2026-06-15) are shipped and in use. Both demo prereqs are built: structural DO scope isolation (`tasks/nebula-do-scope-isolation.md`, `7c83407`) and the dev Star (`tasks/dev-star.md`, `fa9d4fb` — `DevStar extends Star`, with `deployToDev()` eager-apply + `resetDevData()` reset mechanism). Lazy in-place schema migration is deferred (`tasks/on-hold/nebula-lazy-schema-migrations.md`).

**References (not dependencies):** user-developer API surface `website/docs/nebula/coding-your-ui.md`; resources design `docs/nebula-resources-design.md`.

**Split out of this file:** code-generation model + eval strategy → `tasks/nebula-studio-llm-strategy.md`; the post-demo file-storage backend investigation (`@cloudflare/shell`/git) → `tasks/on-hold/nebula-file-storage-backend.md`.

> **Single sources of truth referenced, not restated here:** the dev-Star data-on-ontology-change bargain (additive preserved / breaking resets) lives in `tasks/dev-star.md` § *In-dev data lifecycle*; the model/eval strategy lives in the llm-strategy file above.

## UI-build architecture — container-vite pivot (GO lean, 2026-06-17)

The in-DO UI-build layer (compile `.vue` inside `DevStar`, serve the bundle from `Star.onRequest`, self-hosted vendored Vue/DaisyUI/Lucide) is **built + green** (tag `in-do-compile-baseline`) but hit ceilings: no Tailwind JIT / minimal CSS, no tree-shaking, no per-app lib pinning, a committed 3.4 MB tsc bundle (`tasks/nebula-self-hosted-assets.md`). A spike (`tasks/container-vite-spike.md` — see its FINDINGS) tested replacing it with a **real toolchain in a Cloudflare Container** and returned **GO** (no kill across Q1–Q4; deployed Q1/Q2 confirmed): `vite build` → **~2 kB gz CSS vs ~58 kB (~28×)**, JIT arbitrary utilities + tree-shaking, served container-less from static assets (≈ free prod).

**New architecture — replaces the build/serve layer only; the data layer (Star/Galaxy/mesh/reactive store) is unchanged:**
- **Dev:** a per-sandbox **`DevContainer` DO** (extends `@cloudflare/containers` `Container`) runs real `vite` (HMR), proxied same-origin through the DO. It is a **sibling of `DevStar`, not the Star** (different base class). The browser loads the app **shell** from DevContainer and makes **data** calls to DevStar — two same-origin paths, **no DO→DO hop** (DevContainer never relays data). The scope-injection choke point (`activeScope={u}.{g}.dev`) **moves from `Star.onRequest` to DevContainer** intercepting vite's shell HTML.
- **Prod:** `vite build` → static assets in **R2 / Workers Assets**, edge-served with **no running container**; prod `Star.onRequest` stops serving the bundle.
- Per-app **Tailwind JIT + lib pinning** move from post-demo (§ *Code-generation details*) to the dev toolchain; the precompiled-DaisyUI / vendored-asset story (`nebula-self-hosted-assets.md`) is superseded if this proceeds.
- **Deploy:** local container-image push fails (this machine → CF registry network path, not Docker — `[[cf-container-deploy-proxy]]`); container deploys go via the manual GHA workflow `.github/workflows/deploy-container.yml` (proven first try).

**Decided pre-demo (2026-06-17)** — the in-DO plan isn't far enough along, and has hit enough friction, that *finishing* it would be waste; the `in-do-compile-baseline` tag keeps it as zero-cost fallback. Work, **in order**:
1. **Q5 — agent command channel at the edge** (no host docker): a DO-mediated exec channel for vite/git/build, run as a **throwaway spike against a stubbed surface** — raw RPC is fine in experiment code (`tasks/spike-container-agent-channel.md`). The riskiest unproven piece + kill-fast viability gate. **Runs first** (don't build production node code or accept ADR-007 before it clears).
2. **The 4th node type** (`tasks/nebula-devcontainer-node-type.md`, **ADR-007 — Proposed**). `LumenizeContainer`/`NebulaContainer` is its **own** node type (about *using containers*), **not** a `LumenizeDO` — it composes the narrow **comms + guards** core (`lmz.call`/`lmz.ctn` + `onBeforeCall` + `@mesh()`, like `LumenizeWorker`; no alarms/`onStart`, raw `Container.fetch()`) onto `@cloudflare/containers` `Container`. Follows Q5's GO; the dev-loop reshape (#1a) builds `DevContainer` on it.
3. **Q6 — source durability:** the container working tree is ephemeral, so the Galaxy dual-write/rehydrate (§ *Durable draft ownership*; `nebula-app-versioning.md` Phase 2) becomes load-bearing — design-pinnable, no spike needed.

**Task-file reshape (after the gates):** #1a (`nebula-studio-compile-pipeline.md`) → a **container dev-loop** task; #1b (`nebula-app-versioning.md`) → registry points to **R2 asset sets** instead of in-DO `AppBundle` SQLite (the versioning concept survives). Don't archive the in-DO files until the container build lands.

## Goal

The conversational interface where user-developers describe what they want, the AI generates their product (ontology + UI), and the result runs live in DWL isolates with real access control. Studio is the demo's wow moment — investors see "I want to build X" → working app on screen.

The user-developer never opens a code editor. They describe in natural language, the AI generates, the preview updates, they iterate: describe → generate → preview → adjust.

> Demo-narrative storyboard is deferred until the generation loop is validated end-to-end — don't over-invest in narrative before then.

## Generation engine

Studio's code generation runs on **Kimi 2.7 (`@cf/moonshotai/kimi-k2.7-code`) via Workers AI** (binding mode), driven by a **thin, self-rolled tool-calling loop** on Workers + Durable Objects — **no agent framework (no Cloudflare Think) and no codemode**. Native tool-calling covers the loop; codemode's JSON tool-bridge is an ADR-002 violation (we round-trip full structured-clone everywhere). Claude models are not in the product (eval baseline only). Model/orchestration/eval detail: `tasks/nebula-studio-llm-strategy.md`.

- **Agent home: a Nebula-owned DO/facet**, co-located with the user for low-latency iteration (a facet shares its supervisor's colo + storage and needs no dynamic-worker loader for a static class). Because it's our class, our scope isolation applies.
- **Cost/latency optimization (pocketed for later): script-per-step execution** — the model writes one orchestration script per step, run in a facet sandbox with a **mesh/RPC full-type tool bridge** (never codemode's JSON). Start with per-call tool-calling; add this only if the loop proves too chatty. (Same dynamic-execution substrate powers the post-Studio in-app AI chat feature — see llm-strategy § Two AI contexts.)

> Gate before chat-UI polish: prove the loop produces working ontology + UI against the live platform (a small real app — todo/kanban/CRM — with access-control + reactivity intact). **Validated 2026-06-16** (`tasks/kimi-ui-gen-viability.md`): Kimi one-shot generates compilable Nebula UI, and a thin iterate-on-errors loop self-corrects.

## Studio-generated artifacts

The AI generates two artifacts that must stay coherent — the UI must reference entity names, field names, and access patterns that match the current ontology exactly:

1. **Ontology** — a `.d.ts` file: TypeScript types + annotations (validation today, ORM later). Processed by the existing upload pipeline onto the dev Star (Phases 5.2.x). There is no `ResourcesWorker` class — resources are served by the platform's `Resources` engine, configured entirely by the ontology.
2. **UI** — `.vue` Single-File Components (`<script setup>`, TS) bound to the factory's reactive store (`store.resources.*` / `store.ui.*`), per the 2026-05-15 SFC pivot. Components import `{ store, client }` from the scaffolded `nebula.ts`; NebulaClient stays out of component code. Generated TS is deployed to DWL isolates; schema validation via tsc-in-DWL (`@lumenize/ts-runtime-parser-validator`, shipped). Patterns: `website/docs/nebula/coding-your-ui.md`.

### Bootstrap files (auto-scaffolded, not LLM-authored)

Studio seeds a small fixed set of bootstrap files on app creation — identical across apps, not authored by code generation. They live in the app's file space (§ *Files as resources*) and keep the LLM focused on `.vue` components + ontology (the coding-your-ui doc omits them deliberately).

- **`nebula.ts`** — initializes the client + store once; top-level `await ready` so the app mounts only after the first connection (redirect to `/login` on terminal auth failure). `baseUrl` auto-detects to the page origin; `appVersion`, `authScope`, and `activeScope` are **injected by the serving layer** (the `Star.onRequest` injection contract is owned by `tasks/nebula-studio-compile-pipeline.md` § *Decisions pinned*). **This is the one bootstrap file the LLM may extend** — per-type conflict resolvers (`client.resources.onTransactionResourceResolution(...)`) and first-run resource bootstrap (read-then-create of per-user containers via `client.resources.createAndSubscribe(rt, rid, nodeId, value)`, added 2026-06-16) belong here.

  ```typescript
  import { createNebulaClient } from '@lumenize/nebula/frontend';
  export const { client, store, ready } = createNebulaClient({
    appVersion: __APP_VERSION__,    // serving layer substitutes at serve time
    authScope: __AUTH_SCOPE__,      // parent galaxy {u}.{g}
    activeScope: __ACTIVE_SCOPE__,  // {u}.{g}.dev in dev preview; the deployed star in prod
  });
  try { await ready; } catch { window.location.assign('/login'); }
  ```

- **`main.ts`** — Vue entrypoint (`createApp(App).mount('#app')`, imports `./nebula`). Never edited after scaffolding.
- **`index.html`** — minimal shell (`<div id="app">` + module script). Never edited after scaffolding.

**Dev vs prod differ in the injected scope + version:** the dev preview gets `activeScope={u}.{g}.dev` + `appVersion='dev'` (or build-stamped); a deployed app gets its star's `activeScope` + the version matching the deployed app bundle, so the server enforces app/ontology lock-step.

### Code-generation details

- **Styling: DaisyUI** (Tailwind component library, MIT) — pure CSS, strong LLM training coverage, theme system maps onto per-tenant branding. Demo ships a **precompiled** bundle; per-app Tailwind JIT (in Containers) at deploy time is post-demo.
- **Per-field runtime config (debounce, conflict resolvers, UI rendering hints) lives in ontology annotations, NOT separate JS config.** The typia/ontology compile pass emits a config map alongside the validator bundle; the factory applies it at startup. The LLM writes the annotation in one place rather than keeping a separate `transactionDebounce` call in sync. Vocabulary: `website/docs/nebula/ontology.md § Annotations`. The LLM consults this rule table during ontology generation (demo-scope, kept small):

  | User-developer intent → | LLM picks → | Effects (derived by framework) |
  |---|---|---|
  | "boolean toggle" → `field: boolean` | no annotation | `@debounce(0)` implied; eager commit |
  | "small set of choices" → `field: 'a' \| 'b' \| 'c'` | no annotation | `@debounce(0)` implied; eager commit |
  | "short label / name / title" → `field: string` | no annotation | type default debounce (500/2000) |
  | "long-form text / notes / body" → `field: string` | `@longform` | slower debounce + text-merge resolver + `<textarea>` UI |
  | "counter / amount / score" → `field: number` | no annotation | type default |
  | explicit custom timing | `@debounce(quietMs, maxWaitMs)` | exact override |

### Nebula API types as LLM context

The Nebula API surface (resource ops, `client.orgTree.*`, permission model, subscription patterns) is given to the model as `.d.ts` type definitions — precise signatures, return types, and error conditions in the language it already understands. Reuses the Phase 5.2 tsc-in-DWL capability (ADR-001): the types that validate data at runtime also serve as API docs. For the user-developer's *own* ontology metadata (`@title`/`@description`/`@inverse`, and Galaxy serving the raw `.d.ts` source verbatim — no bespoke metadata JSON), see `tasks/nebula-resource-metadata.md`.

## Architecture

- **Galaxy hosts Studio-generated artifacts + chat session state** — per-session rows (chat history, working state) and shared rows (current ontology, accumulated memory, docs/patterns learned across sessions). Lightly loaded; years of session history fit under 10GB (refactor if we approach it). Abandoned apps cost essentially nothing.
- **Each chat session pins to the dev Star** (`/{u}.{g}.dev/...`, the built `DevStar` — `tasks/dev-star.md`): its own SQLite, fully isolated from production Stars. Studio drives `deployToDev()` (eager ontology apply) and `resetDevData()` (the breaking-edit reset *mechanism* — the trigger + safety wiring are Studio's, § *Durable draft ownership*). Additive edits preserve dev data, breaking edits reset it — **see dev-star.md § In-dev data lifecycle**. Seeding a dev Star from a production Star (fork-to-test) and multi-sandbox `dev-<name>` (branching) are post-demo (`tasks/on-hold/nebula-branches.md`).

### Files as resources (no separate VFS)

Application source files are **resources of type `file`** on the dev Star, alongside the user's data resources (captured 2026-05-15). Value is the content directly (`ArrayBuffer` for binary uploads); `meta.mimeType` discriminates. Maps cleanly to MCP's `TextResourceContents` / `BlobResourceContents` split.

```
store.resources.file['App.vue'].value = '<template>...'
store.resources.file['App.vue'].meta  = { eTag, validFrom, mimeType: 'text/x-vue', ... }
```

Leaning on Resources (not a bespoke VFS) gives storage, snapshot-history versioning, optimistic transactions, subscribe-and-fanout for the preview, and mesh access for the agent (`client.resources.transaction({...})` edits files exactly like UI resource writes) — all for free, one consistency model. We explicitly do **not** build a VFS abstraction layer, a parallel non-resource files path, or (for the demo) a git layer.

**Open / post-demo:**
- Single `file` type + `mimeType` discrimination vs. distinct types per extension (`vueComponent`/`tsModule`/`htmlShell`...). Start single; split later only if per-kind invariants matter.
- Export-to-GitHub; big-file/blob handling (Resources may not be the right home for large generated assets).
- **Storage backend behind file resources** (adopting `@cloudflare/shell`'s `Workspace` / git-on-DO, or an Artifacts backend) — post-demo investigation, `tasks/on-hold/nebula-file-storage-backend.md`. The demo backs file resources with the dev Star + Galaxy save API below.

### Durable draft ownership — the DevContainer DO is the dev source-of-truth (UPDATED 2026-06-18; was "Galaxy is the source of truth")

**Superseded by [`tasks/nebula-container-dev-loop.md`](nebula-container-dev-loop.md) Q#2.** Under the container dev-loop the user-developer's source (ontology `.d.ts` + `.vue` UI files) is durably owned by the **DevContainer DO's own storage** — not Galaxy, not the dev Star. The agent's `writeFile` (`@mesh`) **dual-writes** each save → the container disk (the ephemeral working copy vite reads) **and** the DevContainer DO's SQL (durable); on cold boot the DevContainer **re-hydrates** the tree from its DO SQL. Durability is **inherent in the write path**, not a separate orchestration.

- **DevStar = dev DATA only.** Its former source-`file`-resources role moved to the DevContainer. A breaking-edit `resetDevData()` wipes data but **cannot lose source** (different DOs), so the old "persist-before-wipe + re-hydrate-from-Galaxy" gate is **moot** (dev-star.md § reset precondition, updated).
- **Galaxy = published app-version registry only.** Its former dev-draft-source role moved to the DevContainer. **"Publish"** (less frequent) = the DevContainer runs `vite build` → pushes the **built** version to Galaxy → prod Stars lazy-pull (`tasks/nebula-app-versioning.md` #1b). Galaxy receives the built artifact, never dev source.
- **What remains Studio-owned (small):** the DATA-reset **trigger** (breaking-change detection vs a manual "reset dev"), and the **publish trigger + DevContainer→Galaxy build-push** (#1b). The old Galaxy-draft-store + per-turn-autosave + confirm-durable-before-wipe gate are **superseded** by the DevContainer dual-write — no longer needed.
- **Named checkpoints (post-demo)** are a tagged snapshot of the DevContainer DO source store and/or a published app-version — *not* dev-Star snapshot history (a reset destroys that).

### Authoring environment — chat-first web app + live preview

**Decided: web, chat-first, for the demo.** The user-developer spends ~90% of their time in chat; there is **no editable code editor and no file tree outside the chat window**. When the agent needs to show code, it surfaces it **read-only within the chat**. The recourse for "wrong code" is to talk to the agent, not to edit it — the moment the user edits, the LLM's mental model desyncs from file state and recovery is painful. Invest in agent reliability, not an editor fallback. (Pinned 2026-05-15.) **No "drop to the editor" escape hatch** — if we ever add one, it's a deliberate power-user debug/inspect mode (internal + advanced customers), never the default.

- **Persistent split: chat on one side, live preview always visible on the other.** The preview is the user's feedback signal — don't hide it.
- **Preview mechanism:** in-window, likely an **iframe**; fallback is to seamlessly launch (or focus, if already open) a browser window on the preview URL. **Auto-reload is mandatory** — driven by the dev Star's compile→reload broadcast (§ *Dev-mode Star*). Target feel is vite local dev; network latency means we won't match it, but **~3s save→refresh is good enough**.
- **Preview-element highlight** (the user-developer-native gesture): the user clicks an element in the running preview (the blue button, that row); the agent maps the click to the source range; the user describes the change in natural language. They think in the preview, not in files. A text-span highlight inside a chat-surfaced file is a precision fallback.
- **Speech-to-text correction lane:** show the transcript in an editable field before send (STT errors propagate fast); optional auto-send after N seconds of silence, with cancel + edit. Speak-don't-type is a real differentiator for user-developers.
- **Checkpoint UX** (post-demo) rides the durable Galaxy draft store, not git — § *Durable draft ownership*.

> **Post-demo authoring directions:** a desktop shell (Electron) for the increasingly AI-IDE-shaped / enterprise BYO-agent persona (local FS + real git + `vite dev` HMR) was considered and deferred with the web-first demo decision; the enterprise BYO-agent angle ties to `tasks/on-hold/nebula-file-storage-backend.md`.

**Open — Studio UI hosting:** how/where Studio's own HTML/JS is served (Workers Assets vs. a Galaxy-served artifact path — possibly the same mechanism as generated-app hosting). Small spike; decide alongside generated-app hosting.

### Dev-mode Star: SFC compile + reload broadcast

> ⚠️ The container-vite pivot is **decided pre-demo** (§ *UI-build architecture*): in-DO compile is **superseded** by real `vite` in a `DevContainer` DO. This section is preserved only as the description of the `in-do-compile-baseline` tag — the fallback if the pivot stalls. The reload-broadcast concept carries over (HMR replaces the manual broadcast).

The dev Star is the SFC compile + reload-broadcast site (build-sequencing #1). It's user-local (the DO is placed in the caller's colo), so the loop has eyeball-to-colo RTT only. The `compileSFC` method + reload fanout land on `DevStar` — port the validated spike `apps/nebula/spike/sfc-devstar-loop/` (see its RESULTS.md and `tasks/archive/spike-sfc-dev-cycle.md`). Mechanics (spike-validated 2026-05-15):

- Imports `@vue/compiler-sfc` (~700 ms cold-load, sub-ms warm-compile). `@mesh()` `compileSFC(source)` called via `lmz.call` over the existing WS — no separate HTTP surface.
- Two-step TS pipeline: `@vue/compiler-sfc` resolves Vue macros → the `typescript` npm transpiler strips remaining TS → executable JS (same shape as the typia validator pipeline).
- Broadcasts `'reload'` to preview clients via the existing Subscriber/fanout (preview clients subscribe to a known reload signal; compile triggers fanout) — no separate hibernating-WS pool.
- Round-trip latency: sub-2 ms p50 local; ~36 ms p50 Pittsburgh→IAD deployed — well inside "feels instant" at the nearest colo.

"Deploy" in Studio is **not** `wrangler deploy` — it's deploy-to-dev: update the dev Star's DWL bundle + push the auto-refresh signal to connected clients.

**Spike teardown** is owned by build-seq #1a Phase 4 (`tasks/nebula-studio-compile-pipeline.md`) — don't duplicate the checklist here.

## Iteration loop

The AI must see what's broken to fix it.

- **Remote debug tail:** extend `@lumenize/debug` to tail into the chat. Debug is already namespace-scoped throughout Lumenize; the AI subscribes to suspect namespaces so it focuses instead of drowning in per-transaction noise. Primary signal channel for runtime failures.
- **Agentic surface** (tools the AI calls, not just text generation):
  - `get_current_ontology` — fetch the pinned schema.
  - `subscribe_debug_namespace(ns)` / `unsubscribe_debug_namespace(ns)` — focus / drop the debug stream.
  - `get_recent_errors(namespace?, since?)` — pull validation/runtime failures.
  - `deploy_to_dev(artifacts)` — push generated code to the session's dev Star, in three steps: (1) publish the new ontology version to the Galaxy registry [Studio builds]; (2) `DevStar.deployToDev()` eager-applies it [built]; (3) compile + publish the UI bundle [Studio builds — the SFC pipeline, build-seq #1]. Post-demo this can target `dev-<name>` Stars with their own permissions (branching deferred — `tasks/on-hold/nebula-branches.md`).
  - *(Future)* `propose_migration(from, to)` — v1 via the Star-local lazy migration runner.

## Conversation flow

Cold-start interview is the demo wow moment — optimize for it.

- **Interview pattern:** start with the **core entity** (what is this product fundamentally about?), then relationships → workflows → access patterns. Build understanding progressively, reflect back what's learned. Generate a **draft ontology early** (even incomplete) as a live, correctable conversation artifact — the visual anchor during the demo.
- **Tone:** thoughtful product manager, not a form. Make assumptions and flag them ("I'm assuming each walk has a single walker — tell me if that's wrong"); don't ask about every detail. Confidence with humility.
- **Wizard-style flow (guided, not blank canvas):** ontology first (wizard validates it's coherent) → UI second (against the validated ontology). Not strictly linear — supports back-and-forth. *(A migration-validation gate between ontology change and UI change is post-demo; the demo resets the dev Star on breaking edits rather than migrating.)*

## Out of scope (demo)

- Server-side ORM enforcement of relationships (UI handles them client-side for now).
- Production migration polish (cross-resource callbacks, version skew, error UX) — `tasks/on-hold/nebula-5.5-schema-evolution.md`.
- Cross-Star prod→dev data migration; long-term session archival/cleanup; fine-tuned Nebula model (→ llm-strategy file).

## Open questions

- Demo narrative: full cold start vs. jump-in partway (leaning cold start). Confirm during storyboard.
- Does the pinned ontology view live in the UI alongside the chat?
- "File open for review" richness — plain vs. syntax-highlighted read-only (no edit bindings).
- Preview-element-highlight gesture — click? click-and-hold? hover-with-shift?
- Studio UI hosting (Workers Assets vs Galaxy-served) — § *Authoring environment*.
- Built-artifact (compiled UI bundle) storage & versioning — **decided**: combined into the immutable app-version record (`tasks/nebula-app-versioning.md` § Decisions #1). (The file-resource *backend* — `tasks/on-hold/nebula-file-storage-backend.md` — stays a separate, deferrable choice.)

## Follow-on work (post-demo)

`tasks/nebula-scratchpad.md` § "Studio Follow-On" — full list (training pipeline, prompt engineering, code-validation pipeline, version control for built apps, collaboration, marketplace/templates).

## Success criteria

Rough shape — refine during storyboard:

- [ ] User-developer can describe a data model in natural language and get a working ontology + resources on the dev Star.
- [ ] Generated code deploys to the dev Star and passes schema validation.
- [ ] Preview shows live UI components backed by real Resources.
- [ ] Edit → regenerate → preview cycle is fast (compile→reload sub-cycle ~3s; full regenerate cycle a few seconds).
- [ ] Cold-start interview produces a usable draft ontology in under 5 minutes (demo target).

## Build sequencing

> ⚠️ #1a/#1b below describe the **in-DO approach** (tag `in-do-compile-baseline`), **superseded by the container-vite pivot (decided pre-demo 2026-06-17)** — see § *UI-build architecture*. #1a reshapes to a container dev-loop; #1b's registry retargets to R2 asset sets; the **4th-node-type prerequisite** (`nebula-devcontainer-node-type.md`) lands first. The in-DO text is kept only as the tagged fallback.

1. **Dev-preview compile + serve + distribution** (first — it unblocks the rest). Reviewed + reshaped 2026-06-16 into two companion files:
   - **#1a — DevStar/Star mechanics: `tasks/nebula-studio-compile-pipeline.md`.** Compile `.vue` SFCs in `DevStar` (port the spike) → serve the running app from `Star.onRequest()` (the already-built lifecycle hook; not a `fetch()` override; strict CSP, SPA fallback) → reload-broadcast on each save. Build-now, spike-proven; the three mechanics test independently.
   - **#1b — App versioning + save + distribution: `tasks/nebula-app-versioning.md`.** Broadens the ontology registry to an **app-version** record (ontology + bundle + assets, lock-step); dev distribution **reuses the Star's lazy-pull** (Studio publishes to Galaxy → forces a browser refresh → the Star pulls); **parallel source durability** to Galaxy (so a breaking-edit wipe never loses work); Studio coordinates the seam (don't trust browser storage). Prerequisite for the *end-to-end* loop; some design still to pin.
2. **Remaining WAIT `@check-example` conversions** (after #1 serves a real bundle): convert `using-vue.md`'s CDN-load + CSP/template-compilation examples from `@skip-check` to `@check-example` — deferred phase-2 from `tasks/archive/nebula-frontend.md` § 5.3.7-v5.
3. **LLM & eval strategy** — `tasks/nebula-studio-llm-strategy.md` (model choice + system-prompt × model evals, once the generation surface exists).
