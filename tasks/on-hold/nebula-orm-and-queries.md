# Nebula ORM and Queries (post-demo)

**Status**: ON HOLD — demo focus
**Was previously**: Phases 5.2.4.5 (Annotation Experiments) and 5.2.5 (Multi-Resource Queries) — merged here because they're closely related ORM-flavored work that will likely unfreeze together. The numeric phase identifiers were dropped during the demo-focus cleanup; this is now standalone post-demo work, not a sub-phase of 5.2 (which is complete).
**Related (reference)**: `tasks/reference/nebula-agentic-engine-design.md` (§ Resource-metadata conventions) defines `@inverse` (and `@title`/`@description`) for the demo. The post-demo query engine described here uses `@inverse` to resolve relationships at query time. The annotation IS being collected today; only the query engine that consumes it is on hold.
**Depends on**: 5.2.3 (Ontology & Resources Integration — shipped) and 5.2.4.2 (parse-validate package, per-version Galaxy registry — shipped)

## Why merged

Three threads of work that share an ORM/relationship layer concern:

1. **JSDoc validation constraints** (`@min`, `@max`, `@format` and their typia-aligned canonical names) — small, tangential to ORM proper, but the same `extractTypeMetadata()` pass collects them.
2. **M:N relationships and join tables** — strict ORM territory. Decided: always use join tables for array-typed relationships (M:N).
3. **Multi-resource `query()`** — GraphQL-style nested reads in one round trip, server-side relationship resolution using ontology metadata.

(2) and (3) are clearly the same body of work. (1) is small enough that a separate file would have been awkward; carry it along here.

---

## Part A: JSDoc Validation Constraints

> **Scope note (carried from the original 5.2.4.5 file)**: `@default` was absorbed into the parse-validate package (5.2.4.1) — the generated `parse()` fills defaults during validation and `extractTypeMetadata()` already collects `@default` JSDoc tags. This work covers only the validation-constraint tags (`@min`/`@max`/`@format` and their typia-aligned canonical names like `@minimum`/`@maximum`/`@pattern`).
>
> **Tag vocabulary note (2026-04-18)**: The canonical tag vocabulary is decided in 5.2.4.1 Phase 3, which aligns to typia's conventions. Reconcile examples against whatever 5.2.4.1 pinned — those decisions take precedence.

### Goal

Use JSDoc annotations in TypeScript interface definitions to express value constraints — eliminating the need for separate Zod schemas, Prisma decorators, or SQL constraints.

### Implementation

`extractTypeMetadata()` in `@lumenize/ts-runtime-parser-validator` already walks property signatures and already calls `ts.getJSDocTags(member)` to collect `@default` tags (added in 5.2.4.1). Extend that same pass to collect `@min`/`@max`/`@format` (and whatever typia-aligned names 5.2.4.1 Phase 3 pinned). Enforcement happens inside the generated `parse()` — typia's own constraint tags cover most of what we need, so in many cases this reduces to "pass the canonical tag name through and let typia emit the check."

**Important syntax point**: Multiple stacked `/** */` blocks do NOT work — tsc only attaches the last one. Use a single multi-line block for multiple tags:

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

The tsc AST already parses these into separate tag objects — no string parsing needed.

### Supported Tags (Planned)

| Tag | Applies to | Example |
|---|---|---|
| `@min` / `@minimum` | number | `@min 0` |
| `@max` / `@maximum` | number | `@max 5` |
| `@format` / `@pattern` | string | `@format email` |

Final naming pinned per 5.2.4.1 Phase 3.

---

## Part B: M:N Relationships and Join Tables

### Tension

`assignedTo: Person[]` is natural in TypeScript but implies M:N in storage. In a document/DO model, the forward direction (Todo → Persons) is just an array of IDs. But the reverse (Person → Todos) needs either denormalization or a join table.

### Decision

**Always use join tables for array-typed relationships (M:N).** Keeps both directions queryable via SQL.

### Filtering belongs in queries, not schema

Originally considered a `@where` JSDoc annotation on relationship arrays for bounded hydration. Rejected — conflates schema (what the data looks like) with query behavior (how you fetch it). The type definition should be pure structure.

Bounded hydration is a real concern (unbounded arrays), but the solution is sensible defaults in the query layer:
- Default hydration depth limit (e.g., 1 level)
- Default array pagination (e.g., 50 items)
- Explicit filter syntax at query time (see Part C below)

---

## Part C: Multi-Resource `query()`

### Goal

GraphQL-style nested reads in a single round trip. Server-side relationship resolution using the ontology from 5.2.3 (e.g., invoice → rows → products without the client knowing intermediate IDs). All in one synchronous call since everything is in Star's SQLite.

### Context

Phase 5.1's `read()` returns a single resource. Real applications need to fetch related resources in one call — an invoice with its line items, a project with its tasks and assignees, a category tree with nested products. Without multi-resource queries, the client must make N sequential reads, each requiring a round trip through the WebSocket → Gateway → Star path.

Since all resources for a Star live in the same SQLite database, the server can resolve relationships locally with zero network hops. The ontology (from 5.2.3's `Ontology` class) describes the relationships; this engine traverses them.

### How the Ontology Feeds In

5.2.3's `Ontology` class provides:
- **Type definitions** — what fields each resource type has
- **Relationship metadata** — `getRelationship(typeName, fieldName)` returns `{ target, foreignKey, cardinality, inverseOf }`

Example query the engine resolves using relationship metadata:

```typescript
// Client requests:
star.resources().query({
  type: 'Invoice',
  id: 'invoice-123',
  include: {
    lineItems: {                    // relationship name from ontology
      include: {
        product: {}                 // nested relationship
      }
    },
    customer: {}                    // another relationship
  }
});

// Server resolves using ontology:
// 1. Read Invoice invoice-123
// 2. ontology.getRelationship('Invoice', 'lineItems') → { target: 'LineItem', inverseOf: 'invoice', cardinality: 'many' }
//    → Scan LineItems where invoiceId = 'invoice-123'
// 3. For each LineItem, ontology.getRelationship('LineItem', 'product') → { target: 'Product', foreignKey: 'productId', cardinality: 'one' }
//    → Lookup Product by ID
// 4. ontology.getRelationship('Invoice', 'customer') → { target: 'Customer', foreignKey: 'customerId', cardinality: 'one' }
//    → Lookup Customer by ID
// 5. Return assembled graph
```

Filtering syntax at query time (also referenced from Part B):

```typescript
star.getResource('person-123', {
  include: {
    todos: { where: { done: false }, limit: 20 }
  }
});
```

### Relationship Resolution Strategies

| Cardinality | FK Location | Strategy |
|---|---|---|
| `one` | Source has FK (`foreignKey`) | Direct lookup by ID |
| `many` | Target has FK (`inverseOf`) | Scan/index on target's FK column |
| `many-to-many` | Junction table | Scan junction → lookup targets |

All strategies are local SQLite queries — no network hops.

### Open Questions

- **Query language**: TypeScript method chaining? GraphQL subset? Plain object? Method chaining is type-safe and IDE-friendly. GraphQL adds parsing complexity. Plain object is simplest but loses type safety.
- **Depth limits**: Prevent runaway traversals. Default max depth of 3? Configurable per query?
- **Permission checking**: Per-resource or per-query-root? Per-resource is correct (DAG permissions are per-node) but potentially expensive for large result sets. Could cache permission checks within a single query.
- **Pagination within relationships**: A `one-to-many` relationship could return thousands of items. Support `limit`/`offset` per relationship? Or cursor-based?
- **Filtering within relationships**: How much filtering power? Full predicate language or just equality?
- **Interaction with subscriptions (Phase 5.3)?** Subscribe to a query result? Re-run the query when any included resource changes?
- **Index requirements**: `many` relationships need an index on the FK column in the target type's resources. Does the ontology automatically create these indexes, or does the user-developer declare them?
- **Return format**: Nested objects (natural but duplicates shared references) or normalized (flat with IDs, client reassembles)? Nested is simpler for the user-developer.
- **Computed inverse aggregates**: The ontology knows `Todo.assignedTo: Person[]` is a relationship. Can the query engine compute `todoCount` on Person at query time without the user-developer declaring it as a stored field? This would avoid needing cross-resource migrations (see iceboxed `nebula-5.5-schema-evolution.md` `migrate` query parameter discussion) for common aggregates like counts, sums, and existence checks.

### Success Criteria (when this resumes)

- [ ] `query()` method on Resources resolves nested relationships in a single call
- [ ] Relationship resolution uses ontology metadata (no hardcoded knowledge of types)
- [ ] `one` relationships resolved by direct lookup
- [ ] `many` relationships resolved by FK scan
- [ ] M:N relationships resolved via join tables (per Part B)
- [ ] Depth limits enforced (configurable, default 3)
- [ ] Permission checks applied per-resource in the result set
- [ ] Performance: query with 2 levels of nesting completes in <10ms for reasonable dataset sizes
- [ ] All results are current snapshots (validTo = END_OF_TIME)
- [ ] JSDoc validation constraints (Part A) flow through to the generated `parse()`
- [ ] Test coverage: >80% branch, >90% statement
