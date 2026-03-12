# Phase 5.5: Schema Evolution

**Status**: Pending
**Depends on**: Phase 5.2 (tsc Validation)
**Parent**: `tasks/nebula.md`

## Scope

User-provided migration functions running in DWL sandbox. Version tracking per resource type, migration chain execution, lazy read-time migration with write-back, migration error handling. Builds on tsc validation but separate concern.

## Migration Design

### `migrate` — per-type transforms for existing resources

Defined in the ontology config (Phase 5.2.3) as part of each version entry. A map of type name → transform function. Signature: `(data, query?) => newData`. Object in, object out. The optional `query` parameter is provided by the consumer and is opaque to the Ontology class — it enables cross-resource migrations (e.g., denormalized aggregates) without coupling to any storage layer.

```typescript
// Pure transform — computed from fields within the same object
migrate: {
  Person: (data) => ({
    ...data,
    fullName: `${data.firstName} ${data.lastName}`,
  }),
},

// Cross-resource — query provided by consumer (e.g., Nebula passes query access)
migrate: {
  Person: (data, query) => ({
    ...data,
    todoCount: query.count('Todo', { assignedTo: data.id }),
  }),
},
```

Most migrations are pure transforms (field renames, defaults, computed fields from the same object). Cross-resource migrations are rarer but real — e.g., adding a denormalized count or summary from related resources. The `query` parameter keeps this door open without complicating the common case.

**Alternative to stored aggregates**: If `todoCount` is derived from a relationship the ontology already knows about (`Todo.assignedTo: Person[]`), it could be computed at query time (Phase 5.2.5) instead of stored. The vibe coder wouldn't declare it in the interface — it'd appear in query results as a computed inverse. This avoids migration entirely but doesn't cover all cases (e.g., aggregates with filtering or custom logic).

### Function vs String

Each per-type migration function accepts either:
- **A real function** — for standalone package users and testing
- **A string** — for serialization and later DWL execution in Nebula

When a function, the ontology can execute it directly. When a string, the ontology stores it but the consumer is responsible for execution (e.g., Nebula runs it in a DWL isolate for sandboxing). The package provides `ontology.getMigration(version, typeName)` to retrieve either form.

The first version in the array has no `migrate` (no previous version to migrate from). Types not listed in `migrate` pass through unchanged (useful when only some types changed between versions).

### Serialization

The ontology config is JSON-serializable when all `migrate` functions are strings (or omitted). When they're real functions, the consumer handles serialization — e.g., calling `fn.toString()` per entry before storing and reconstructing with `new Function()` or DWL on retrieval. In Nebula's case, the vibe coding IDE (Phase 9) captures migrations as strings from the start.

## Open Questions

### Migration Chaining

- **Multi-step migration**: If data is at v1 and the latest is v4, does the ontology chain v1→v2→v3→v4 migrations, or does each version only know how to migrate from its immediate predecessor? Chaining is more flexible (each migration is simpler) but slower for large jumps.

### Defaults vs Migration Overlap

- For a new required field, `defaults` and `migrate` do the same thing (set the value). Should `defaults` auto-generate a migration if none is provided? Or keep them independent?

### Lazy Migration Timing

- Migrations happen lazily — only when a client requests a version of a resource that hasn't been migrated yet. This keeps the DWL overhead acceptable (infrequent, on-demand).
- Should migrated resources be written back to storage immediately, or cached in memory until the next write?

### DWL Execution

- Migration functions run vibe-coder-provided transform code → DWL isolation required.
- The `query` parameter for cross-resource migrations: how does this cross the DWL boundary? The consumer (Nebula) would need to inject a query proxy that the DWL isolate can call.

## Success Criteria

- [ ] `migrate` is per-type (object in, object out); each entry accepts function or string; `ontology.getMigration(version, typeName)` retrieves either form
- [ ] Types not listed in `migrate` pass through unchanged
- [ ] First version has no `migrate` (no predecessor)
- [ ] Migration chaining v1→v2→...→vN works correctly
- [ ] Lazy migration: resources migrated on first read at new version
- [ ] DWL sandbox for string-form migration functions
- [ ] Cross-resource migrations via `query` parameter work through DWL boundary
- [ ] Ontology config is JSON-serializable when `migrate` is a string or omitted
- [ ] Migration errors are surfaced with clear messages (which version, which type, what failed)
