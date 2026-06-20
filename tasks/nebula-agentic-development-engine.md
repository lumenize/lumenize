# Nebula — Agentic Development Engine (codegen + eval)

**Status**: Design notes — **UNDER-SPECIFIED + UNREVIEWED**. Captured from the 2026-06-20 consolidation; **not build-ready**. The dev-loop that *runs* this engine is [`nebula-studio.md`](nebula-studio.md); the architecture/flows are canonical in [`nebula-dev-flows.md`](nebula-dev-flows.md). `nebula-studio.md` wires only a **minimal, unevaluated system prompt**; the make-it-better + evaluation work lives here.

**Terminology**: "**agentic**", never "agent" (avoids confusion with Cloudflare Agents). **DevStudio** (the server node) *runs* the **agentic development engine** — the codegen loop. There is no separate "agent" actor.

## What this is

The agentic development engine is the codegen capability DevStudio runs: an LLM loop that turns a user-developer's natural-language intent into Vue SFCs + an ontology `.d.ts`, iterating on errors. **Viability is proven** (see Verdict below — "Studio is a wrapper around a proven loop"). The quality, prompt, and evaluation work is open and unreviewed.

## Model decision — Kimi 2.7, no Think, no codemode

Codegen runs on **Kimi 2.7 (`@cf/moonshotai/kimi-k2.7-code`) via Workers AI** (binding mode). Basis: a month-long Cloudflare-Think + Kimi prototype + the CMA-vs-Think bake-off ([`archive/think-vs-cma-bakeoff.md`](archive/think-vs-cma-bakeoff.md)) settled on Kimi; the viability probe (below) confirmed Kimi generates compilable Nebula UI and self-corrects in a thin loop.

- **No Cloudflare Think.** It bundles a loop (trivial to roll), codemode, chat memory, and React/HTTP-shaped resilience — none worth adopting, and it drags a foreign multi-tenant DO surface we don't want. Everything it offers is rollable or better as native Lumenize (e.g. streaming as a Mesh WS primitive over the existing connection).
- **No codemode.** Its sandbox↔host tool bridge is JSON-only (base64 for binary) — an **ADR-002 violation** (we round-trip full structured-clone everywhere). When we want sandboxed dynamic execution, we roll our own with a mesh/RPC full-type bridge.
- **Claude is not in the product** — eval baseline only.

## Viability verdict — PROVEN 2026-06-16

Kimi 2.7 UI-gen is **viable** (probe `apps/nebula/spike/sfc-devstar-loop/`, three stages green; not-for-hand-review spike). Given `coding-your-ui.md` + the current ontology + the Nebula API `.d.ts` as context, Kimi produced a **compilable** `App.vue` + `ontology.d.ts` first-shot and **self-corrected in ~2 rounds**.

- **Model fact:** slug `@cf/moonshotai/kimi-k2.7-code` on Workers AI; **OpenAI-style** response shape (`result.choices[0].message.content`, not `result.response`).
- **Got right unprompted:** auto-subscribe `store.resources.<rt>[id].value` paths; `import { store, client } from './nebula'`; per-user `client.claims.sub` keying; container-resource id-list pattern; `v-model` guarded by `v-if`; client-side `computed` aggregates; atomic create-+-append in one `transaction`; DaisyUI throughout.
- **The one real bug:** Kimi invented `op: 'set'` (real vocab is `create`/`put`) — a runtime API-contract error compile can't catch. This is exactly why we **feed the real Nebula API `.d.ts`** as context and **wire an error-tail** for self-correction. A prompt-completeness gap, not a capability gap.
- **Loop lessons:** use **native tool-calling**, not regex-on-prose (`finish_reason: tool_calls` verified on Kimi); feed the real `.d.ts`; wire a real error-tail (`get_recent_errors` / debug-tail). **Caveat:** runs vary run-to-run — this verdict is directional, not statistical (the rigorous regression suite is the eval-suite, below).
- **Substrate facts:** native tool-calling means **no sandbox** (no LLM-authored code runs server-side); `@cloudflare/codemode` is standalone but JSON-only (dropped, ADR-002); DO facets are independent of dynamic workers (a loader is only needed for a *runtime-generated* facet class).

> The spike's *implementation* plan (in-DO `DevStar.compileSFC`, files-as-resources, in-DO `tsc`, `register_ontology_version`) is **superseded** by `nebula-dev-flows.md` — vite owns SFC compile in the DevContainer (Decisions 2/9). Only the **verdict + lessons** survive.

## Orchestration

- **Thin, self-rolled native tool-calling loop**, run by **DevStudio** (the server node) — the model emits structured `tool_calls`, our code executes them; no LLM-authored code runs server-side, so the loop needs **no sandbox**.
- Earlier notes homed this in "a Nebula-owned DO/facet" — superseded: **DevStudio is the home** (facets are deferred, `nebula-dev-flows.md` Decision 8). A `script-per-step` facet sandbox (model writes one orchestration script per step, run with a mesh/full-type bridge) is a **pocketed cost/latency optimization**, added only if per-call tool-calling proves too chatty — the AIA-proven win, rebuilt without codemode's JSON.

### Two agentic contexts (where dynamic execution pays off)
1. **Studio authoring loop** (this engine) — per-call tool-calling to start; `script-per-step` is the pocketed optimization.
2. **In-app AI chat** (post-Studio; every Nebula app auto-gets one) — interactive **RAG against the app's own data** for the customer's end-users. Highest-value dynamic codegen/execution (per-end-user, at scale, latency-sensitive). Same substrate; likely its own task file when picked up.

## Resource-metadata conventions the engine consumes

The engine reads the **raw `.d.ts` source** (LLMs read TypeScript natively; a bespoke JSON shape is strictly worse — the **source IS the spec**). **Re-homed (Decision 9):** DevStudio serves the *current* ontology `.d.ts` from **its own source tree** (the shell `Workspace`) — there is **no** Galaxy ontology-version registry / `getOntologySource(version?)` / `OntologyVersionRow.source` (eliminated). Three JSDoc annotations beyond what `extractTypeMetadata` already collects:

| Annotation | Where | Required? | Use |
|---|---|---|---|
| **`@title`** | type + field | required | human label for UI labels, breadcrumbs, dropdowns (PascalCase/camelCase names are programmer shorthand) |
| **`@description`** | type + field | optional | prose intent → tooltips/help; lets the AI reason about usage |
| **`@inverse <fieldName>`** | relationship field | required (on relationships) | names the inverse field on the target type; disambiguates 1:M vs M:N; runtime uses it for the future query engine |

- **Not in the set** (and why): `@id` (every resource has `id` by convention), `@unique`/`@index` (Star storage / eTag concern), `@onDelete` (post-demo; cascade is the AI-generated UI's job for now), cardinality (`T` vs `T[]` says it), FK-location (inferable from the inverse pattern).
- **PascalCase interface name IS the URL slug** — `{baseUrl}/{u}.{g}.{s}/resources/{TypeName}/{id}` (e.g. `/WorkoutSession/session-42`). No kebab translation (a second mapping to drift); multi-word names translate ambiguously; PascalCase has zero ambiguity.
- **Runtime use (invisible to the AI):** `@title`/`@description` flow into validation error messages; `@inverse` feeds the post-demo query engine ([`on-hold/nebula-orm-and-queries.md`](on-hold/nebula-orm-and-queries.md)); all three stored alongside `extractTypeMetadata()` output.
- **Build step:** extend `extractTypeMetadata()` in `@lumenize/ts-runtime-parser-validator` (additive — it already walks JSDoc tags for `@default`); document at `website/docs/nebula/resource-types.md`.
- **Open:** `@title`-required is verbose (could default to humanized field name, `@title` as override-only); are all interfaces resources or are some embedded value types (demo: all are resources); cascade-is-the-UI's-job system-prompt hint.

## Context-window strategy

- The **current ontology stays permanently pinned** in context — everything generated centers on it; dropping it makes the engine useless. Refresh the pin whenever it changes.
- Annotation docs (written for humans) provided as reference.
- Long iteration sequences will eventually need strategic archival of older turns — not for the demo.

## Language-model strategy (arc)

- **Short term:** prompt engineering against Kimi (Workers AI) with Nebula-specific system prompts + few-shot examples.
- **Medium term:** a fine-tuned small model specialized for Nebula UI + Resources patterns.
- **Training data:** Nebula's docs, example apps, the Resources + `client.orgTree` API surface, the Nebula UI component library.

## Evaluation strategy

Once the generation surface exists, **fork to evaluate (system prompt) × (model)** on real codegen tasks. Start with Kimi 2.7 — **live use IS the eval**; don't front-load a model bake-off. Claude as a baseline comparison. Tasks under eval = real generation jobs (todo, kanban, simple CRM): does the model produce working ontology + UI that passes validation and runs with access-control + reactivity intact? The **rigorous regression suite** (deterministic gates first, LLM-judge only for fuzzy UI quality) is parked in [`on-hold/nebula-studio-eval-suite.md`](on-hold/nebula-studio-eval-suite.md) — un-park when this engine is a real churning loop.

## Pre-build reading: vibesdk LLM patterns

Before the codegen loop is really built, mine [`cloudflare/vibesdk`](https://github.com/cloudflare/vibesdk) (MIT, ~year of production iteration) for the **LLM-orchestration layer** — prompts, model routing, tool defs, the state-machine agentic loop, streaming/abort/reconnect, AI-Gateway plumbing. **NOT** for back-end/dev-loop patterns (settled in `nebula-dev-flows.md`) or what-code-to-generate. Output → `tasks/reference/vibesdk-llm-patterns.md` (topic-organized).

- **Read (priority order):** `worker/agents/inferutils/config.ts` (`AGENT_CONFIG` model-per-operation map), `worker/agents/prompts.ts`, `operations/UserConversationProcessor.ts` (the chat pattern, ~line 50), `operations/PhaseGeneration.ts` + `PhaseImplementation.ts` (the state machine), `assistants/codeDebugger.ts` (deep-debugger tool ordering), `tools/customTools.ts` + `tools/toolkit/`, `schemas.ts`, the AI-Gateway code, `samplePrompts.md` + `docs/`, their `CLAUDE.md`.
- **Output sections:** model routing · system-prompt architecture · tool defs & loops · state machine for bounded work · streaming+abort+reconnect · token-efficiency (empty-tool-result skipping, dedup, caching) · AI-Gateway integration · structured output & validation · long-context strategies. Each: prose + a code excerpt + a "what to consider for Nebula" note (mapped to *this* engine and to in-app chat).
- **Caveats:** filter for *talking-to-LLMs*, not *what-code-to-generate*; MIT — excerpts fine, copying follows `ATTRIBUTIONS.md` + <1000 SLOC.
- **Stop condition:** all sections have content + ≥1 code ref + a "for Nebula" note; a reader can design prompts/tools without re-reading vibesdk.

## Open / under-specified (the unreviewed part)

- The codegen **system prompt** itself — `nebula-studio.md` ships a *minimal, unevaluated* one; iterating it to quality is the bulk of the open work here.
- Prompt shape + how much hand-holding Kimi needs for SFCs (vs the already-good ontology gen).
- Tool surface for UI-gen (does it want a different surface than data-ops?).
- Error-tail signal quality for self-correction (good enough, or does it drown the model?).
- Completed-gate quality bar: "compiles + runs + feature present + access-control enforced" (not a quality score) for the demo.
