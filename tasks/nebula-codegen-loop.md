# Nebula — Self-correcting codegen loop

**Status**: **Phases 1–3 BUILT + verified 2026-06-22** (container-free; `/build-task`, 3-phase verifier
fan-out — all CONFORM, only minor notes, two closed: a package-local `checkTypeScript` test + a
failing-final-gate recorder assertion). **Phase 4 (live integration into `chat()`, deploy-gated) is the
remaining work.** Stage-1 and Stage-2 reviewed 2026-06-22.

Replace the one-shot regex `extractVueBlock` path in `DevStudio.chat()` with a **bounded,
native tool-calling loop** that feeds a **container-free compile error-tail** back to the model
for self-correction. Extracted from the roadmap item in
[`nebula-agentic-development-engine.md`](nebula-agentic-development-engine.md) Part 2 (which now
carries only a one-line pointer here). The borrow decisions are distilled from
[`reference/vibesdk-llm-patterns.md`](reference/vibesdk-llm-patterns.md) — its provenance matrix
shows every one is **Think-free** and only **shape-coupled** to the OpenAI SDK, which
Kimi-via-Workers-AI already mirrors.

> **Refs:** the engine roadmap = [`nebula-agentic-development-engine.md`](nebula-agentic-development-engine.md)
> · borrow source = [`reference/vibesdk-llm-patterns.md`](reference/vibesdk-llm-patterns.md)
> · dev/publish flows (wipe gating) = [`nebula-dev-flows.md`](nebula-dev-flows.md) Flow 1b
> · the DevStudio node = [`nebula-studio.md`](nebula-studio.md) · parked eval suite =
> [`on-hold/nebula-studio-eval-suite.md`](on-hold/nebula-studio-eval-suite.md) · parked skills =
> [`on-hold/nebula-skills.md`](on-hold/nebula-skills.md). Memory:
> `studio-model-agnostic-naming`, `tsc-in-workerd-must-bundle`,
> `sfc-compile-needs-bindingmetadata`, `preview-path-prefix-vite-base`.

## Objective

Turn `DevStudio.chat()` from a single-shot, regex-extracted SFC into a bounded multi-round loop:
the model emits `tool_calls`, our code runs them, a **synchronous Rung-1 compile** of what it
wrote is fed back as an error-tail, and the model self-corrects until it signals completion or a
bound trips. **No LLM-authored code runs server-side** (native tool-calling, no sandbox — Part 1
model decision). The loop is the half of "make it data-bound" that is *buildable now*, and the
thing that makes the just-shipped turn recorder's error capture meaningful.

The **system-prompt content** (what we actually tell the model to make data-bound apps) is
**out of scope here and explicitly exploratory** — it lives in the *Data-bound generation* engine
item. This file specs the loop **mechanics** (tool surface, the bound, the compile error-tail,
prompt *structure*, recorder wiring) as a defined, transcribable build.

## Settled substrate (inlined so this file stands alone)

These are decided upstream; repeated here so a cold implementer needs only this file + the cited
source.

- **Model**: Kimi 2.7 (`@cf/moonshotai/kimi-k2.7-code`) via the Workers AI binding (`env.AI.run`),
  id isolated to the one swappable `STUDIO_MODEL` const ([dev-studio.ts:58](../apps/nebula/src/dev-studio.ts)),
  **never surfaced** (`studio-model-agnostic-naming`). No Cloudflare Think, no codemode (ADR-002).
- **The fidelity ladder — the loop lives entirely on the container-free rungs:**

  | Rung | Validate signal | Needs container? |
  |---|---|---|
  | 0 | eyeball the output | no |
  | **1** | **compiles + uses the Nebula API correctly** | **no ← the loop's error source** |
  | 2 | persists / renders / enforces access control on the `.dev` Star + preview | yes |

  Rung 1 catches the exact failure class the viability probe hit (Kimi inventing `op: 'set'`).
  Both Rung-1 compiles are container-free: the ontology `.d.ts` via `compileOntologyVersion`
  ([galaxy.ts:109](../apps/nebula/src/galaxy.ts)) under vitest-pool-workers; `App.vue` via a
  **standalone `@vue/compiler-sfc`** pass (Phase 1 — see Decisions). The container only gates
  Rung-2 runtime signal and is **off this loop's critical path**.
- **Recorder (shipped, `f0e6865`)**: `Galaxy.recordTurn`/`getTurns` persist `TurnRecord` as JSON
  `payload` in the per-tester Galaxy DO's SQLite. The full record **is** the eval-fixture schema.
  It already ships the tool-calling-shaped slots this loop fills:
  `toolCalls: ToolCall[]` (currently `[]`), `error?` (the Rung-1 error-tail slot), `validate?`
  (the Rung-1 validate-result slot). `ToolCall = { name, args, result?, error? }`.
- **Mesh discipline**: `DevStudio extends NebulaDO`; every entry is `@mesh(requireAdmin)`; node↔node
  is mesh only (`this.lmz.callRaw(BINDING, instance, this.ctn<T>().method(...))`, ADR-003 — never
  raw Workers RPC). Source-of-truth is the shell `Workspace` over `ctx.storage.sql`; `#ws`/`#fs`/
  `#git` are caches reconstructed in `onStart` (no mutable durable instance state).

## Pinned decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | **Tool surface (first loop)** | **`write_file` + `mark_complete`** only | After D2, the only thing that distinguished `write_ontology` was "triggers install" — which D2 removes — leaving "which compiler runs," derivable from the path. The server must detect the ontology path *anyway*, so that detection **is** the dispatch; a separate `write_ontology` tool is redundant surface and creates a "what if the model writes the ontology via `write_file`?" ambiguity. `read_file(s)` / `get_recent_errors` as **model-pulled** tools are deferred (see Out-of-scope) — for a 2-file app (`App.vue` + `ontology.d.ts`) the current source + error-tail are **pushed** in the user layer instead. |
| D2 | **`write_file` is compile-only; install/wipe is never model-reachable** | The tool writes to the Workspace (+ git commit) and runs the path-dispatched **Rung-1 compile**, returning the error-tail. It does **not** call `compileAndInstallOntology`/`applyOntologyChange`, and **cannot** reach `resetDevData`. | Secure-by-default (strategy Strategic-check #1). The shipped install path routes `wipe:true → resetDevData()`, destroying all `.dev` data, and that decision is deliberately **human-gated** (Flow 1b `promptWipe`→`wipeDecision`, [`nebula-dev-flows.md`](nebula-dev-flows.md)). An autonomous LLM tool is not the decider of a wipe but can make the recommendatoin based upon backward-breaking ontology change. Install-on-`.dev`-Star + any wipe stays the separate, human-gated apply step fired *after* the loop, outside the tool surface. |
| D3 | **Path → compiler dispatch** | **Normalize the path first** (the `writeSource` strip-leading-slash rule), then: `*.d.ts` (the ontology) → `compileOntologyVersion` (**reuse**, shipped); `*.vue` → the **two-pass SFC gate** (compile + semantic type-check — **new, Phase 1**, D3/B1); any other path → write only, no compile, `{ ok: true }`. All gates return one uniform `{ ok, errorTail }`. | One write tool, two gates, picked by extension. Normalization keeps a near-miss on the canonical ontology path (`src/ontology.d.ts`) from silently landing in the no-compile branch. Keep "other paths → write only" (don't harden to a 2-path allow-list — it's the deliberate multi-file-forward provision); the D2 reachability guard holds for any path string regardless. The ontology gate exists; the SFC gate is a **deliverable to build** (Phase 1), not a satisfied dependency. |
| D4 | **The three-way inner bound** (settled stop condition) | completion-signal (`mark_complete`) + **max-tool-calling-depth** per turn + **loop-detection** (identical-tool-call repeat + rolling-hash text-repetition). **Not** the phasic *outer* state machine. | The vibesdk-borrowed inner per-inference bound (§3); single self-correcting generation, not a multi-phase builder. |
| D5 | **Tool schemas + output validation** | Declare tool schemas the **typia/TS-type** way (ADR-001, not Zod), convert to JSON for the model; parse Kimi's **OpenAI-shaped `tool_calls` from `env.AI.run`** (no `openai` npm client). **Validate the model's tool-call args with typia before dispatch** (trust boundary — model output is untrusted). Verify Workers AI/Kimi supports `response_format: json_schema`; if not, the typia post-validate is the fallback (ADR-001 has us doing it anyway). | ADR-001 + ADR-002; the model is the untrusted side of a trust boundary, so args are validated before any write/compile. |
| D5a | **Path safety on `write_file` (untrusted path)** | typia validates **shape** (`path:string`), not path **safety**. Before `writeSource`, run `assertSafeRelPath` ([dev-container.ts:81](../apps/nebula/src/dev-container.ts), already exported — rejects absolute + `..`) on the model-supplied path. | The model now chooses the path, and `writeSource` only strips leading slashes ([dev-studio.ts:122](../apps/nebula/src/dev-studio.ts)) — `'src/../../escape'` would survive into the durable Workspace *before* any compile gate. Confined to this tenant's DevStudio DO, but a traversal write is still a footgun (security.md trust boundary). *Product feedback:* consider hardening `writeSource` itself so every caller is covered. |
| D6 | **Per-call model params (trimmed)** | Reuse the one `STUDIO_MODEL` const; pass per-call `{ temperature, max_tokens }` for **generate** vs **fix** (lower temp on fix). **No** `fallbackModel`, thinking-budget, or per-op config map. | YAGNI: one model, no second op/model/fallback exists yet; Part 1 says *don't front-load a model bake-off*. The full per-op config map is deferred to the eval-suite / data-bound work where a second op actually appears. |
| D7 | **Prompt structure** | Composable bundles; **pin the ontology `.d.ts` in a stable system block**; current source + error-tail in the **user** layer each round; codegen prompt kept separate from any chat prompt. **Keep bundle assembly cascade-shaped, not hardcoded** — these composable bundles are the future insertion seam for the Platform/Universe/Galaxy practice cascade ([`on-hold/nebula-skills.md`](on-hold/nebula-skills.md): advisory practices Studio follows-by-default and reports-on-deviation; assembled by an org-tree walk). Out of scope to build now; just don't hardcode a single flat system string. | vibesdk §2. Structure only — the system-prompt *content* is the exploratory data-bound item. |
| D8 | **Error-tail is synchronous (compile only), bounded + sanitized** | Feed the Rung-1 **compile** error-tail back each round directly. It is a *tail* — **cap its length** and **strip host-absolute Workspace paths / workerd-internal frames** before feeding it to the model *and* before persisting it to `TurnRecord.error`. Defer the deploy→wait→re-fetch freshness + once-loaded "session" shape until a *runtime/preview* error-tail is added. | Our compile errors are synchronous, so the vibesdk Deep-debugger's staleness half doesn't apply yet. Raw `compileOntologyVersion` / `@vue/compiler-sfc` output can embed absolute paths/internal frames — unbounded it bloats the prompt and harms eval-fixture portability (the corpus persists `TurnRecord.error`). |

## Phases

### Phase 1: Rung-1 compile gates (the container-free error source)
**Goal**: One path-dispatched compile helper that, given `(path, content)`, runs the right
compiler and returns a uniform `{ ok: boolean, errorTail?: string }` — the loop's self-correction
signal. Runs under vitest-pool-workers, no container, no AI binding.

- Ontology gate: **reuse** `compileOntologyVersion({ version, types })` ([galaxy.ts:109](../apps/nebula/src/galaxy.ts));
  the gate calls it with `types: content` and a throwaway `version` (e.g. `'gate'` or `git.hashBlob` of
  the content), **discards the validator bundle**, and maps throw/no-throw → `{ ok, errorTail }` (it
  throws on invalid TS / typia compile error).
- **SFC gate = TWO passes (Decision B1, resolved 2026-06-22).** The generated `App.vue` is validated by:
  - **Pass 1 — compile** (`@vue/compiler-sfc`: `compileScript` + `compileTemplate`), **threading
    `compileScript().bindings` into `compileTemplate`'s `compilerOptions.bindingMetadata`**
    (`sfc-compile-needs-bindingmetadata` — without it `<script setup>` renders blank, a trap that only
    surfaces on a real-browser mount). ⚠️ **Not a port:** `experiments/container-vite-spike` ran *real
    vite* (which threads `bindingMetadata` for free) and never exercised a standalone
    `compileScript`+`compileTemplate` pass under pool-workers — the manual recipe lives only in the
    `sfc-compile-needs-bindingmetadata` memory. Needs `nodejs_compat` (`tsc-in-workerd-must-bundle`).
    **New + unproven under pool-workers — a real discovery risk.**
  - **Pass 2 — semantic type-check** (the half that catches `op:'set'`). `@vue/compiler-sfc` only
    *transpiles*; it does **not** type-check the script against the Nebula API, so Pass 1 alone misses
    API misuse like the probe's invented `op:'set'` (a wrong union-literal in a typed client call). Build
    a **new** helper that runs `ts.createProgram` + `getPreEmitDiagnostics` on the extracted
    `<script setup>` block with the **Nebula client API `.d.ts` + Vue's types as virtual lib files** —
    **parameterize the existing `createVirtualHost`/`createProgram` engine**
    ([generate-parse-module.ts:133,273-307](../packages/ts-runtime-parser-validator/src/generate-parse-module.ts)).
    Stays **ADR-001-clean** (one TS type-checker, not a second schema language) and is **not** a reuse of
    `compileOntologyVersion` (which programs only the ontology types, no script). The Nebula API `.d.ts`
    must be **bundled into the DO isolate** (`tsc-in-workerd-must-bundle`) — a Phase-1 deliverable.
  - ⚠️ **Documented fallback if Pass 2 proves infeasible under pool-workers:** de-scope the headline —
    Rung-1 catches syntax/template only, and the `op:'set'` class moves to **Rung-2 runtime** (the `.dev`
    Star's typia validator already rejects a bad op at write time, container-gated). Then rewrite this
    file's ladder line + Phase-4 SC#1 **and** the engine doc's fidelity ladder to stop claiming Rung-1
    catches `op:'set'`. **Do not ship the loop with a justification its gate can't deliver.**

**Success Criteria**:
- [x] A known-good `App.vue` and a known-good `ontology.d.ts` each compile to `{ ok: true }`.
- [x] A syntactically-broken `App.vue` and a type-broken `ontology.d.ts` each return `{ ok: false, errorTail }` with the compiler's actionable message (capable-of-failing: gut the compiler call → criterion fails).
- [x] **Bindings-threaded probe** (Pass 1): a `<script setup>` SFC whose template references a setup binding compiles with `bindingMetadata` populated; a probe that drops the threading is detectably wrong (assert on `compileTemplate` output referencing `$setup.x`, not `_ctx.x`).
- [x] **`op:'set'` class** (Pass 2, the headline proof): an `App.vue` calling the Nebula client with a **bad union literal** (`op:'set'`) → `{ ok:false, errorTail }` (a TS2322/2345-style diagnostic); the same with the **correct** literal → `{ ok:true }`. This is the capable-of-failing proof that the loop's headline self-correction is reachable container-free. (If this proves infeasible under pool-workers → the D8/B1 documented fallback.)
- [x] All green under vitest-pool-workers (no container, no AI binding).

> **Phase 1 DONE 2026-06-22 — B1 discovery risk RESOLVED, no fallback needed.** The two-pass
> SFC gate works under vitest-pool-workers. Files: `apps/nebula/src/codegen-gate.ts` (standalone
> gate — the factor-out hook), `packages/ts-runtime-parser-validator/src/virtual-ts-host.ts`
> (extracted `createVirtualHost` + new exported `checkTypeScript`, reused by both the ontology
> compile and SFC Pass 2 — the "parameterize the existing engine" directive), tests in
> `apps/nebula/test/test-apps/dev-studio/codegen-gate.test.ts`. **Findings:** (1) ambient
> `declare module` only matches **bare** specifiers — the relative `./nebula` import must resolve
> to a real virtual file (`/nebula.d.ts`), NOT a `declare module './nebula'` block. (2) the `<script
> setup>` compiler macros (`defineProps`/etc.) are declared as **global ambient** functions in a
> script-mode `.d.ts` (no top-level import/export); `'vue'`/`'lucide-vue-next'` as ambient/shorthand
> modules. (3) `checkTypeScript` defaults `lib` to **ES2022 + DOM** so `crypto`/`document`/`console`
> don't false-positive. (4) the Nebula client API `.d.ts` is **authored here** (mirrors the real
> `EngineOp` union from `frontend/conflict-outcome.ts`) — the data-bound prompt later targets this
> same contract. Headline mutation-checked: disabling Pass 2 fails *only* the `op:'set'` test.

### Phase 2: Tool surface, dispatch & the three-way bound (container-free, fake-model)
**Goal**: The loop driver — dispatch `tool_calls`, run them, feed `{ ok, errorTail }` back, repeat
until `mark_complete` or a bound trips — exercised with **synthetic `tool_calls` (a fake model)**,
no AI binding.

- Tools: `write_file(path, content)` → `DevStudio.writeSource` (Workspace + git commit) **then** the
  Phase-1 compile gate by path → return `{ ok, errorTail }`. `mark_complete()` → clean stop. **D2:
  no path from `write_file` reaches `compileAndInstallOntology`/`applyOntologyChange`/`resetDevData`.**
- Tool schemas typia-declared (D5), converted to JSON; args validated with typia before dispatch.
- The bound (D4): `mark_complete` stops; a `maxToolDepth` cap stops a runaway; loop-detection aborts
  on an identical-tool-call repeat and on rolling-hash text-repetition.

**Success Criteria**:
- [x] Fake model that calls `write_file` (clean) then `mark_complete` → loop stops, file written, `applied:true`.
- [x] Fake model that never calls `mark_complete` → the `maxToolDepth` cap stops it (capable-of-failing: raise the cap to ∞ → the test hangs/fails).
- [x] Fake model that repeats an identical `write_file` → loop-detection aborts. Mutate each loop-detection operand independently (identical-call detector **and** text-repetition detector) per testing.md. **Both mutation-validated** (disabling each fails only its own test).
- [x] `write_file('src/ontology.d.ts', <type-broken>)` → the ontology compile error round-trips into the **next round's user layer** (assert the errorTail appears in the assembled next-round prompt).
- [x] A tool implementation that throws → captured into the `ToolCall.error` / error-tail, loop continues or aborts per the bound (not an uncaught crash).
- [x] **Malformed/absent tool-call envelope** (m2): a fake model returning (a) non-JSON / malformed `tool_calls`, (b) an unknown tool name, (c) a `{response}`-shaped reply with no `tool_calls` array → each surfaces a controlled loop error / safe termination, captured into the recorder, never an uncaught crash.
- [x] **D2 guard (all three sinks + structural)** — realized as **(a)** a structural assertion that `runCodegenLoop.toString()` names none of the full sink list (`resetDevData`/`setOntology`/`compileAndInstallOntology`/`applyOntologyChange`/`setAppVersion`/`applyChanges`/`STAR_BINDING`/`DEV_CONTAINER`) **plus (b)** a *real-node* runtime proof: a hostile ontology `write_file` compiles (`{ok:true}`) and lands in the Workspace, but the real `.dev` Star's `inspectOntologyIndex` stays `[]` (no install) and nothing is wiped. *Divergence from the task's "fake Star/DevContainer call-counters":* the structural grep covers the full sink list (incl. the DevContainer methods, which `extends Container` can't construct under pool-workers anyway), and a **real** Star index-empty proof is stronger than a fake-call counter for the install path.
- [x] **Path traversal rejected** (D5a): `write_file('../escape', …)` and `write_file('/abs', …)` are rejected as tool errors and never reach `writeSource` / the Workspace.
- [x] Invalid tool-call args (typia reject) → surfaced as a tool error, never dispatched (unit with a fake validator **and** integration through the **real typia facet** — a non-string path is rejected).

> **Phase 2 DONE 2026-06-22.** The loop driver is **standalone + dependency-injected**
> ([apps/nebula/src/codegen-loop.ts](../apps/nebula/src/codegen-loop.ts)): `runCodegenLoop(initial, deps, config)`
> with `callModel`/`writeFile`/`validateToolArgs` injected, so the bound + dispatch + loop-detection are
> driven directly with a synthetic model (no DO, no AI binding). DevStudio
> ([dev-studio.ts](../apps/nebula/src/dev-studio.ts)) gains `runCodegenTurn` (assemble → loop → record), a
> `protected callModel` override seam, and a `#validateToolArgs` facet (typia, derived from `TOOL_ARGS_TYPES`
> via `generateParseModule`, shared bundle id). The test harness `DevStudioLoopProbe` overrides `callModel`
> to replay a script. **D2 holds by construction** — the loop module imports only the pure gate +
> `assertSafeRelPath`; it has no reference to any install/wipe sink (grep-proven + real-Star runtime-proven).

### Phase 3: Prompt structure, per-call params & recorder wiring (container-free)
**Goal**: Assemble the layered prompt, pass the trimmed per-call params, and have the loop populate
the recorder's tool-calling slots — all assertable without the live model.

- Prompt (D7): ontology `.d.ts` in a stable system block; current source + error-tail in the user
  layer; codegen prompt separate from chat.
- Per-call params (D6): `{ temperature, max_tokens }` for generate vs fix off the one `STUDIO_MODEL`.
- Recorder (m4): the loop is the **first populator** of `TurnRecord.toolCalls` / `.error` /
  `.validate`; the recorded turn must round-trip through `getTurns` as a replayable fixture.

**Success Criteria**:
- [x] Prompt assembly: the ontology source lands in the system block; current source + error-tail land in the user block (assert by string-locating each in the assembled messages). `assembleCodegenPrompt` keeps the system layer **cascade-shaped** (an array of bundles, D7) — the future practice-cascade seam — not a flat string.
- [x] A simulated loop run records a `TurnRecord` whose `toolCalls` is non-empty and whose `error`/`validate` reflect the final compile result; `getTurns` returns it unchanged (fixture round-trip).
- [~] `response_format: json_schema` support is **verified** against Workers AI/Kimi — **deploy-gated `it.skip`** (needs the live AI binding; moved to Phase 4). The **fallback** (typia post-validate of tool-call args) is already the shipping path and is fully covered, so shipping does not depend on json_schema support.

> **Phase 3 DONE 2026-06-22** (the container-free half). Prompt assembly (cascade-shaped system bundles +
> ontology-pinned block + user layer), per-call generate-vs-fix params (D6 — dropped to fix params on the
> round after a compile error), and recorder wiring (m4 — the loop is the first populator of
> `TurnRecord.toolCalls`/`.error`/`.validate`, round-trips through `getTurns`). The json_schema probe is the
> only deploy-gated piece (Phase 4).

### Phase 4: Live integration (deploy-gated)
**Goal**: Wire the loop into `DevStudio.chat()`, replacing `extractVueBlock`; the live `env.AI.run`
turn + container push stays deploy-gated.

- `chat()` drives the loop; on a clean finish it pushes source to the container (existing
  `syncToDevContainer`) and the **separate, human-gated** ontology apply (Flow 1b) handles
  install/wipe — outside the loop.

**Success Criteria** (deploy-gated `it.skip`, assertions intact per testing.md):
- [ ] Under `wrangler dev` + Docker Desktop, a chat turn drives the loop, **self-corrects on a real compile error** (e.g. the `op:'set'` class), and updates the preview.
- [ ] The live turn records a `TurnRecord` with populated `toolCalls`/`error`/`validate`.
- [ ] **SFC mount confidence** (m3): an `it.skip` that mounts a Phase-1-compiled SFC in a real browser and asserts **non-blank render** — the bindings-threaded string-match in Phase 1 SC#3 proves threading, not render; the blank-`<script setup>` bug only surfaces on a real mount (`sfc-compile-needs-bindingmetadata`, testing.md:15).
- [ ] The deleted regex path (`extractVueBlock`) leaves no caller (`grep` clean).

### Final Verification (every phase)
- [ ] Tests pass (`npx vitest run` in `apps/nebula`); type-check clean (`npm run type-check`).
- [ ] No raw Workers RPC introduced (mesh.md); no mutable durable instance state (durable-objects.md).
- [ ] JSDoc on changed `DevStudio` methods reflects current behavior.

## Out of scope / forward-pointers
- **System-prompt content** (data-bound app generation) → *Data-bound generation* (exploratory).
- **`read_file(s)` / `get_recent_errors` as model-pulled tools** → fast-follow once apps go
  multi-file; the first loop pushes source + error-tail in the user layer (D1).
- **Conversation compactification** → in-app AI chat.
- **Search/replace diffs + ambiguity scoring** → when we move from whole-file regen to **edits**.
- **AI-Gateway `cf-aig-metadata` tags** → [`nebula-tenant-ai-billing.md`](nebula-tenant-ai-billing.md).
- **Streaming `onChunk`** → the DX *real-time thought streaming* item (a Mesh WS primitive).
- **The phasic outer state machine** → only if a generation ever needs splitting into phases.
- **Runtime/preview error-tail + deploy→wait→re-fetch freshness** → when Rung-2 signal is added (D8).
- **Skip entirely**: Cloudflare Think, the `openai` npm client, codemode.

## Notes
- **Build/test split**: the loop *mechanics* (Phases 1–3) sit on the container-free Rung-1 gate and
  a fake model, so they're pool-workers-testable; only the live model turn + container push (Phase 4)
  is deploy-gated.
- **Factor-out hook**: the offline prompt harness (next engine item) needs the *identical* Phase-1
  compile gate — build it as a standalone helper from the start so the harness imports it rather than
  re-deriving it.
- Code-writing stays **sequential / single-writer** even under ultracode — parallel agents are for
  review panels and verifiers only.
