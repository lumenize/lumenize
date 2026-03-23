# Phase 5.2.4: `@lumenize/ts-runtime-validator` Documentation

**Status**: Pending
**Package**: `packages/ts-runtime-validator/` (`@lumenize/ts-runtime-validator`)
**Depends on**: Phase 5.2.3 (Ontology integration — real-world usage may surface API changes)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`

## Goal

Write user-facing documentation for `@lumenize/ts-runtime-validator` in `/website/docs/ts-runtime-validator/`. Deferred until after Phase 5.2.3 (Ontology integration) so that real-world usage informs the docs rather than speculative examples.

## Why Deferred

The `validate()` and `toTypeScript()` APIs are intentionally kept unstable through Phases 5.2.2 and 5.2.3. The Ontology integration (5.2.3) is the first real consumer — it may surface ergonomic issues, missing features, or API changes. Writing docs before that risks rework. Once the API stabilizes through actual usage, the docs can be written against the proven API.

## Planned Content

### Pages

1. **Overview** (`index.mdx`) — "TypeScript IS the schema" vision, when to use this package, quick example
2. **Type Support** (`type-support.mdx`) — Comprehensive table of supported types, how each maps from JS values to TypeScript programs. Reference the type mapping tables from Phase 5.2.1.
3. **What's Checked / What's Not** (`validation-boundaries.mdx`) — Structural checking, excess property detection, known limitations. Consolidates:
   - Phase 5.2.1 Non-Goals (no `instanceof`, no generics inference, no conditional/mapped types)
   - Phase 5.2.2 Error Type Behavior (structural-only for errors, `Object.assign` excess property limitation)
   - Cycle back-edge placeholder limitation
   - Heterogeneous Map limitation: `Map<string, string | number>` with mixed value types fails because tsc infers V from the first constructor entry. Workaround: use `Map<string, any>`. Homogeneous maps validate correctly. See scratchpad "Heterogeneous Map Validation" for the planned fix — when that lands, update the docs to remove this limitation.
4. **Error Messages** (`error-messages.mdx`) — How to read `ValidationError` objects, property extraction, common tsc error codes and what they mean
5. **API Reference** (`api-reference.mdx`) — `validate()` and `toTypeScript()` signatures, `ValidationResult`/`ValidationError` types, examples

### Key User Guidance to Document

- **Define error shapes as interfaces**, not classes — tsc checks structural assignability, and `toTypeScript()` emits structural shape
- **Use primitive keys for Maps** — object-keyed Maps work for acyclic data but cannot have cycle fixups
- **Generics must be fully resolved** in type definitions — `interface TodoList { items: Todo[] }` not `interface TodoList<T> { items: T[] }`
- **Lumenize-specific types** (`RequestSync`, `ResponseSync`) must be declared in the `typeDefinitions` string — they're not in the built-in lib

### Code Example Validation

All code examples use `@check-example` annotations linking to tests in `packages/ts-runtime-validator/test/for-docs/`. No `@skip-check` in published docs.

## Sidebar

Add `ts-runtime-validator` section to `website/sidebars.ts`.

## Success Criteria

- [ ] All pages listed above created in `/website/docs/ts-runtime-validator/`
- [ ] All code examples validated with `@check-example` annotations
- [ ] `npm run check-examples` passes
- [ ] `npm run build` (website) passes
- [ ] Sidebar updated in `website/sidebars.ts`
- [ ] Package `README.md` updated with link to website docs
