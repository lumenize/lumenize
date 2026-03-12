# Phase 5.2.5: Multi-Resource Queries

**Status**: Pending
**App**: `apps/nebula/`
**Depends on**: Phase 5.2.3 (Ontology & Resources Integration)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`
**Master task file**: `tasks/nebula.md`

## Goal

GraphQL-style nested reads in a single round trip. Server-side relationship resolution using the ontology from Phase 5.2.3 (e.g., invoice → rows → products without the client knowing intermediate IDs). All in one synchronous call since everything is in Star's SQLite.

## Context

Phase 5.1's `read()` returns a single resource. Real applications need to fetch related resources in one call — an invoice with its line items, a project with its tasks and assignees, a category tree with nested products. Without multi-resource queries, the client must make N sequential reads, each requiring a round trip through the WebSocket → Gateway → Star path.

Since all resources for a Star live in the same SQLite database, the server can resolve relationships locally with zero network hops. The ontology (from Phase 5.2.3's `Ontology` class) describes the relationships; this phase builds the query engine that traverses them.

## How the Ontology Feeds In

Phase 5.2.3's `Ontology` class provides:
- **Type definitions** — what fields each resource type has
- **Relationship metadata** — `getRelationship(typeName, fieldName)` returns `{ target, foreignKey, cardinality, inverseOf }`

The query engine uses relationship metadata to resolve nested reads:

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

### Relationship Resolution Strategies

The ontology's relationship metadata determines the query strategy:

| Cardinality | FK Location | Strategy |
|-------------|-------------|----------|
| `one` | Source has FK (`foreignKey`) | Direct lookup by ID |
| `many` | Target has FK (`inverseOf`) | Scan/index on target's FK column |
| `many-to-many` | Junction table | Scan junction → lookup targets |

All strategies are local SQLite queries — no network hops.

## Open Questions

- **Query language**: TypeScript method chaining (shown above)? GraphQL subset? Plain object? Method chaining is type-safe and IDE-friendly. GraphQL adds parsing complexity. Plain object is simplest but loses type safety.
- **Depth limits**: Prevent runaway traversals. Default max depth of 3? Configurable per query?
- **Permission checking**: Per-resource or per-query-root? Per-resource is correct (DAG permissions are per-node) but potentially expensive for large result sets. Could cache permission checks within a single query.
- **Pagination within relationships**: A `one-to-many` relationship could return thousands of items. Support `limit`/`offset` per relationship? Or cursor-based?
- **Filtering within relationships**: `include: { lineItems: { where: { amount: { gt: 100 } } } }` — how much filtering power? Full predicate language or just equality?
- **How does this interact with subscriptions (Phase 5.3)?** Subscribe to a query result? Re-run the query when any included resource changes?
- **Index requirements**: `many` relationships need an index on the FK column in the target type's resources. Does the ontology automatically create these indexes, or does the vibe coder declare them?
- **Return format**: Nested objects (natural but duplicates shared references) or normalized (flat with IDs, client reassembles)? Nested is simpler for the vibe coder.
- **Computed inverse aggregates**: The ontology knows `Todo.assignedTo: Person[]` is a relationship. Can the query engine compute `todoCount` on Person at query time without the vibe coder declaring it as a stored field? This would avoid needing cross-resource migrations (see Phase 5.5 `migrate` query parameter discussion) for common aggregates like counts, sums, and existence checks.

## Success Criteria

- [ ] `query()` method on Resources resolves nested relationships in a single call
- [ ] Relationship resolution uses ontology metadata (no hardcoded knowledge of types)
- [ ] `one` relationships resolved by direct lookup
- [ ] `many` relationships resolved by FK scan
- [ ] Depth limits enforced (configurable, default 3)
- [ ] Permission checks applied per-resource in the result set
- [ ] Performance: query with 2 levels of nesting completes in <10ms for reasonable dataset sizes
- [ ] All results are current snapshots (validTo = END_OF_TIME)
- [ ] Test coverage: >80% branch, >90% statement
