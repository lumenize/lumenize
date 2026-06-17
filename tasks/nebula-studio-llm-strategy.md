# Nebula Studio — LLM & Eval Strategy

**Status**: Active (later-phase — evals run once Studio's generation surface exists). Split out of `tasks/nebula-studio.md` 2026-06-16.

**Parent**: `tasks/nebula-studio.md` (this file owns Studio's model choice, orchestration, and evaluation; Studio owns the generation loop those models drive).

## Model decision — Kimi 2.7, no Think, no codemode

Studio's code generation runs on **Kimi 2.7 (`@cf/moonshotai/kimi-k2.7-code`) via Workers AI** (binding mode). Basis: a month-long prototype on Cloudflare Think + Kimi + the CMA-vs-Think bake-off (`tasks/archive/think-vs-cma-bakeoff.md`) settled on Kimi; the viability probe (`tasks/kimi-ui-gen-viability.md`) then confirmed Kimi generates compilable Nebula UI and self-corrects in a thin loop.

- **No Cloudflare Think.** Evaluated and dropped: it bundles a loop (trivial to roll), codemode, chat memory, and React/HTTP-shaped resilience — none worth adopting, and it drags a foreign-DO multi-tenant surface we don't want. Everything it offered is rollable or better-shaped as native Lumenize (e.g. streaming as a Mesh WS primitive over our existing connection).
- **No codemode.** Its sandbox↔host tool bridge is JSON-only (base64 for binary) — an ADR-002 violation (we round-trip full structured-clone everywhere). When we want sandboxed dynamic execution, we roll our own with a mesh/RPC full-type bridge.
- **Claude models are not in the product** — eval baseline only.

## Orchestration

- **Thin, self-rolled tool-calling loop** on Workers + DO. Native tool-calling works on `kimi-k2.7-code` (verified) — the model emits structured `tool_calls`, our code executes them; **no LLM-authored code runs server-side, so the loop needs no sandbox.**
- **Agent home: a Nebula-owned DO/facet**, co-located with the user for low latency (facet = isolated child DO sharing the supervisor's colo; needs no loader for a static class).
- Mix models by task where it helps; mine `tasks/vibesdk-llm-patterns.md` for prompt/tool/agent-state patterns first; confirm model ids before wiring.

### Two AI contexts (where dynamic execution pays off)

1. **Studio authoring loop** (this file) — per-call tool-calling to start. **Script-per-step** (the model writes one orchestration script per step, run in a facet sandbox with a mesh/full-type bridge) is a pocketed **cost/latency** optimization, added only if per-call proves too chatty — the AIA-proven win, rebuilt without codemode's JSON.
2. **In-app AI chat** (post-Studio; every Nebula app auto-gets one) — interactive **RAG against the app's own data** for the customer's end-users. This is where dynamic code-gen/execution matters most (per-end-user, at scale, latency-sensitive). Same substrate: a Nebula-owned facet + our own dynamic execution (no Think, no codemode-JSON). Likely warrants its own task file when picked up.

## Language model strategy (arc)

- **Short term**: prompt engineering against Kimi (via Workers AI) with Nebula-specific system prompts + few-shot examples.
- **Medium term**: a fine-tuned small model specialized for Nebula UI + Nebula Resources patterns.
- **Training data**: Nebula's own documentation, example apps, the Resources + `client.orgTree` API surface, the Nebula UI component library.

## Context-window strategy

- The current ontology stays **permanently pinned** in context — everything the AI generates centers on it; dropping it makes the AI useless. Refresh the pin whenever it changes.
- Annotation documentation (already written for humans) is provided as reference.
- Plan for context pressure across long iteration sequences — strategic archival of older turns will eventually matter, but not for the demo.

## Eval strategy

Once the generation surface exists, **fork to evaluate (system prompt) × (model) combinations** on real code-generation tasks (build-sequencing #3 in the parent file).

- **Default: start with Kimi 2.7 Code** (already chosen — live use is the eval); only consider another model if K2.7 proves problematic. Don't front-load a model bake-off.
- Use **Claude as a baseline** comparison.
- Tasks under eval are real generation jobs (todo list, kanban, simple CRM): does the model produce working ontology + UI that passes validation and runs with access-control + reactivity intact?
