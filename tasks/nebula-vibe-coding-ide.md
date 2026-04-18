# Nebula Vibe Coding IDE

**Phase**: 9
**Status**: Pending (weeks away)
**Package**: `@lumenize/nebula`
**Depends on**: Phase 5 (Resources), Phase 7 (Nebula Client), Phase 8 (Nebula UI), Phase 4 (Isolation Research)
**Master task file**: `tasks/nebula.md`

## Goal

Build the UI where Nebula users (vibe coders) define their data model, write guards/validation, and iterate on their application — all without touching a traditional development environment. This is the authoring experience, not the end-user application UI (that's Phase 8).

The vibe coder describes what they want in natural language, a language model generates the Nebula UI components and Resources configuration, and the code runs in DWL isolates. The IDE provides the feedback loop: describe → generate → preview → adjust.

## Core Components

### Code Generation

- Language model generates `ResourcesWorker` subclasses (resource config, guards, validation, migrations)
- Language model generates Nebula UI components (the end-user facing UI)
- Generated code is TypeScript strings deployed to DWL isolates
- Schema validation via `tsc`/`tsgo` in Containers (informed by Phase 7 research)

### Editor / Preview

- In-browser editing environment for reviewing and tweaking generated code
- Live preview of the Nebula UI components
- Real-time feedback: save → DWL hot-reload → preview updates

### Nebula API Schema Definitions for LLM Context

The Nebula API surface (resource operations, DAG tree operations, permission model, subscription patterns) should be documented as TypeScript type definitions (`.d.ts` files) that are provided to the IDE's language model as context. This gives the LLM precise knowledge of how to write code that uses Nebula functionality — method signatures, operation descriptors, return types, error conditions — all expressed in the TypeScript type language the LLM already understands.

This reuses the Phase 5.2 tsc-in-DWL capability (`docs/adr/001-typescript-as-schema.md`) — the same TypeScript types that validate data at runtime also serve as API documentation for the code generation model. Single source of truth: the types ARE the documentation.

### Language Model Strategy

- **Short term**: Prompt engineering against general-purpose models (Claude, GPT) with Nebula-specific system prompts and few-shot examples
- **Medium term**: Fine-tuned small model specialized for Nebula UI and Nebula Resources patterns
- **Training data**: Nebula's own documentation, example apps, the `ResourcesWorker` API surface, Nebula UI component library

### Follow-On Work

See `tasks/nebula-scratchpad.md` § "Vibe Coding IDE Follow-On" for the full list (training pipeline, prompt engineering, code validation, version control, collaboration, marketplace).

## Open Questions

Everything — this phase is far out. Key questions to answer as we get closer:

- What's the right editor component? (Monaco, CodeMirror, custom, or no code editor at all — pure natural language?)
- How much of the generated code should the vibe coder see vs. be hidden behind the natural language interface?
- How do we handle model context window limits when the application grows?
- Hosting: where does the IDE run? (Nebula UI itself? Separate app? Browser extension?)
- How does the training data pipeline work for the fine-tuned model?

## Success Criteria

TBD — too early to define. Rough shape:

- [ ] Vibe coder can describe a data model in natural language and get a working `ResourcesWorker`
- [ ] Generated code deploys to DWL and passes schema validation
- [ ] Preview shows live Nebula UI components backed by real Resources
- [ ] Edit → regenerate → preview cycle is under 5 seconds
