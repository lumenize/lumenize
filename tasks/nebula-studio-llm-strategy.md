# Nebula Studio — LLM & Eval Strategy

**Status**: Active (later-phase — evals run once Studio's generation surface exists). Split out of `tasks/nebula-studio.md` 2026-06-16.

**Parent**: `tasks/nebula-studio.md` (this file owns Studio's model choice, orchestration, and evaluation; Studio owns the generation loop those models drive).

## Model decision — Think + Kimi 2.7

Studio's code generation runs on **Cloudflare Think + Kimi 2.7**. Basis: the entire month of May we built another prototype product on Cloudflare Think + Kimi (2.6, now 2.7) and were very happy; a several-day bake-off of **Claude Managed Agents (CMA) vs. Cloudflare Think** had Think win hands-down on several fronts (`tasks/archive/think-vs-cma-bakeoff.md`; Kimi-for-Studio chosen 2026-06-12 — live use is the eval).

- **Claude models are not in the product.** Kept only as an **eval baseline** to compare against.
- **The Think integration is likely pulled forward.** Studio leaning on Think+Kimi makes the Think↔Nebula multi-tenant fit a probable Studio prerequisite — `tasks/think-nebula-integration.md` (the learning/design file) and `tasks/shim-hardening.md` (production-grade follow-up). This may erase the time savings of dropping the Claude-Code pre-Studio gate, but the model direction is settled regardless.
- **Don't conflate** Studio's code-generation loop with the Mesh/Nebula↔Think integration shim (in-app AI / server-side LLM). Both are live; the shim is transport, Studio's loop is a consumer. (We OBE'd the shim tasks once on this confusion — reversed.)

## Orchestration

- Roll the orchestration ourselves on **Workers + Durable Objects** — frameworks like LangChain add overhead we don't need.
- Mix models by task: a heavier model for ontology generation + complex UI generation; a lighter model for small iterations + debug interpretation.
- Mine Cloudflare's open-source vibe-coding platform for prompt / model-routing / tool / agent-state / AI-Gateway patterns first — `tasks/vibesdk-llm-patterns.md`.
- Look up current model identifiers + capabilities before wiring — don't assume from training data.

## Language model strategy (arc)

- **Short term**: prompt engineering against Think + Kimi with Nebula-specific system prompts + few-shot examples.
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
