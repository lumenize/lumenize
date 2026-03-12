# Phase 5.2: TypeScript Validation & Ontology

**Status**: Pending
**Depends on**: Phase 5.1 (Storage Engine)

## Overview

"TypeScript IS the schema" — vibe coders write standard TypeScript types, and those same types validate data at runtime via the real TypeScript compiler. No Zod, no JSON Schema, no parallel definitions. Validation runs in-process (synchronous, ~1ms) — no DWL needed because tsc parses type definitions as data, it doesn't execute user code. DWL is reserved for Phase 5.5/6 schema migrations, which do run vibe-coder-provided transform code.

This phase is broken into sub-phases that build on each other:

| Sub-Phase | Name | Task File | Deliverable |
|-----------|------|-----------|-------------|
| 5.2.1.1 | Wrangler & Toolchain Upgrade | `tasks/nebula-5.2.1.1-wrangler-upgrade.md` | Updated wrangler, vitest-pool-workers, compatibility_date across monorepo |
| 5.2.1.2 | DWL-in-vitest-pool-workers Spike | `tasks/nebula-5.2.1.2-dwl-vitest-spike.md` | Validated (or fallback) testing strategy for round-trip echo tests |
| 5.2.1 | Structured-Clone `toTypeScript()` | `tasks/nebula-5.2.1-structured-clone-to-typescript.md` | `toTypeScript()` in `@lumenize/ts-runtime-validator` |
| 5.2.2 | `validate()` Function | `tasks/nebula-5.2.2-validate.md` | Pure function in `apps/nebula/src/validate.ts` |
| 5.2.3 | Ontology & Resources Integration | `tasks/nebula-5.2.3-resources-validation-integration.md` | Ontology class, relationship extraction, in-process validation in `transaction()` |
| 5.2.5 | Multi-Resource Queries | `tasks/nebula-5.2.5-multi-resource-queries.md` | `query()` with ontology-driven relationship resolution |

## Dependency Chain

```
5.2.1.1 (wrangler upgrade)
  └─▶ 5.2.1.2 (DWL spike — validates testing strategy)
        └─▶ 5.2.1 (toTypeScript)
              └─▶ 5.2.2 (pure validate function)
                    └─▶ 5.2.3 (Ontology class + Resources integration)
                          └─▶ 5.2.5 (multi-resource queries)
```

## Scratchpad

- In order to validate, we're going to need to know the type and version.
- The tsc capability also enables TypeScript API schema definitions for the IDE/LLM — documenting the Nebula API surface as TypeScript types that the vibe coding IDE's language model can use to generate correct code. See Phase 9 (`tasks/nebula-vibe-coding-ide.md`).
- Future: extract `validate()` into a standalone MIT-licensed `@lumenize/ts-runtime-validate` package. See `tasks/nebula-scratchpad.md`.
