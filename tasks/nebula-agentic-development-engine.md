# Nebula — Agentic Development Engine (codegen design + roadmap)

**Status**: the single home for Studio codegen — **Part 1 design & decisions** (durable
substrate, settled-ish) + **Part 2 roadmap** (the forward plan, churns). Consolidated
2026-06-22 from this file + the former `nebula-studio-next.md` (deleted); the viability probe
moved to [`archive/decision-studio-codegen-viability-probe.md`](archive/decision-studio-codegen-viability-probe.md).

The Studio **dev loop works end-to-end** on real infra (`wrangler dev` + Docker Desktop):
describe → model generates → source pushed → preview updates, with a visible "thinking →
thought process" view. Commits on `feat/nebula-studio`: `b997f2d` (version contract + first
assembled run), `f52da5b` (Studio UI + chat stub), `545f4e3` (codegen engine — model-driven +
thought view).

**What works:** real model (`@cf/moonshotai/kimi-k2.7-code` via Workers AI — id isolated to
one swappable `STUDIO_MODEL` const; never surfaced in UI) generates **self-contained Vue
SFCs** (local state only) from a chat prompt; follow-up edits work; the thought-process panel
shows reasoning + output.

**What's NOT done yet:**
- Generated apps **don't use the Nebula backend** (ontology + Resources + client/store) — by
  design; the minimal prompt forbids it. The product frontier (→ *Data-bound generation*).
- The codegen turn is a **one-shot, regex-`extractVueBlock` extraction** — NOT the **native
  tool-calling, error-tail, self-correcting** loop the probe proved was the unlock (→
  *Self-correcting codegen loop*).

**Terminology**: "**agentic**", never "agent" (avoids confusion with Cloudflare Agents).
**DevStudio** (the server node) *runs* the **agentic development engine** — the codegen loop.
There is no separate "agent" actor.

> **Refs:** architecture/flows = [`nebula-dev-flows.md`](nebula-dev-flows.md) · the dev-loop
> that *runs* this engine = [`nebula-studio.md`](nebula-studio.md) · parked eval suite =
> [`on-hold/nebula-studio-eval-suite.md`](on-hold/nebula-studio-eval-suite.md) · parked skills
> = [`on-hold/nebula-skills.md`](on-hold/nebula-skills.md) · viability probe (frozen) =
> [`archive/decision-studio-codegen-viability-probe.md`](archive/decision-studio-codegen-viability-probe.md)
> · model bake-off = [`archive/think-vs-cma-bakeoff.md`](archive/think-vs-cma-bakeoff.md).
> Memory: `studio-model-agnostic-naming`, `preview-path-prefix-vite-base`.

---

# Part 1 — Design & decisions (the durable substrate)

The work in Part 2 draws on these. They're stable commitments that survive whatever
sequencing the roadmap picks.

## What this is

The agentic development engine is the codegen capability DevStudio runs: an LLM loop that
turns a user-developer's natural-language intent into Vue SFCs + an ontology `.d.ts`, iterating
on errors. **Viability is proven** (see the archived probe — "Studio is a wrapper around a
proven loop"). The quality, prompt, and evaluation work is the roadmap.

## Model decision — Kimi 2.7, no Think, no codemode

Codegen runs on **Kimi 2.7 (`@cf/moonshotai/kimi-k2.7-code`) via Workers AI** (binding mode).
Basis: a month-long Cloudflare-Think + Kimi prototype + the CMA-vs-Think bake-off
([`archive/think-vs-cma-bakeoff.md`](archive/think-vs-cma-bakeoff.md)) settled on Kimi; the
viability probe confirmed Kimi generates compilable Nebula UI and self-corrects in a thin loop.

- **No Cloudflare Think.** It bundles a loop (trivial to roll), codemode, chat memory, and
  React/HTTP-shaped resilience — none worth adopting, and it drags a foreign multi-tenant DO
  surface we don't want. Everything it offers is rollable or better as native Lumenize (e.g.
  streaming as a Mesh WS primitive over the existing connection).
- **No codemode.** Its sandbox↔host tool bridge is JSON-only (base64 for binary) — an
  **ADR-002 violation** (we round-trip full structured-clone everywhere). When we want
  sandboxed dynamic execution, we roll our own with a mesh/RPC full-type bridge.
- **Claude is not in the product** — eval baseline only.

## What the viability probe established (PROVEN 2026-06-16)

Full record (with the per-feature "got right unprompted" list + substrate facts) →
[`archive/decision-studio-codegen-viability-probe.md`](archive/decision-studio-codegen-viability-probe.md).
The load-bearing lessons that shape the roadmap:

- Kimi produced a **compilable** `App.vue` + `ontology.d.ts` first-shot and **self-corrected in
  ~2 rounds** given `coding-your-ui.md` + the ontology + the Nebula API `.d.ts` as context.
- **Use native tool-calling**, not regex-on-prose (`finish_reason: tool_calls` verified on
  Kimi). The shipped `chat()` is still the regex path — closing that is the loop item.
- **Feed the real `.d.ts`** and **wire a real error-tail** (`get_recent_errors` / debug-tail)
  for self-correction. The one real probe bug (Kimi inventing `op: 'set'`) was a
  prompt-completeness gap, not a capability gap — exactly what the `.d.ts` + error-tail fix.
- **Runs vary run-to-run** — the verdict is directional, not statistical. The rigorous
  regression suite is the eval suite, not eyeballing.
- Native tool-calling means **no sandbox** (no LLM-authored code runs server-side).

## Orchestration

- **Thin, self-rolled native tool-calling loop**, run by **DevStudio** (the server node) — the
  model emits structured `tool_calls`, our code executes them; no LLM-authored code runs
  server-side, so the loop needs **no sandbox**. DevStudio is the home (facets deferred,
  `nebula-dev-flows.md` Decision 8).
- A `script-per-step` facet sandbox (model writes one orchestration script per step, run with a
  mesh/full-type bridge) is a **pocketed cost/latency optimization** — added only if per-call
  tool-calling proves too chatty; the AIA-proven win, rebuilt without codemode's JSON.

### Two agentic contexts (where dynamic execution pays off)
1. **Studio authoring loop** (this engine, Part 2's subject) — per-call tool-calling to start;
   `script-per-step` is the pocketed optimization.
2. **In-app AI chat** (post-Studio; every Nebula app auto-gets one) — interactive **RAG against
   the app's own data** for the customer's end-users. Highest-value dynamic codegen/execution
   (per-end-user, at scale, latency-sensitive). **Same substrate** as this engine; **likely its
   own task file** when picked up — Part 1's decisions are shared, Part 2's roadmap is
   Studio-specific.

### Studio AI tool surface

Two tiers of tools the codegen loop can call:
- **Inner / sandbox tools** (no outside world): `write_file`, `write_ontology`, `read_file(s)`, `get_recent_errors`, `mark_complete` — specced in Part 2 § *Self-correcting codegen loop*.
- **Outside-world tools (wishlist — deferred, NOT for the first loop):** capabilities that reach the internet, so they **ride the outside-world substrate** ([`nebula-outside-world.md`](nebula-outside-world.md)) — the **`EgressBroker`** (`globalOutbound` → allow-list + SSRF deny) for egress, and the **Galaxy-governed secrets vault** for API keys. Starting the list:
  - **`web_search`** — "find inspiration / a recent development". Needs a paid search API (vibesdk uses **SerpApi/Google**, formatting knowledge-graph + answer-box + organic results into markdown — `worker/agents/tools/toolkit/web-search.ts`). Key → secrets vault (`galaxy-only` mode = platform pays); per-tenant cost angle → `nebula-tenant-ai-billing.md`. *We'll pay for a search API eventually.*
  - **`fetch_url`** — fetch a user-/LLM-supplied URL ("get inspiration from this", "read this recent doc"). **Not in vibesdk** (it only has `web_search`) — ours to design, and the bigger **SSRF** surface: the URL isn't ours, so it MUST route through the broker's deny (internal/metadata ranges) + allow-list, never a bare `fetch`. Output = readable text (HTML→text/markdown).
  - *(future: image-gen, deploy-preview, …)* — add as needs surface.

These are **agent capabilities** (an engine concern) built **on** the connectivity substrate — the Studio AI is a *second consumer* of it, distinct from giving *generated apps* outside access (`nebula-outside-world.md`'s primary subject). Tool *security* (an LLM choosing egress targets) is a trust-boundary review item when these are built.

## Resource-metadata conventions the engine consumes

The engine reads the **raw `.d.ts` source** (LLMs read TypeScript natively; a bespoke JSON
shape is strictly worse — the **source IS the spec**). **Re-homed (Decision 9):** DevStudio
serves the *current* ontology `.d.ts` from **its own source tree** (the shell `Workspace`) —
there is **no** Galaxy ontology-version registry / `getOntologySource(version?)` /
`OntologyVersionRow.source` (eliminated). Three JSDoc annotations beyond what
`extractTypeMetadata` already collects (the build to add them is a Part 2 item):

| Annotation | Where | Required? | Use |
|---|---|---|---|
| **`@title`** | type + field | required | human label for UI labels, breadcrumbs, dropdowns (PascalCase/camelCase names are programmer shorthand) |
| **`@description`** | type + field | optional | prose intent → tooltips/help; lets the AI reason about usage |
| **`@inverse <fieldName>`** | relationship field | required (on relationships) | names the inverse field on the target type; disambiguates 1:M vs M:N; runtime uses it for the future query engine |

- **Not in the set** (and why): `@id` (every resource has `id` by convention), `@unique`/
  `@index` (Star storage / eTag concern), `@onDelete` (post-demo; cascade is the AI-generated
  UI's job for now), cardinality (`T` vs `T[]` says it), FK-location (inferable from the
  inverse pattern).
- **PascalCase interface name IS the URL slug** — `{baseUrl}/{u}.{g}.{s}/resources/{TypeName}/{id}`
  (e.g. `/WorkoutSession/session-42`). No kebab translation (a second mapping to drift);
  multi-word names translate ambiguously; PascalCase has zero ambiguity.
- **Runtime use (invisible to the AI):** `@title`/`@description` flow into validation error
  messages; `@inverse` feeds the post-demo query engine
  ([`on-hold/nebula-orm-and-queries.md`](on-hold/nebula-orm-and-queries.md)); all three stored
  alongside `extractTypeMetadata()` output.
- **Build step:** extend `extractTypeMetadata()` in `@lumenize/ts-runtime-parser-validator`
  (additive — it already walks JSDoc tags for `@default`); document at
  `website/docs/nebula/resource-types.md`.
- **Open:** `@title`-required is verbose (could default to humanized field name, `@title` as
  override-only); are all interfaces resources or are some embedded value types (demo: all are
  resources); cascade-is-the-UI's-job system-prompt hint.

## Context-window strategy

- The **current ontology stays permanently pinned** in context — everything generated centers
  on it; dropping it makes the engine useless. Refresh the pin whenever it changes.
- Annotation docs (written for humans) provided as reference.
- Long iteration sequences will eventually need strategic archival of older turns — not for the
  demo.

## Language-model strategy (arc)

- **Short term:** prompt engineering against Kimi (Workers AI) with Nebula-specific system
  prompts + few-shot examples.
- **Medium term:** a fine-tuned small model specialized for Nebula UI + Resources patterns.
- **Training data:** Nebula's docs, example apps, the Resources + `client.orgTree` API surface,
  the Nebula UI component library.

## Evaluation strategy

Once the generation surface exists, **fork to evaluate (system prompt) × (model)** on real
codegen tasks. Start with Kimi 2.7 — **live use IS the eval**; don't front-load a model
bake-off. Claude as a baseline comparison. Tasks under eval = real generation jobs (todo,
kanban, simple CRM): does the model produce working ontology + UI that passes validation and
runs with access-control + reactivity intact? The **rigorous regression suite** (deterministic
gates first, LLM-judge only for fuzzy UI quality) is parked in
[`on-hold/nebula-studio-eval-suite.md`](on-hold/nebula-studio-eval-suite.md) — un-park when this
engine is a real churning loop (Part 2's *Eval suite* item).

## Pre-build reading: vibesdk LLM patterns

Before the codegen loop is really built, mine [`cloudflare/vibesdk`](https://github.com/cloudflare/vibesdk)
(MIT, ~year of production iteration) for the **LLM-orchestration layer** — prompts, model
routing, tool defs, the state-machine agentic loop, streaming/abort/reconnect, AI-Gateway
plumbing. **NOT** for back-end/dev-loop patterns (settled in `nebula-dev-flows.md`) or
what-code-to-generate. Output → `tasks/reference/vibesdk-llm-patterns.md` (topic-organized).
This is Part 2's *vibesdk study* item.

- **Read (priority order):** `worker/agents/inferutils/config.ts` (`AGENT_CONFIG`
  model-per-operation map), `worker/agents/prompts.ts`, `operations/UserConversationProcessor.ts`
  (the chat pattern, ~line 50), `operations/PhaseGeneration.ts` + `PhaseImplementation.ts` (the
  state machine), `assistants/codeDebugger.ts` (deep-debugger tool ordering),
  `tools/customTools.ts` + `tools/toolkit/`, `schemas.ts`, the AI-Gateway code,
  `samplePrompts.md` + `docs/`, their `CLAUDE.md`.
- **Output sections:** model routing · system-prompt architecture · tool defs & loops · state
  machine for bounded work · streaming+abort+reconnect · token-efficiency (empty-tool-result
  skipping, dedup, caching) · AI-Gateway integration · structured output & validation ·
  long-context strategies. Each: prose + a code excerpt + a "what to consider for Nebula" note
  (mapped to *this* engine and to in-app chat).
- **Caveats:** filter for *talking-to-LLMs*, not *what-code-to-generate*; MIT — excerpts fine,
  copying follows `ATTRIBUTIONS.md` + <1000 SLOC.
- **Stop condition:** all sections have content + ≥1 code ref + a "for Nebula" note; a reader
  can design prompts/tools without re-reading vibesdk.

---

# Part 2 — Studio codegen roadmap (the forward plan)

## How to read this list

The items are ordered by **leverage + dependency**, but this is **not a strict phase pipeline** —
items interleave. The organizing reality is a **fidelity ladder**: build the *cheapest* tooling
that produces a *real signal*, make prompt progress against it, then climb to costlier tooling
only when the next round needs it. The per-item **unblocks / depends on** notes carry the actual
ordering constraints; the linear order is a sensible default, not a gate. Each item is tagged
**defined** (a transcribable build → `/build-task`), **exploratory** (empirical iteration →
capable-of-failing checks + captured findings, per the build-task exploratory-phase rule), or
**research** (read-only).

The flywheel the list builds toward: **recorded turns → fast offline iteration → stabilized
behavior promoted to regression gates.** The corpus is the substrate; the prompt is the
exploration; the eval suite is what freezes what works.

## Design constraints that span the list

Get these right *early* — retrofitting them is expensive:

- **Two fidelity ladders, and the cheap rungs are load-bearing.** Both *capture* and *validate*
  have rungs; the container is only needed at the top rung, so most prompt iteration is
  **container-free**:

  | Rung | Capture | Validate signal | Needs container? |
  |---|---|---|---|
  | 0 | `(prompt, msg, current src) → output text` | eyeball | no |
  | 1 | + compile the SFC + compile the ontology | **compiles + uses the Nebula API correctly** | **no** |
  | 2 | + run against the real `.dev` Star + preview | persists / renders / enforces access control | yes |

  Rung 1 catches the exact failure class the probe hit (Kimi inventing `op: 'set'`) and needs
  **no container**: the ontology `.d.ts` already compiles under vitest-pool-workers
  (`compileOntologyVersion`), and `App.vue` compiles standalone via `@vue/compiler-sfc` +
  `nodejs_compat` (`tsc-in-workerd-must-bundle`, `sfc-compile-needs-bindingmetadata`). The
  container (and so the **container vite swc** fix) only gates Rung-2 runtime signal — it is
  **off the critical path** for most prompt iteration.

- **Recorder schema === eval-fixture schema.** The turn record must be replayable as an eval
  case unchanged. Get the identity right now and the eval suite is nearly free later; get it
  ad-hoc and the eval suite means a reformat.

- **Design the turn record + loop for the tool-calling shape, not the regex shape.** A real turn
  is *multiple `tool_calls` over several round-trips with interleaved compile errors*, not a
  single regex-extracted SFC. Schematize for that now or rework it the moment the loop lands.

## The work, in order

### Turn recorder — ✅ DONE 2026-06-22
> ✅ **Built 2026-06-22** (`f0e6865`). Store = the per-tester **Galaxy DO's SQLite** (`Galaxy.recordTurn`/`getTurns` over a `Turns` table); `DevStudio.chat()` fires it fire-and-forget. Full record stored as JSON `payload` = the eval-fixture schema (tool-calling-shaped). Persistence layer tested under pool-workers (round-trip / ordering / admin-gated, mutation-verified, baseline no-regression); the `chat()`→record end-to-end stays deploy-gated. Consent assumed true (per-Galaxy flag backlogged).

Persist **every** codegen turn (system prompt, user message, current source, model output incl.
`reasoning_content`, tool calls, applied/error, Rung-1 validate result) to a **cross-run** store
(R2 or a dev-only mesh DO — *not* per-sandbox `ctx.storage.sql`, which is the wrong home for a corpus
you query across runs; *not* coupled to the parked Tail-Worker observability design — that's
log-scraping, this is structured turn capture).

- **Why first:** nearly free — `chat()` already computes everything; persisting is a few lines.
  It accumulates the corpus *while* later items are built, and those real turns become the seed
  fixtures for the offline harness.
- **Unblocks:** the offline harness; the eval suite (same schema).
- **Resolved:** stored in the per-tester **Galaxy DO** (mesh-for-free; queryable SQLite). R2 was spiked then punted (`tasks/icebox/spike-r2-olap-latency.md`).

### vibesdk study — ✅ DONE 2026-06-22
> ✅ **Done 2026-06-22** → [`reference/vibesdk-llm-patterns.md`](reference/vibesdk-llm-patterns.md) (9 sections + takeaways; 4-agent read-only fan-out over a shallow clone). Headlines for the loop build: **completion-signal tools + max-tool-depth + loop-detection** bound the loop; native tool-calling = **schema+impl split** (typia, not Zod; bridge to Workers AI ourselves); **error-tail freshness = deploy→wait→re-fetch**; **pin the ontology in a stable system block**; **search/replace diffs** (w/ ambiguity scoring) when we move to edits. Confirmed: vibesdk's `ThinkAgent` IS `@cloudflare/think` → our rejection stands; the reusable bit is the phasic state machine.

Mine `cloudflare/vibesdk` for the LLM-orchestration layer — full reading list, output sections,
caveats, and stop condition in **Part 1 § Pre-build reading**. Output →
`tasks/reference/vibesdk-llm-patterns.md`.
- **Why here:** read-only and parallelizable (good fan-out); directly informs the loop + prompt
  items. Filter for *talking-to-LLMs*, not what-code-to-generate.

### Self-correcting codegen loop — *defined* · ⬅ **NEXT** (build-ready, vibesdk-informed 2026-06-22)
Replace the one-shot regex `extractVueBlock` in `DevStudio.chat()` with a **bounded, native
tool-calling loop** that feeds a **compile error-tail** back for self-correction. The borrow
decisions below are distilled from [`reference/vibesdk-llm-patterns.md`](reference/vibesdk-llm-patterns.md)
(its provenance matrix shows all of these are **Think-free** and only **shape-coupled** to the
OpenAI SDK, which Kimi-via-Workers-AI already mirrors).

**Design — adopt from vibesdk (§ = reference-doc section):**
1. **Tool surface + a completion signal** (§3). Tools: `write_file`, `write_ontology` (writes the
   `.d.ts` → triggers compile+install), `read_file(s)`, `get_recent_errors` (the error-tail),
   `mark_complete`. The `mark_complete` call is the clean loop stop.
2. **Three-way *inner* bound** (§3, "our settled stop condition"): completion signal +
   **max-tool-calling-depth** per turn + **loop detection** (identical-tool-call repeat +
   rolling-hash text-repetition abort). NOT the phasic *outer* state machine (§4) — single
   self-correcting generation, not a multi-phase builder.
3. **Error-tail self-correction** (§ Deep-debugger). Feed the **Rung-1 compile** error-tail
   (SFC compile + ontology compile) back each round — **synchronous**, so simpler than vibesdk's
   runtime errors. Defer the **deploy→wait→re-fetch freshness** + once-loaded "session" shape to
   when a *runtime/preview* error-tail is added.
4. **Prompt restructure** (§2): composable bundles + **pin the ontology `.d.ts` in a stable
   system block**; live state (current source, error-tail) in the **user** layer; keep the
   codegen prompt separate from any chat prompt.
5. **Per-operation model config** (§1, light): a tiny `{ generate, fix }` table — Kimi + a
   fallback, per-op temp/max-tokens/thinking-budget — behind the existing swappable `STUDIO_MODEL`
   indirection (never surfaced — `studio-model-agnostic-naming`).

**Adaptations (the matrix's shape-level swaps):** declare tool schemas the **typia/TS-type** way
(ADR-001, *not* Zod); parse Kimi's **OpenAI-shaped `tool_calls` from `env.AI.run`** (no `openai`
npm client); **verify Workers AI/Kimi supports `response_format: json_schema`** — else validate
post-hoc with typia (ADR-001 has us doing that anyway).

**Out of scope / defer (forward-pointers):** conversation compactification → in-app AI chat;
search/replace diffs + ambiguity scoring → when we move from whole-file regen to **edits**;
AI-Gateway `cf-aig-metadata` tags → `nebula-tenant-ai-billing.md`; streaming `onChunk` → the
DX "real-time thought streaming" item (as a Mesh WS primitive); the **phasic outer state
machine** → only if a generation ever needs splitting into phases. **Skip:** Cloudflare Think,
the `openai` npm client, codemode.

- **Why here:** the half of "make it data-bound" that's *buildable now* — a defined build, and
  the thing that makes the recorder's error capture meaningful.
- **Depends on:** the **Rung-1 compile gate** as the error source — container-free (ontology via
  `compileOntologyVersion` under pool-workers; SFC via `@vue/compiler-sfc` standalone, see
  `tsc-in-workerd-must-bundle` / `sfc-compile-needs-bindingmetadata`). Build it inline in the
  loop first, then factor out for the offline harness.
- **Build/test note:** `chat()` is deploy-gated (AI binding + container), but the **loop
  mechanics** (tool dispatch, the three-way bound, the compile error-tail) sit on the
  container-free Rung-1 gate, so most of it is pool-workers-testable; the live model turn stays
  the deploy/`wrangler dev` check. **First real data-bound prompt progress** can begin here,
  hand-driven in the browser + the turn recorder, before the offline harness exists.
- **Process:** big enough for its own `/review-task` pass over this item before `/build-task`.

### Offline prompt harness — *defined*
Re-run `(systemPrompt, message, current source) → model → output` **independently of the
browser**, replaying recorded turns as fixtures, with a **container-free Rung-1 validate gate**
(compile the SFC + compile the ontology + static Nebula-API-usage checks). A vitest-pool-workers
test or script against the `AI` binding / Workers AI REST.
- **Why here, not first:** the "costlier tooling" — build it once the loop exists and you know
  the turn shape + what's worth asserting. It makes the *next* round of prompt iteration fast
  and independent (the original motivation); the first round runs hand-driven.
- **Unblocks:** fast exploratory iteration of the data-bound prompt; grows into the eval suite.

### Ontology annotations (`@title` / `@description` / `@inverse`) — *defined*
Extend `extractTypeMetadata()` in `@lumenize/ts-runtime-parser-validator` to collect the three
JSDoc annotations the engine consumes (Part 1 § Resource-metadata conventions), and document at
`website/docs/nebula/resource-types.md`. Additive — it already walks JSDoc for `@default`.
- **Why here:** a likely prerequisite of data-bound generation — the annotations give the model
  the human labels + relationship inverses it needs to reason about the ontology and generate
  correct UI. Independent of the loop, so it can land any time before data-bound work.

### Data-bound generation — *exploratory*
Make the model generate apps that **use the Nebula ontology + Resources + client/store**
(persistent, multi-user, secure-by-default), not local-state toys. The real system prompt + the
**skills** ([`on-hold/nebula-skills.md`](on-hold/nebula-skills.md): base prompt / rules /
progressively-disclosed skills; first sub-agent = product-alignment verifier reading the vision
doc). Design substrate = Part 1.
- **Why:** the product value. Local-state toys prove the loop; this proves the platform.
- **Mode:** empirical — iterate fast via the offline harness + occasional browser checks. NOT a
  spec to transcribe.
- **Depends on:** the harness (to iterate efficiently); ontology annotations; the **container
  vite swc** fix *only* for Rung-2 runtime signal (importing the client factory hits the same
  TC39-decorator issue the Studio UI did, + an image rebuild); the **skills** for teaching the
  Nebula API surface.

### Eval suite — *defined (un-park when the loop is churning)*
The regression suite — deterministic gates first (plain `expect()`), LLM-judge (GLM-5.2, temp 0)
only for fuzzy UI quality. [`on-hold/nebula-studio-eval-suite.md`](on-hold/nebula-studio-eval-suite.md);
strategy in Part 1 § Evaluation strategy.
- **Why here:** it freezes what the exploratory prompt work stabilizes, and **grows out of the
  recorder's corpus** (shares its schema — hence the schema-identity constraint).
- **When:** after enough prompt iteration that there's stable behavior worth regression-testing.

### DX & correctness backlog — *defined, slot in as needed*
- **Container vite swc** — Rung-2 prereq for data-bound apps (generated `App.vue` importing
  `{ client, store }` from `nebula.ts` → the container's vite needs `unplugin-swc`, like the
  Studio UI; + an image rebuild). Same fix as the `preview-path-prefix-vite-base` neighbor.
  *Off the critical path until Rung-2.*
- **HMR under the path prefix** — re-enable so the loop is sub-second (no full iframe reload per
  turn). The WS path 101's cleanly, so it looks viable; needs `clientPort`/path tuning.
- **Real-time thought streaming** — upgrade waiting→thought from after-completion to live token
  streaming (mesh chat-chunk channel + client handler). DX nicety.
- **First `apps/nebula` deploy** — turn the deploy-gated `it.skip` e2es green on real infra
  (`nebula-release-process.md` intersects). The local loop works, so not blocking.
- **Wrangler 4.86→4.103 + vitest-pool-workers bump** — own deliberate task; won't remove the swc
  need (vite/Oxc don't do TC39 decorators); mind the 2022-03↔2023-11 decorator iteration gap.
  Possibly broadens vitest-pool-workers coverage.

## Iteration-mode summary

- **Defined builds** (transcription; `/build-task` fits): turn recorder, self-correcting loop,
  offline harness, ontology annotations, eval suite, the DX backlog items.
- **Exploratory** (fast empirical loops; capable-of-failing checks + captured findings, NOT a
  spec): data-bound generation.
- **Research** (read-only, fan-out-friendly): vibesdk study.

**Code-writing stays sequential / single-writer** even under ultracode — parallel agents are for
the vibesdk read, review panels, and verifiers, never concurrent writers.
