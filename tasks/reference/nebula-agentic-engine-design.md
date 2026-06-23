# Nebula — Agentic Development Engine (design reference)

**This is a reference doc, not a task file** — the durable design substrate for Studio's codegen
engine. It carries **no status, no done-tracking, no roadmap sequence**: the *what-runs-when*
sequencing lives in the master plan ([`../nebula-pre-alpha.md`](../nebula-pre-alpha.md)); the
frozen build records live in [`../archive/nebula-codegen-loop.md`](../archive/nebula-codegen-loop.md)
(the self-correcting loop) and [`../archive/decision-studio-codegen-viability-probe.md`](../archive/decision-studio-codegen-viability-probe.md)
(the viability probe). This file is the *design companion* to the dev/publish architecture
([`nebula-dev-flows.md`](nebula-dev-flows.md)) — read both together.

**Terminology**: "**agentic**", never "agent" (avoids confusion with Cloudflare Agents).
**DevStudio** (the server node) *runs* the **agentic development engine** — the codegen loop.
There is no separate "agent" actor.

> **Refs:** dev/publish flows = [`nebula-dev-flows.md`](nebula-dev-flows.md) · vibesdk LLM-pattern
> mining (done) = [`vibesdk-llm-patterns.md`](vibesdk-llm-patterns.md) · model bake-off =
> [`../archive/think-vs-cma-bakeoff.md`](../archive/think-vs-cma-bakeoff.md) · viability probe
> (frozen) = [`../archive/decision-studio-codegen-viability-probe.md`](../archive/decision-studio-codegen-viability-probe.md).
> Memory: `studio-model-agnostic-naming`, `preview-path-prefix-vite-base`.

---

## What this is

The agentic development engine is the codegen capability DevStudio runs: an LLM loop that
turns a user-developer's natural-language intent into Vue SFCs + an ontology `.d.ts`, iterating
on errors. Viability is proven (the archived probe — "Studio is a wrapper around a proven
loop"). The quality, prompt, and evaluation work is what the master plan sequences.

## Model decision — Kimi 2.7, no Think, no codemode

Codegen runs on **Kimi 2.7 (`@cf/moonshotai/kimi-k2.7-code`) via Workers AI** (binding mode;
id isolated to one swappable `STUDIO_MODEL` const, never surfaced in UI). Basis: a month-long
Cloudflare-Think + Kimi prototype + the CMA-vs-Think bake-off
([`../archive/think-vs-cma-bakeoff.md`](../archive/think-vs-cma-bakeoff.md)) settled on Kimi; the
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
[`../archive/decision-studio-codegen-viability-probe.md`](../archive/decision-studio-codegen-viability-probe.md).
The load-bearing lessons that shape the design:

- Kimi produced a **compilable** `App.vue` + `ontology.d.ts` first-shot and **self-corrected in
  ~2 rounds** given `coding-your-ui.md` + the ontology + the Nebula API `.d.ts` as context.
- **Use native tool-calling**, not regex-on-prose (`finish_reason: tool_calls` verified on
  Kimi).
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
1. **Studio authoring loop** (this engine) — per-call tool-calling to start; `script-per-step`
   is the pocketed optimization.
2. **In-app AI chat** (post-Studio; every Nebula app auto-gets one) — interactive **RAG against
   the app's own data** for the customer's end-users. Highest-value dynamic codegen/execution
   (per-end-user, at scale, latency-sensitive). **Same substrate** as this engine; **likely its
   own task file** when picked up — this engine's decisions are shared, the roadmap is
   Studio-specific.

## Studio AI tool surface

Two tiers of tools the codegen loop can call:
- **Inner / sandbox tools** (no outside world) — owned by [`../archive/nebula-codegen-loop.md`](../archive/nebula-codegen-loop.md) D1.
  The first loop ships `write_file` (path-dispatched compiler) + `mark_complete`; `write_ontology`
  is **collapsed into `write_file`** (the server picks the ontology vs SFC compile by path), and
  `read_file(s)` / `get_recent_errors` as model-pulled tools are **deferred** there (current source
  + error-tail are pushed in the user layer).
- **Outside-world tools (wishlist — deferred):** capabilities that reach the internet, so they
  **ride the outside-world substrate** ([`../nebula-outside-world.md`](../nebula-outside-world.md)) —
  the **`EgressBroker`** (`globalOutbound` → allow-list + SSRF deny) for egress, and the
  **Galaxy-governed secrets vault** for API keys. Starting the list:
  - **`web_search`** — "find inspiration / a recent development". Needs a paid search API (vibesdk
    uses **SerpApi/Google**, formatting knowledge-graph + answer-box + organic results into
    markdown — `worker/agents/tools/toolkit/web-search.ts`). Key → secrets vault (`galaxy-only`
    mode = platform pays); per-tenant cost angle → `../on-hold/nebula-tenant-ai-billing.md`. *We'll pay
    for a search API eventually.* (The generated-app-facing **search recipe** is the same
    capability from the app side — see [`../nebula-outside-world-build.md`](../nebula-outside-world-build.md).)
  - **`fetch_url`** — fetch a user-/LLM-supplied URL ("get inspiration from this", "read this
    recent doc"). **Not in vibesdk** (it only has `web_search`) — ours to design, and the bigger
    **SSRF** surface: the URL isn't ours, so it MUST route through the broker's deny
    (internal/metadata ranges) + allow-list, never a bare `fetch`. Output = readable text
    (HTML→text/markdown).
  - *(future: image-gen, deploy-preview, …)* — add as needs surface.

These are **agent capabilities** (an engine concern) built **on** the connectivity substrate — the
Studio AI is a *second consumer* of it, distinct from giving *generated apps* outside access
(`../nebula-outside-world.md`'s primary subject). Tool *security* (an LLM choosing egress targets)
is a trust-boundary review item when these are built.

## Resource-metadata conventions the engine consumes

The engine reads the **raw `.d.ts` source** (LLMs read TypeScript natively; a bespoke JSON
shape is strictly worse — the **source IS the spec**). **Re-homed (`nebula-dev-flows.md`
Decision 9):** DevStudio serves the *current* ontology `.d.ts` from **its own source tree** (the
shell `Workspace`) — there is **no** Galaxy ontology-version registry / `getOntologySource(version?)`
/ `OntologyVersionRow.source` (eliminated). Three JSDoc annotations beyond what
`extractTypeMetadata` already collects (extending it is a build item the master plan sequences):

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
  ([`../on-hold/nebula-orm-and-queries.md`](../on-hold/nebula-orm-and-queries.md)); all three
  stored alongside `extractTypeMetadata()` output.
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
- Long iteration sequences will eventually need strategic archival of older turns.

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
gates first, LLM-judge only for fuzzy UI quality) is the parked eval suite
([`../on-hold/nebula-studio-eval-suite.md`](../on-hold/nebula-studio-eval-suite.md)).

## Fidelity ladders (the design constraints that span the work)

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
  case unchanged. Get the identity right and the eval suite is nearly free later; get it ad-hoc
  and the eval suite means a reformat. (Realized: the `TurnRecord` JSON payload in the Galaxy
  `Turns` table.)

- **Design the turn record + loop for the tool-calling shape, not the regex shape.** A real turn
  is *multiple `tool_calls` over several round-trips with interleaved compile errors*, not a
  single regex-extracted SFC.

## The flywheel

**Recorded turns → fast offline iteration → stabilized behavior promoted to regression gates.**
The corpus is the substrate; the prompt is the exploration; the eval suite is what freezes what
works. Code-writing stays **sequential / single-writer** even under ultracode — parallel agents
are for read-only mining (the vibesdk study), review panels, and verifiers, never concurrent
writers.
