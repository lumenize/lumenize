# Task: JSDoc Annotation Experiments

**Status:** Future
**Depends on:** nebula-5.2.5-multi-resource-queries.md (for hydration layer)
**Blog post:** [Write Your Types Once](/blog/write-your-types-once)

---

## Goal

Use JSDoc annotations in TypeScript interface definitions to express value constraints, defaults, and query filters — eliminating the need for separate Zod schemas, Prisma decorators, or SQL constraints.

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

`extractTypeMetadata()` already walks property signatures. Add `ts.getJSDocTags(member)` call to collect annotations. After tsc type-checking passes, do a second pass validating values against the collected constraints.

**Consider:** Move defaults from the current separate field to JSDoc too, for consistency.

### Supported Tags (Planned)

| Tag | Applies to | Example |
|---|---|---|
| `@default` | any | `@default false` |
| `@min` | number | `@min 0` |
| `@max` | number | `@max 5` |
| `@format` | string | `@format email` |
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
