# ADR-001: TypeScript as the Schema Language

**Date**: 2026-03-08
**Status**: Accepted
**Deciders**: Larry
**Evidence**: `packages/ts-runtime-parser-validator/` (the validator engine), `tasks/archive/nebula-ts-as-schema-research.md` (four-approach evaluation + tsc spike), `tasks/archive/typia-validator-engine.md` + `tasks/archive/parse-validate-release.md` (the typia engine)

## Context

Nebula resources need runtime validation, and the schemas are written by user-developers — often with no coding experience, working through Studio's LLM. Every established approach (Zod, TypeBox, JSON Schema) makes the author learn and maintain a second type language alongside TypeScript, with the two drifting apart over time. TypeScript is the one type vocabulary the ecosystem — and LLM training data — already speaks fluently. The platform had to decide, once, what the schema language is.

## Decision

**TypeScript types ARE the schema language.** Real `interface`/`type` definitions are the single source of truth for both compile-time checking and runtime validation — no Zod, no TypeBox, no JSON Schema, no parallel definitions anywhere in Lumenize. Wire/persistence boundaries validate against those same TS types via `@lumenize/ts-runtime-parser-validator`. Full TypeScript, not a subset: generics, conditional/mapped/utility types all work.

Two corollaries:
- **The JSDoc tag vocabulary on those types (`@minimum 13`, …) is part of the schema** — and therefore long-lived public API (aligned with typia's conventions).
- **Type definitions must be available as data** (source text), not erased at compile time — validation engines consume the types themselves, wherever provisioning happens.

**The decision is mechanism-independent.** The commitment is the schema *language*, not any particular validator engine: the current engine is typia codegen (`@lumenize/ts-runtime-parser-validator`), which compiles validators from the TS types themselves so the single-source-of-truth promise holds — but any engine that interprets *real* TypeScript satisfies the decision. The engine can evolve without relitigating the commitment.

Day-to-day enforcement lives in `.claude/rules/coding-style.md` § Type system.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Second schema language (Zod, TypeBox, JSON Schema) | Parallel definitions drift from the TS types; a second vocabulary for user-developers and Studio's LLM to learn; validation errors speak the wrong language. |
| Schema-subset dialect of TS (e.g. Ezno's "Schema TypeScript") | Still a second language, just disguised as the first. Full-TS expressiveness is the point. |
| Compile-time types only, no runtime validation | Data crosses trust boundaries (wire, persistence, LLM-generated app code). Security is on by default. |
| A validator engine bound to a TS *subset* or its own IR | Would narrow "the schema language" to what that engine parses, reintroducing a second dialect by the back door. The decision constrains engines to ones that interpret full, real TypeScript. |

## Consequences

### Positive
- One vocabulary: a user-developer (or Studio's LLM) writes `interface Todo { … }` once and gets static types and runtime validation from the same text.
- Validation failures are expressed in terms of the user's own types.
- The commitment is separable from the validator engine — the engine can be swapped without touching the decision, so the schema-language promise is the stable part.

### Negative
- Engine choice is constrained to engines that interpret real TypeScript — a real constraint on any future engine swap.
- Single-source-of-truth must be enforced repo-wide; one stray Zod schema breaks it (hence the coding-style rule).
- Full-TS expressiveness admits adversarially complex schemas; every engine needs input-size/complexity guards.
