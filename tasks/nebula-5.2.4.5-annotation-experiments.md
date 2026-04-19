# Task: JSDoc Annotation Experiments

**Status:** Future
**Depends on:** nebula-5.2.5-multi-resource-queries.md (for hydration layer)
**Blog post:** [Write Your Types Once](/blog/write-your-types-once)

> **Tag vocabulary note (2026-04-18):** The tag names in this file (`@min`, `@max`, `@format`, `@default`) reflect the original proof-of-concept vocabulary. The *canonical* tag vocabulary is decided in **5.2.4.1 Phase 3**, which aligns to typia's conventions (likely `@minimum`, `@maximum`, `@pattern`). When this task picks up, reconcile examples against whatever 5.2.4.1 pinned — 5.2.4.1's decisions take precedence.
>
> **Scope change (2026-04-18):** `@default` is no longer part of this task — it was absorbed into **5.2.4.1** (the parse-validate package's generated `parse()` fills defaults as part of validation). `extractTypeMetadata()` in the new `@lumenize/ts-runtime-parser-validator` already collects `@default` JSDoc tags. This task now covers only the validation-constraint tags (`@min`/`@max`/`@format` and their typia-aligned names).

---

## Goal

Use JSDoc annotations in TypeScript interface definitions to express value constraints and query filters — eliminating the need for separate Zod schemas, Prisma decorators, or SQL constraints. (Defaults via `@default` already shipped in 5.2.4.1 — see the scope-change note above.)

## JSDoc Value Constraints

Add runtime value constraints via JSDoc annotations in type definitions.

**Important:** Multiple stacked `/** */` blocks do NOT work — tsc only attaches the last one. Use a single multi-line block for multiple tags:

```typescript
interface Todo {
  /** @default false */
  done: boolean;
  /**
   * @min 0
   * @max 5
   * @default 0
   */
  priority: number;
  /** @format email */
  email: string;
}
```

The tsc AST already parses these into separate tag objects — no string parsing needed:
```
ts.getJSDocTags(priorityNode) → [
  { tagName: "min",     comment: "0" },
  { tagName: "max",     comment: "5" },
  { tagName: "default", comment: "0" },
]
```

### Implementation

`extractTypeMetadata()` in `@lumenize/ts-runtime-parser-validator` already walks property signatures and already calls `ts.getJSDocTags(member)` to collect `@default` tags (added in 5.2.4.1). Extend that same pass to collect `@min`/`@max`/`@format` (and whatever typia-aligned names 5.2.4.1 Phase 3 pinned). Enforcement happens inside the generated `parse()` — typia's own constraint tags cover most of what we need, so in many cases this reduces to "pass the canonical tag name through and let typia emit the check."

### Supported Tags (Planned)

| Tag | Applies to | Example |
|---|---|---|
| `@min` | number | `@min 0` |
| `@max` | number | `@max 5` |
| `@format` | string | `@format email` |

(`@default` is handled by 5.2.4.1, not this task.)
---

## M:N Relationships and Join Tables

### Tension

`assignedTo: Person[]` is natural in TypeScript but implies M:N in storage. In a document/DO model, the forward direction (Todo → Persons) is just an array of IDs. But the reverse (Person → Todos) needs either denormalization or a join table.

### Decision

Always use join tables for array-typed relationships (M:N). This keeps both directions queryable via SQL.

### Filtering Belongs in Queries, Not Schema

~~Originally considered a `@where` JSDoc annotation on relationship arrays for bounded hydration.~~ Rejected — it conflates schema (what the data looks like) with query behavior (how you fetch it). The type definition should be pure structure.

Bounded hydration is a real concern (unbounded arrays), but the solution is sensible defaults in the query layer:
- Default hydration depth limit (e.g., 1 level)
- Default array pagination (e.g., 50 items)
- Explicit filter syntax at query time:

```typescript
star.getResource('person-123', {
  include: {
    todos: { where: { done: false }, limit: 20 }
  }
});
```

This belongs in `tasks/nebula-5.2.5-multi-resource-queries.md`, not here.
