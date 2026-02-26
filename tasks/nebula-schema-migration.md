# Phase 6: Resources — Schema Migration

**Status**: Pending
**Package**: `@lumenize/nebula`
**Depends on**: Phase 5 (Resources — Basic Functionality)
**Master task file**: `tasks/nebula.md`

## Goal

Add schema evolution and migration to the Resources engine. User-provided migration functions run in DWL isolates, versioned alongside resource config. TypeScript types are the schema — no DSL. Schema validation via `tsc`/`tsgo` in Containers (informed by Phase 4 isolation research).

This phase builds on the basic Resources functionality from Phase 5 and adds the versioning, migration, and runtime type validation layers.

## Scope (Split From nebula-resources.md)

The existing `tasks/nebula-resources.md` covers the full Resources system. This phase specifically handles:

- **Schema versioning**: Track version per resource type in `ResourcesWorker`
- **Migration functions**: User-provided `migrations` object with version → transform function mapping
- **Lazy read-time migration**: On read, if stored version < current version, run migration chain and write-back
- **Runtime type validation**: `tsc`/`tsgo` in Containers validates values against TypeScript type definitions (experiment from Phase 4 research)
- **Migration error handling**: Rollback, quarantine, or error strategies
- **Code versioning integration**: When DWL code updates, detect version changes and trigger migration awareness

## Key Design From nebula-resources.md

```typescript
export class ProjectResources extends ResourcesWorker {
  version = 3;

  migrations = {
    // version 1→2: added status field with default
    2: (old) => ({ ...old, status: 'draft' }),
    // version 2→3: renamed owner→assignee
    3: (old) => ({ ...old, assignee: old.owner, owner: undefined }),
  };

  resources = { /* ... */ };
}
```

## Open Design Questions (Carried From nebula-resources.md)

- Per-resource-type versioning or global version for all resource types?
- Lazy migration on read vs eager migration on code deploy?
- Migration failure handling — rollback, quarantine, or error?
- Can migrations be validated via the `tsgo` Container experiment?
- How does the migration chain interact with the temporal storage model (snapshots at different schema versions)?

## Success Criteria

- [ ] Schema version tracked per resource type in storage
- [ ] Migration chain executes lazily on read (stored version < current)
- [ ] Write-back after migration (so it only migrates once)
- [ ] Migration functions run in DWL sandbox (same isolation as guards)
- [ ] Migration failure handling defined and tested
- [ ] Runtime type validation via Containers (if Phase 4 research confirms viability)
- [ ] Integration with temporal storage (migrating historical snapshots)
