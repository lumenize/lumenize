# Phase 5.2.3: Resources Validation Integration

**Status**: Pending
**App**: `apps/nebula/`
**Depends on**: Phase 5.2.2 (`validate()`)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`
**ADR**: `docs/adr/001-typescript-as-schema.md`

## Goal

Wire the `validate()` function (Phase 5.2.2) into the Resources `transaction()` flow so that every resource write is validated against its TypeScript type definition before committing. Build the `Ontology` class that manages versioned type definitions, auto-extracts relationships from the TypeScript AST, and delegates validation to the pure `validate()` function.

## Why In-Process, Not DWL

Schema validation doesn't execute user code. The inputs are:
1. A TypeScript type definition string — data that tsc parses
2. A JS value serialized to a TS program by `toTypeScript()` — also data
3. The tsc compiler itself — trusted npm package

Since there's no untrusted code execution, DWL isolation is unnecessary. Running in-process keeps the entire transaction synchronous — no input gates, no interleaving, no double eTag check needed. Phase 5.1's fully synchronous `transaction()` stays fully synchronous.

DWL **is** needed for schema migrations (Phase 5.5/6) because migrations run vibe-coder-provided transform code. But migrations happen lazily and infrequently (only when a client requests a version of a resource that hasn't been migrated yet), so the DWL overhead is acceptable there.

| Concern | Validation (this phase) | Migration (Phase 5.5/6) |
|---------|------------------------|------------------------|
| Frequency | Every create/update | Lazy, on-demand |
| User code? | No — tsc parses type definitions | Yes — transform functions |
| Isolation needed? | No | Yes (DWL) |
| Sync/Async | Synchronous | Async (DWL call) |

## Ontology Class

The `Ontology` class wraps the pure `validate()` function with a type registry, versioning, and auto-extracted relationship metadata. It lives in `apps/nebula/` — not in a published package.

### Config Format

The ontology is a **versioned array** — each entry is a complete snapshot of the types for that version. Array position determines ordering (for migration purposes). The version label is user-defined.

```typescript
const ontology = new Ontology([
  {
    version: 'v1',
    types: `
      interface Todo { title: string; done: boolean; assignedTo: Person[]; }
      interface Person { name: string; email: string; }
    `,
  },
  {
    version: 'v2',
    types: `
      interface Todo { title: string; done: boolean; assignedTo: Person[]; priority: 'low' | 'medium' | 'high'; }
      interface Person { name: string; email: string; phone?: string; }
    `,
    defaults: {
      Todo: { priority: 'medium' },
    },
    migrate: {  // Placeholder - Not implementing until phase 5.5
      Todo: (data) => ({ ...data, priority: 'medium' }),
      // Person: no migration needed (phone is optional)
    },
  },
]);
```

#### `defaults`

Applied before validation when creating a new resource at this version. If the client omits `priority`, the ontology fills in `'medium'`, then validation checks the complete object. TypeScript interfaces have no default value syntax, so this lives alongside the types.

Defaults are create-only — updates should be explicit. Client-provided values override defaults (spread order).

**Future possibility**: JSDoc `@default` tags in the type definitions (`/** @default 'medium' */ priority: ...`). tsc's AST exposes these via `ts.getJSDocTags()`, and we're already walking the AST for relationship extraction. Would keep defaults co-located with types. JSON-parseable values only.

#### `migrate` — placeholder for Phase 5.5

The signature will likely change. For now, ontology should accept a `migrate` property. See Phase 5.5 for current thinking.

### Auto-Extracted Relationships from TypeScript Types

Relationships are **not** declared separately — they're inferred by parsing the TypeScript AST. When a property's type references another interface defined in the same ontology, it's a relationship:

```typescript
interface Todo {
  title: string;           // primitive → regular field
  done: boolean;           // primitive → regular field
  assignedTo: Person[];    // ontology type[] → "many" relationship
  owner: Person;           // ontology type → "one" relationship
  reviewer?: Person;       // optional ontology type → optional "one" relationship
}
```

This is the "TypeScript IS the schema" vision taken to its full conclusion — types define both the shape of individual resources AND their relationships. No `relationships` config to keep in sync with the types.

`ts.createSourceFile()` gives us the AST (fast parse, no type-checking needed). Walk `InterfaceDeclaration` → `PropertySignature` → check if the type references another interface in the ontology:

| Type in TypeScript | Inferred Relationship |
|---|---|
| `Person` | one (required) |
| `Person?` or `Person \| null` | one (optional) |
| `Person[]` or `Array<Person>` | many |
| `string`, `number`, etc. | regular field (not a relationship) |

This parsing happens once when the ontology is constructed, not on every validate call.

### Write-Shape Type Generation

The read types describe the resolved shape (`assignedTo: Person[]`), but at write time the client sends IDs (`assignedTo: string[]`). The Ontology auto-generates **write-shape type definitions** by substituting relationship references with their ID types:

| Read Type | Write Type |
|-----------|------------|
| `owner: Person` | `owner: string` |
| `reviewer?: Person` | `reviewer?: string` |
| `assignedTo: Person[]` | `assignedTo: string[]` |

This is a natural byproduct of the AST walk — the Ontology already knows which fields are relationships. It generates the write-shape type definitions once (alongside relationship extraction) and passes them to the pure `validate()` function at validation time. The vibe coder only writes the read types; write types are derived automatically.

### Ontology API

```typescript
// Validate a value against a registered type (delegates to validate())
const result = ontology.validate({ title: "Fix bug", done: false }, 'Todo');
// { valid: true }

// Validate against a specific version
const result = ontology.validate(value, 'Todo', { version: 'v1' });

// Query auto-extracted relationship metadata (consumed by Phase 5.2.5's query engine)
const rel = ontology.getRelationship('Todo', 'assignedTo');
// { target: 'Person', cardinality: 'many', optional: false }

// Get defaults for a type (used before validation on create)
const defaults = ontology.getDefaults('Todo');
// { priority: 'medium' }
```

`ontology.validate()` is sugar over the pure `validate()` function — it looks up the type definitions from its registry and delegates.

## Transaction Protocol (Unchanged from Phase 5.1)

Because validation is synchronous, the transaction flow stays exactly as Phase 5.1 implemented it:

1. Read current snapshots (for `validFrom` calculation)
2. Calculate `validFrom`, generate `eTag`, build `changedBy`
3. Validate operations, check permissions, check eTags
4. **Apply defaults (create only) and validate each resource value** — synchronous, ~1ms
   - If any validation fails, return error immediately (no write)
5. `transactionSync`:
   - Read current snapshots (authoritative)
   - Re-validate, re-check permissions, re-check eTags
   - Write all changes atomically

No new `await`, no input gate, no interleaving risk.

## Design

### Ontology in Star

The Star instantiates the `Ontology` class:

```typescript
// Star holds an Ontology instance, rebuilt from storage on init
#ontology: Ontology | null = null;

get #currentOntology(): Ontology {
  if (!this.#ontology) {
    const stored = this.ctx.storage.sql.exec('SELECT ...').one();
    this.#ontology = new Ontology(stored);
  }
  return this.#ontology;
}
```

The `Ontology` instance is an ephemeral cache — storage is the source of truth (per DO conventions). On eviction, it's rebuilt from SQLite on next access.

### Setting the Ontology

The ontology is set by the vibe coder via the IDE (Phase 9) or admin API:

```typescript
// Star method (admin-gated)
setOntology(ontology: { types: string; resources: Record<string, ResourceConfig> }) {
  // Store in SQLite
  // Reset cached Ontology instance
  this.#ontology = null;
}
```

### Defaults and Validation Call Site

Inside the transaction flow, defaults are applied (on `create` only), then validation runs. Both are synchronous:

```typescript
// Step 4: apply defaults and validate each resource
for (const op of operations) {
  if (op.type === 'create') {
    // Apply defaults from ontology config before validation
    const defaults = this.#currentOntology.getDefaults(op.typeName);
    if (defaults) {
      op.value = { ...defaults, ...op.value };  // client values win
    }
  }
  if (op.type === 'create' || op.type === 'update') {
    const result = this.#currentOntology.validate(op.value, op.typeName);
    if (!result.valid) {
      return { ok: false, validationErrors: { [op.resourceId]: result } };
    }
  }
}
```

### Resource Type Tracking

Resources need a `typeName` (and eventually `version` for Phase 5.5). Two options:

**Option A: Type name per resource** — Each resource row stores its `typeName`. The `create` operation requires it; subsequent operations inherit it.

**Option B: Type name per DAG node** — The DAG node determines the type. All resources under a "Todos" node are `Todo` type. Simpler for the vibe coder but less flexible.

This is an open question. Option A is more general; Option B matches the vibe coder mental model better.

### Error Handling

When validation fails, `transaction()` returns a structured error:

```typescript
{
  ok: false,
  validationErrors: {
    'resource-uuid-1': {
      typeName: 'Todo',
      errors: [
        { message: "Type 'number' is not assignable to type 'string'", property: 'title' }
      ]
    }
  }
}
```

The client receives tsc-quality error messages. The vibe coding IDE (Phase 9) can display these inline.

## Open Questions

### Validation

- **Validation on `create` vs `update`**: Should `update` operations re-validate the full merged object (existing + patch), or only the changed fields? Full validation is safer. Partial validation is faster and allows adding required fields with defaults in migrations.
- **`delete` validation**: Delete operations don't have a value to validate. Skip validation for deletes.
- **`move` validation**: Moving a resource to a different DAG node — if type is per-node (Option B above), does moving change the expected type? This would be weird. Leans toward Option A.
- **Validation bypass**: Should admin operations have a way to bypass validation? Useful for data repair. Dangerous for data integrity. Probably not — if the data is broken, fix the type definition.
- **Bundle size impact**: The tsc bundle (3.4 MB) is now part of the Star's Worker bundle rather than a separate DWL module. Workers paid plan allows 10 MB compressed. Need to verify the total bundle stays under the limit.
- **Memory**: tsc uses ~40-50 MB per call in the Star's 128 MB isolate. The spike showed this is fine with ~78 MB headroom. Monitor in production.

### Relationship ID Validation

tsc validates the write shape (reference fields as `string`/`string[]`), but can't check that IDs point to real resources. That's a storage-layer concern — does `"person-uuid-1"` actually exist as a Person? Options:
- **Validate on write**: Look up each referenced ID in SQLite. Prevents dangling references. Potentially expensive for large `string[]` fields.
- **Validate on read (lazy)**: Accept any string at write time, fail gracefully when resolving relationships in Phase 5.2.5 queries. Simpler, but allows bad data in.
- **Validate on write for `one`, skip for `many`**: Compromise — single-reference fields are cheap to check, arrays can wait.

### Relationship Storage Model

The TypeScript types describe rich object graphs (`assignedTo: Person[]`), but the storage layer needs a concrete strategy for relationship data. Key insight: the Snodgrass-style temporal model (shared `validFrom` per transaction) doesn't inherently favor embedded arrays — a temporal junction table with the same `validFrom`/`validTo` columns gives identical point-in-time query consistency.

**Embedded arrays** (store `assignedTo: ["person-uuid-1", "person-uuid-2"]` in the resource JSON):
- ✅ Self-contained — no joins needed to reconstruct the resource
- ✅ Single row update within `transactionSync`
- ❌ Inverse queries require scanning all resources of that type
- ❌ Large arrays bloat the JSON blob
- ❌ No referential integrity

**Temporal junction tables** (`TodoAssignees(todoId, personId, validFrom, validTo)`):
- ✅ Efficient inverse queries via index — "find all Todos assigned to person-uuid-1" is a simple indexed lookup
- ✅ Point-in-time consistency — same `validFrom` as the parent resource write, so `WHERE validFrom <= T < validTo` gives correct results at any moment in time
- ✅ Referential integrity possible via foreign keys
- ✅ Relationship changes are fine-grained (add/remove one assignee without rewriting the whole array)
- ⚠️ More rows to write per transaction (one per relationship edge)
- ⚠️ The ontology must auto-manage these tables (create, index) based on AST-extracted relationships

**Hybrid** (embedded array as source of truth + derived index for inverse lookups):
- Middle ground, but may be unnecessary if temporal junction tables handle both directions well

The temporal junction table approach is appealing because the ontology already knows the relationships from the AST — it could auto-create and auto-maintain the junction tables transparently. Phase 5.2.5's query engine would use them for relationship resolution in both directions. Decision deferred to implementation time, but the write-shape type generation (relationship refs → `string`/`string[]`) works with any approach.

#### ORM Prior Art

**Prisma** is the closest analog to our "TypeScript IS the schema" approach. Its schema language infers junction tables from array relations (`assignedTo Person[]`), auto-creates a `_PersonToTodo` junction table, and the client sends/receives arrays — the developer never touches the junction table. This maps well to what we'd do: the TypeScript interface declares the relationship, the Ontology infers the storage strategy, the vibe coder works with arrays on the wire.

Drizzle (explicit junction tables + relations config) and TypeORM (decorators + auto-managed junction) are more verbose. Django's `ManyToManyField` is worth noting for its `.set([id1, id2])` semantics — it diffs the current state and issues minimal inserts/deletes.

Our key difference from all of these: **temporality answers the diff-vs-replace question**. Traditional ORMs must choose between full replacement (DELETE all + INSERT new) and diffing (compare old/new sets, issue targeted INSERT/DELETE). Both have tradeoffs — full replacement is simpler but wasteful, diffing is efficient but complex. With temporal junction tables, neither problem exists: close out `validTo` on all current edges, insert new rows with the transaction's `validFrom`. The old edges aren't deleted — they become history. No diffing needed, no data loss, and the temporal record naturally captures exactly what changed and when.

#### Wire Format Translation

The vibe coder's wire format stays natural — `assignedTo: ["person-uuid-1", "person-uuid-2"]`. The translation is internal to the transaction flow:

1. **On write**: Accept `assignedTo: string[]` on the wire → validate against write-shape types (tsc checks `string[]`) → decompose into junction table rows (close old edges, insert new)
2. **On read**: Query junction table for current edges (`validTo = END_OF_TIME`) → recompose into `assignedTo: string[]` (or resolve to `Person[]` for nested reads in Phase 5.2.5)

The vibe coder never sees junction tables. The Ontology knows which fields are relationships (from the AST), so it knows which fields to decompose/recompose.

### AST Parsing Edge Cases

- **`Record<string, Person>`** — is this a relationship? Probably: a map of Persons keyed by string.
- **`Map<string, Person>`** — same question for Map types.
- **Union types**: `Person | Company` — polymorphic relationship. What's the cardinality?
- **Nested arrays**: `Person[][]` — likely an error, not a valid relationship.
- **Circular references**: `interface TreeNode { children: TreeNode[] }` — self-referential. Valid but needs care in query resolution.
- **Type aliases**: `type Assignees = Person[]` then `assignedTo: Assignees` — the parser needs to resolve aliases.

Start with the simple cases (`T` and `T[]`) and expand from there.

### Versioning

- **Complete snapshots vs incremental deltas**: The versioned array uses complete snapshots (each version has all types). This is explicit and avoids delta-composition complexity, but means larger ontology configs. Is this a problem in practice? Probably not — type definitions are small.
- **Version ordering**: Array position is the canonical ordering for migration purposes. Is this sufficient, or do we need explicit ordering metadata?
- **Default version**: `validate(value, typeName)` without a version uses the latest (last in array). Is this always the right default?
- **Defaults applied when?**: Before validation only on `create`, or also on `update` when a field is missing? Probably create-only — updates should be explicit.
- Migration-related open questions (chaining, defaults overlap) are in Phase 5.5 (`tasks/nebula-5.5-schema-evolution.md`).

## Success Criteria

- [ ] `Ontology` class with versioned array config, type registry, and `validate()` delegation
- [ ] `ontology.validate()` delegates to the pure `validate()` function from Phase 5.2.2
- [ ] Relationships auto-extracted from TypeScript AST (`T` → one, `T[]` → many, `T?` → optional one)
- [ ] `ontology.getRelationship()` returns extracted relationship metadata for query resolution
- [ ] Write-shape type definitions auto-generated from AST (relationship refs → `string`/`string[]`)
- [ ] `defaults` from ontology config applied before validation on `create` (client values override)
- [ ] `defaults` not applied on `update` (updates are explicit)
- [ ] `migrate` property accepted in ontology config (placeholder — execution deferred to Phase 5.5)
- [ ] `transaction()` validates each resource value against its TypeScript type before writing — synchronously, in-process
- [ ] Validation errors prevent the write and return structured error messages
- [ ] Transaction remains fully synchronous (no new `await`, no interleaving risk)
- [ ] Ontology stored in Star's SQLite and cached as `Ontology` instance
- [ ] Resource type tracking (typeName per resource or per node — decision made)
- [ ] `create` operations require a valid typeName
- [ ] `delete` operations skip validation
- [ ] Warm validation latency ~1ms (matching spike results)
- [ ] All existing Phase 5.1 tests continue passing (no behavioral change for untyped resources during migration)
- [ ] New tests: valid data passes, invalid data rejected with clear errors, cycle/alias validation works
- [ ] Test coverage: >80% branch, >90% statement
