# Phase 5.2.3: Resources Validation Integration

**Status**: Complete
**App**: `apps/nebula/`
**Depends on**: Phase 5.2.2 (`validate()`) — Complete (commit 817e8a8)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`
**ADR**: `docs/adr/001-typescript-as-schema.md`

## Work Split

This task was split into two parts due to size:

### Part A — Pure Logic + Resources (Complete)
- `extractTypeMetadata()` in `packages/ts-runtime-validator/src/extract-type-metadata.ts` — AST walk for relationship extraction + write-shape generation
- `Ontology` class at `apps/nebula/src/ontology.ts` — versioned type registry wrapping validate() and extractTypeMetadata()
- Renamed `op: 'update'` → `op: 'put'` across codebase
- Added `typeName` to create variant of `OperationDescriptor`
- Added `typeName TEXT NOT NULL` and `ontologyVersion TEXT NOT NULL` to Snapshots table + `SnapshotMeta`
- `TransactionResult` / `TransactionError` discriminated union type change
- Step 5 validation integration in `Resources.transaction()` (optional `ontology` param — required in Part B)
- `#calculateValidFrom()` design rationale comment
- Export updates: `TransactionError`, `OntologyVersionConfig` types; `extractTypeMetadata`, `TypeMetadata`, `Relationship` from ts-runtime-validator
- 39 new tests (18 extractTypeMetadata + 21 Ontology), all existing tests updated and passing (309 total)

### Part B — Distributed Wiring (Complete)
- Added `nodejs_compat_v2` to `compatibility_flags` in both test wrangler.jsonc files
- **typescript bundling**: `nodejs_compat_v2` alone was insufficient — vitest-pool-workers can't resolve `node:os` for the raw `typescript` package even with the compat flag. Fixed by pre-bundling typescript with esbuild (`--platform=node` + alias stubs for `node:os`/`node:inspector`). Bundle script at `packages/ts-runtime-validator/scripts/bundle-tsc.mjs`, runs via `postinstall`. Both `engine.ts` and `extract-type-metadata.ts` import from `../dist/typescript.bundled.mjs`.
- Re-exported `Ontology` from `apps/nebula/src/index.ts`
- **Ontology unit tests stayed in ts-runtime-validator** (`test/ontology.test.ts`) with relative imports to `apps/nebula/src/ontology.ts`. Moving them to the nebula workers pool would require the full typescript runtime, which even bundled has issues with workerd's `__filename` handling. The tests are pure (no DO bindings needed) so this is fine.
- Galaxy `appendOntologyVersion()` / `getOntology()` methods
- Star continuation pattern (Handler 1 / Handler 2, removed `resources()` mesh method, added `star.transaction(ontologyVersion, ops)` and `star.read(ontologyVersion, resourceId)`)
- `NebulaClient` `handleTransactionResult` / `handleReadResult` mesh methods (warn by default)
- Replaced `callStarResourcesTransaction`/`callStarResourcesRead` with fire-and-forget `callStarTransaction`/`callStarRead`
- Full integration tests in `star-ontology.test.ts` (17 tests: Galaxy management, cache hit/miss, version mismatch, validation, defaults, reads)
- Made `ontology` required on `Resources.transaction()`, added null guards before validation
- **Handler error delivery**: `doTransaction` and `doRead` wrapped in try/catch — fire-and-forget pattern requires explicit error delivery since uncaught exceptions are silently lost (unlike response-handler pattern which auto-captures them)
- **Deferred**: Pre-existing TypeScript type errors across monorepo (~21 errors) — not addressed in this phase
- **Test results**: 107 baseline tests (90 existing + 17 new), 3 unit tests, 227 ts-runtime-validator tests (216 existing + 9 new Map validation + 1 skipped + 1 ontology)

## Goal

Wire the `validate()` function (Phase 5.2.2) into the Resources `transaction()` flow so that every resource write is validated against its TypeScript type definition before committing. Build the `Ontology` class that manages versioned type definitions, auto-extracts relationships from the TypeScript AST, and delegates validation to the pure `validate()` function. Establish the Galaxy as the ontology source of truth with append-only versioning, and implement the continuation-based pattern for Stars to lazily fetch ontology versions from Galaxy on cache miss.

## Why In-Process, Not DWL

Validation runs synchronously in-process — no DWL isolation needed because tsc parses type definitions as data, not user code. This keeps the entire transaction synchronous (no input gates, no interleaving). See Phase 5.2.2 task doc and ADR-001 for the full rationale.

DWL **is** needed for schema migrations (Phase 5.5/6) because migrations run vibe-coder-provided transform code.

## Ontology Class

The `Ontology` class wraps the pure `validate(value, typeName, typeDefinitions)` function (from `@lumenize/ts-runtime-validator`) with a type registry, versioning, and auto-extracted relationship metadata. It lives at `apps/nebula/src/ontology.ts` — not in a published package.

### Types

```typescript
interface OntologyVersionConfig {
  version: string;                                  // User-defined label, e.g., 'v1'
  types: string;                                    // TypeScript interface definitions
  defaults?: Record<string, Record<string, any>>;   // typeName → fieldName → defaultValue
  migrate?: Record<string, string>;                  // Placeholder for Phase 5.5 — function body as string, run in DWL
}

interface TypeMetadata {
  /** typeName → fieldName → Relationship */
  relationships: Record<string, Record<string, Relationship>>;
  /** All interfaces with relationship refs replaced with string/string[].
   *  Passed as the `typeDefinitions` parameter to validate(). */
  writeShapeTypeDefinitions: string;
}

interface Relationship {
  target: string;        // Referenced type name
  cardinality: 'one' | 'many';
  optional: boolean;
}
```

### Config Format

The ontology is a **versioned, append-only array** — each entry is a complete snapshot of the types for that version. Array position determines ordering (for migration purposes). The version label is user-defined. Versions are immutable once appended — to change anything, append a new version.

```typescript
// Galaxy — versions are appended one at a time via admin API
await galaxy.appendOntologyVersion({
  version: 'v1',
  types: `
    interface Todo { title: string; done: boolean; assignedTo: Person[]; }
    interface Person { name: string; email: string; }
  `,
});

await galaxy.appendOntologyVersion({
  version: 'v2',
  types: `
    interface Todo { title: string; done: boolean; assignedTo: Person[]; priority: 'low' | 'medium' | 'high'; }
    interface Person { name: string; email: string; phone?: string; }
  `,
  defaults: {
    Todo: { priority: 'medium' },
  },
  migrate: {  // Placeholder - Not implementing until phase 5.5
    Todo: `(data) => ({ ...data, priority: 'medium' })`,
    // Person: no migration needed (phone is optional)
  },
});

// Ontology class constructed from the full array (internally, by Star)
const ontology = new Ontology([v1Config, v2Config]);
```

#### `defaults`

Applied before validation when creating a new resource at this version. If the client omits `priority`, the ontology fills in `'medium'`, then validation checks the complete object. TypeScript interfaces have no default value syntax, so this lives alongside the types.

Defaults are create-only — updates should be explicit. Client-provided values override defaults (spread order).

**Future possibility**: JSDoc `@default` tags in the type definitions (`/** @default 'medium' */ priority: ...`). tsc's AST exposes these via `ts.getJSDocTags()`, and we're already walking the AST for relationship extraction. Would keep defaults co-located with types. JSON-parseable values only.

#### `migrate` — placeholder for Phase 5.5

Migration functions are stored as strings (not live functions) because they must survive structured-clone serialization through Galaxy→Star KV storage and continuation roundtrips. Phase 5.5 will execute them in DWL (Cloudflare Worker Loader) isolates. The signature details will likely evolve. For now, ontology should accept a `migrate` property with string values. See Phase 5.5 for current thinking.

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

The AST parsing for relationship extraction and write-shape generation uses `ts.createSourceFile()` (fast parse, no type-checking needed). This logic lives in `@lumenize/ts-runtime-validator` as an exported `extractTypeMetadata(typeDefinitions)` function at `packages/ts-runtime-validator/src/extract-type-metadata.ts`, re-exported from `src/index.ts`. The package already depends on `typescript`, and type metadata extraction is a natural companion to validation (both parse type definitions). The Ontology calls this function rather than importing `typescript` directly.

**New file and export**: This task adds `packages/ts-runtime-validator/src/extract-type-metadata.ts` and re-exports `extractTypeMetadata` and `TypeMetadata` from `packages/ts-runtime-validator/src/index.ts`. The `Relationship` type is also re-exported (the Ontology class needs it for its own API).

**Two functions, not one class**: `extractTypeMetadata()` and `validate()` serve different purposes at different times. `extractTypeMetadata()` is called **once** per ontology version at construction time (AST parse, ~0ms). `validate()` is called **per-transaction** at validation time (full tsc type-check, ~1ms). They don't share mutable state and their inputs differ — no class needed. The `Ontology` class in `apps/nebula/` is the coordinator that calls both at the appropriate times.

`extractTypeMetadata()` performs a single AST walk and returns both outputs as a `TypeMetadata` object (see Types above).

The AST walk visits `InterfaceDeclaration` → `PropertySignature` → checks if the type references another interface in the type definitions. When it finds a relationship reference, it simultaneously records the relationship metadata AND substitutes the reference with `string`/`string[]` in the output type definitions string:

| Type in TypeScript | Inferred Relationship |
|---|---|
| `Person` | one (required) |
| `Person?` or `Person \| null` | one (optional) |
| `Person[]` or `Array<Person>` | many |
| `string`, `number`, etc. | regular field (not a relationship) |

This parsing happens once when the ontology is constructed, not on every validate call.

### Write-Shape Type Generation

The read types describe the resolved shape (`assignedTo: Person[]`), but at write time the client sends IDs (`assignedTo: string[]`). `extractTypeMetadata()` auto-generates **write-shape type definitions** by substituting relationship references with their ID types during the same AST walk that extracts relationships:

| Read Type | Write Type |
|-----------|------------|
| `owner: Person` | `owner: string` |
| `reviewer?: Person` | `reviewer?: string` |
| `assignedTo: Person[]` | `assignedTo: string[]` |

The write-shape `typeDefinitions` string is returned as `TypeMetadata.writeShapeTypeDefinitions` and is what gets passed to the pure `validate()` function at validation time — not the original read-shape types.

Example: given read types `interface Todo { title: string; assignedTo: Person[]; }`, `extractTypeMetadata()` returns write types `interface Todo { title: string; assignedTo: string[]; }`. When validating `{ title: "Fix bug", assignedTo: ["person-uuid-1"] }`, the Ontology calls:

```typescript
validate(value, 'Todo', writeShapeTypeDefinitions)
```

where `writeShapeTypeDefinitions` contains all interfaces for the version with relationship refs replaced by `string`/`string[]`. All types must be present in the string because tsc needs to resolve cross-type references.

The vibe coder only writes the read types; write types are derived automatically.

**All interfaces are preserved in write-shape output**, even types whose only references were replaced with `string` (e.g., `Person` after `assignedTo: Person[]` → `assignedTo: string[]`). This is intentional: any type in the ontology can be a standalone resource type. When the user calls `ontology.validate(personData, 'Person')`, tsc needs the `Person` interface in the write-shape string. Pruning "unused" types would break validation of resources of that type. The overhead of tsc parsing a few extra unused interfaces is negligible.

### Ontology API

```typescript
class Ontology {
  constructor(versions: OntologyVersionConfig[]);

  /** Latest version label from the versioned array */
  get latestVersion(): string;

  /** Validate value against typeName using the latest version's write-shape type definitions.
   *  Internally calls validate(value, typeName, writeShapeTypeDefinitions) from @lumenize/ts-runtime-validator. */
  validate(value: unknown, typeName: string): ValidationResult;

  /** Get defaults for a type at the latest version (null if no defaults) */
  getDefaults(typeName: string): Record<string, any> | null;

  /** Get auto-extracted relationship metadata for query resolution */
  getRelationship(typeName: string, fieldName: string): Relationship | null;
}
```

Usage:

```typescript
const result = ontology.validate({ title: "Fix bug", done: false }, 'Todo');
// { valid: true }

const version = ontology.latestVersion;
// 'v2'

const rel = ontology.getRelationship('Todo', 'assignedTo');
// { target: 'Person', cardinality: 'many', optional: false }

const defaults = ontology.getDefaults('Todo');
// { priority: 'medium' }
```

`ontology.validate()` delegates to the pure `validate(value, typeName, writeShapeTypeDefinitions)` function from `@lumenize/ts-runtime-validator`, using the latest version's write-shape type definitions (see Write-Shape Type Generation above). There is no version parameter on the `Ontology` class — validation always runs against the latest version. Version coordination (ensuring the client's declared `ontologyVersion` matches the Star's latest) happens at the Star level before `Resources.transaction()` is called.

Version-aware validation (e.g., "resource at v2, latest is v4 → migrate then validate against v4") is deferred to Phase 5.5.

## Transaction Integration

### Rename: `update` → `put`

The current code uses `op: 'update'` for full-value replacement operations. This task renames it to `op: 'put'` across the codebase — in `OperationDescriptor`, `#writeSnapshot` switch cases, Step 7 validation logic, Step 8 permission checks, error messages (e.g., `"use update instead"` → `"use put instead"`), and all existing tests. The operation is a full replacement (like HTTP PUT) — the caller sends the complete value, not a partial patch. Naming it `put` makes the semantics explicit and reserves `patch` for a future partial-update operation with merge-then-validate semantics. Note: Step 8's permission check switch has `case 'update':` which needs renaming to `case 'put':` (`case 'delete':` stays as-is — only `update` is being renamed). Since Resources has never been released, this is a straight rename with no backward compatibility concerns.

### Where Validation Runs

Validation runs **before** `transactionSync()` — between Step 4 (build changedBy) and the `transactionSync()` call in `resources.ts`. This task inserts a new Step 5 before `transactionSync()` and renumbers the wrapping comment.

**Canonical step numbering after this task** (single source of truth — all code comments and references must match):

| Step | Location | Description |
|------|----------|-------------|
| 1 | Before transactionSync | Read current snapshots (for validFrom calculation) |
| 2 | Before transactionSync | Calculate single validFrom |
| 3 | Before transactionSync | Generate single eTag |
| 4 | Before transactionSync | Build changedBy from callContext |
| **5** | **Before transactionSync (NEW)** | **Apply defaults (create only) + validate ALL values against ontology. Return early if any fail.** |
| 6 | Inside transactionSync | Re-read snapshots (authoritative for eTag checking) |
| 7 | Inside transactionSync | Validate operations (exists checks, null checks) |
| 8 | Inside transactionSync | Permission checks |
| 9 | Inside transactionSync | Check eTags — conflicts produce `{ ok: false }` |
| 10 | Inside transactionSync | Write all changes |

The current code's wrapping comment `// Step 5–11: Atomic transaction` becomes `// Steps 6–10: Atomic transaction`. (The old "5–11" label was already inaccurate — only steps 6–10 exist inside the transaction block.)

Step 5 applies defaults, validates values against the ontology, and returns early if anything fails — `transactionSync()` is never entered. The `transactionSync()` body (Steps 6-10) is mostly unchanged — it still re-reads snapshots, re-validates operations, re-checks permissions, re-checks eTags, writes atomically, and calls `#onChanged()`. The only change inside `transactionSync()` is updating the eTag conflict code to use the new `TransactionError` shape (see `TransactionResult` Type Change below).

Because validation is synchronous (~1ms per call), no new `await` is introduced. No input gate, no interleaving risk.

**Note on `Date.now()` in Resources**: `#calculateValidFrom()` uses `Date.now()` as the starting timestamp, then checks all resources in the batch — if `Date.now()` is `<=` any existing snapshot's `validFrom`, it advances to `prev + 1`. This is intentional and correct for Cloudflare Workers where the clock doesn't advance during synchronous execution: for a multi-resource transaction, the result is always at least 1ms above the highest existing `validFrom` across all resources. Add a code comment explaining this design rationale when touching `#calculateValidFrom()`.

### Defaults and Validation Call Site

Inside `Resources.transaction()`, Step 5 (after build changedBy, before `transactionSync()`). The `Ontology` instance is passed in by the Star (see Design section). All resources are validated — errors are collected across the entire batch, not failed fast on the first invalid one, so the caller sees all problems at once:

```typescript
// Resources.transaction(ops, ontology) — ontology passed by Star
// Step 5: Apply defaults and validate each resource value
// (entries = Object.entries(ops), already declared above Step 1)
const validationErrors: Record<string, TransactionError> = {};
for (const [resourceId, op] of entries) {
  if (op.op === 'create') {
    const typeName = op.typeName;
    const defaults = ontology.getDefaults(typeName);
    if (defaults) {
      op.value = { ...defaults, ...op.value };  // client values win
    }
    const result = ontology.validate(op.value, typeName);
    if (!result.valid) {
      validationErrors[resourceId] = { type: 'validation', errors: result.errors };
    }
  } else if (op.op === 'put') {
    const current = currentSnapshots.get(resourceId);
    if (!current) continue;  // Step 7 inside transactionSync will catch "not found"
    const typeName = current.meta.typeName;
    const result = ontology.validate(op.value, typeName);
    if (!result.valid) {
      validationErrors[resourceId] = { type: 'validation', errors: result.errors };
    }
  }
  // delete and move — no validation needed
}
if (Object.keys(validationErrors).length > 0) {
  return { ok: false, errors: validationErrors };
}
// Steps 6-10: transactionSync (eTag conflict shape updated, otherwise unchanged)
```

Note: `op.typeName` on `create` requires changes to `OperationDescriptor` — see Resource Type Tracking below. For `put`, the `typeName` is plucked from the Step 1 pre-read snapshot (`currentSnapshots`), which already has `typeName` in its metadata after the Snapshot Schema Changes below. No extra storage read is needed. The `put` path guards against a null pre-read (`continue` to skip validation) — Step 7 inside `transactionSync()` will catch the "Resource not found" error with proper rollback semantics.

### `TransactionResult` Type Change

Since Resources has never been released, replace `conflicts` with a unified `errors` shape. Both eTag conflicts and validation failures are errors — no reason for separate fields.

`TransactionError` is a **discriminated union** — each variant carries only the data relevant to that failure type. The validation variant embeds the raw `ValidationError[]` from `@lumenize/ts-runtime-validator` directly, keeping the full array of tsc findings without flattening:

```typescript
import type { ValidationError } from '@lumenize/ts-runtime-validator';

export type TransactionError =
  | { type: 'conflict'; currentSnapshot: Snapshot }
  | { type: 'validation'; errors: ValidationError[] };

export type TransactionResult =
  | { ok: true;  eTags: Record<string, string> }
  | { ok: false; errors: Record<string, TransactionError> };
```

Keyed by `resourceId`. Each resource has at most **one** `TransactionError` — a resource can't have both a conflict and a validation failure because validation runs before `transactionSync()` and conflicts are detected inside it. Callers discriminate via `error.type`:

```typescript
if (!result.ok) {
  for (const [resourceId, error] of Object.entries(result.errors)) {
    if (error.type === 'validation') {
      // error.errors is ValidationError[] — tsc-quality diagnostics
      for (const ve of error.errors) {
        console.log(`${ve.property ?? '(root)'}: ${ve.message}`);
      }
    } else {
      // error.type === 'conflict' — OCC retry with error.currentSnapshot
    }
  }
}
```

The client receives tsc-quality error messages for validation failures. The vibe coding IDE (Phase 9) can display these inline.

Since Resources has never been released, update the existing eTag conflict code in `transactionSync()` directly. The Step 9 block becomes:

```typescript
// Step 9: Check eTags — conflicts produce { ok: false }
const errors: Record<string, TransactionError> = {};
for (const [resourceId, op] of entries) {
  if (op.op === 'create') continue;
  const current = authoritative.get(resourceId)!;
  if (current.meta.eTag !== (op as any).eTag) {
    errors[resourceId] = { type: 'conflict', currentSnapshot: current };
  }
}

if (Object.keys(errors).length > 0) {
  result = { ok: false, errors };
  return; // Exit transactionSync — nothing written, automatic rollback
}
```

No backward compatibility needed.

### Resource Type Tracking

**Decision: Type name per resource.** Each resource row stores its `typeName` and `ontologyVersion`. `ontologyVersion` is a single version label for the entire ontology (not per-type), because types reference each other (`Todo` has `assignedTo: Person[]`) — versioning them independently would create a combinatorial compatibility nightmare. A single ontology version is a coherent snapshot of the entire schema. This is more general than per-node typing and avoids the awkward question of what happens when a resource moves between nodes. Per-node typing can be layered on top as a convention (enforced by the DAG node's permissions or hooks) without baking it into the storage model.

The `create` variant of `OperationDescriptor` requires a `typeName` field:

```typescript
export type OperationDescriptor =
  | { op: 'create'; nodeId: number; typeName: string; value: any }
  | { op: 'put';    eTag: string; value: any }
  | { op: 'move';   eTag: string; nodeId: number }
  | { op: 'delete'; eTag: string };
```

For `put`, the `typeName` is inherited from the existing resource's stored `typeName`. For `move` and `delete`, no validation runs, so `typeName` isn't needed.

### Snapshot Schema Changes

The Snapshots table needs `typeName` and `ontologyVersion` columns. Since Resources has never been released, simply replace the `CREATE TABLE` statement in `#createSchema()` — no `ALTER TABLE` migration needed. These are stored per-snapshot (not just per-resource) so that the temporal history records what version each write was validated against — critical for Phase 5.5 migrations:

```sql
CREATE TABLE IF NOT EXISTS Snapshots (
  resourceId TEXT NOT NULL,
  nodeId INTEGER NOT NULL,
  typeName TEXT NOT NULL,
  ontologyVersion TEXT NOT NULL,
  validFrom TEXT NOT NULL,
  validTo TEXT NOT NULL DEFAULT '9999-01-01T00:00:00.000Z',
  eTag TEXT NOT NULL,
  changedBy TEXT NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT 0,
  value TEXT NOT NULL,
  PRIMARY KEY (resourceId, validFrom),
  FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)
) WITHOUT ROWID;
```

The `SnapshotMeta` interface gains the corresponding fields:

```typescript
export interface SnapshotMeta {
  nodeId: number;
  typeName: string;
  ontologyVersion: string;
  eTag: string;
  validFrom: string;
  validTo: string;
  changedBy: ActClaim;
  deleted: boolean;
}
```

**`#getCurrentSnapshot()` must also be updated**: The SELECT column list and the `SnapshotMeta` construction in this method must include `typeName` and `ontologyVersion` — it's the sole reader of Snapshots rows.

For this task (5.2.3), `ontologyVersion` is always the latest version label from the ontology. Phase 5.5 will use it to determine which migrations to run on read.

#### Debounce and Type Version Changes

The `#writeSnapshot` debounce path (`UPDATE ... SET ... WHERE resourceId = ? AND validFrom = ?`) overwrites the current snapshot in place when the same actor writes within the debounce window. This UPDATE must also set `typeName` and `ontologyVersion` — the `typeName` won't change (it's fixed per resource), but `ontologyVersion` could differ if the ontology was updated between the original write and the debounce write. This is fine: the debounce overwrites the value, so the `ontologyVersion` should reflect what the new value was validated against. The UPDATE simply includes both columns:

```sql
UPDATE Snapshots
SET nodeId = ?, typeName = ?, ontologyVersion = ?, eTag = ?, changedBy = ?, deleted = ?, value = ?
WHERE resourceId = ? AND validFrom = ?
```

Add specific test cases for debounce + type version tracking (see Testing Strategy).

#### `#writeSnapshot` Signature Change

The current `#writeSnapshot(resourceId, current, op, validFrom, eTag, changedBy)` gains two new parameters: `typeName` and `ontologyVersion`. For `create`, `typeName` comes from `op.typeName`. For `put`/`move`/`delete`, `typeName` comes from the authoritative re-read snapshot (`current!.meta.typeName`). `ontologyVersion` comes from `ontology.latestVersion`, captured before `transactionSync()`:

```typescript
#writeSnapshot(
  resourceId: string,
  current: Snapshot | null,
  op: OperationDescriptor,
  validFrom: string,
  eTag: string,
  changedBy: ActClaim,
  typeName: string,
  ontologyVersion: string,
): void
```

The caller in Step 10 determines `typeName` per-op:

```typescript
const typeName = op.op === 'create'
  ? op.typeName
  : authoritative.get(resourceId)!.meta.typeName;
this.#writeSnapshot(resourceId, current, op, validFrom, eTag, changedBy, typeName, ontologyVersion);
```

## Design

### `ontologyVersion` on Every Operation

Every resource operation (transaction, read, query) requires an `ontologyVersion` parameter from the caller. This solves three problems at once:

1. **Galaxy→Star propagation**: Star lazily pulls from Galaxy only when it sees a version it doesn't have. No polling, no push infrastructure needed. There is a natural staleness window between Galaxy publishing a new version and the first client sending that version to a given Star — during that window, the Star operates against its locally cached latest. This is by design: eventually a refreshed client will send the new version, triggering the Galaxy fetch. Writes validated against the Star's locally cached latest are valid — they were checked against the schema the Star knew about at the time.
2. **Client↔Server coordination**: The client declares which schema it's working against. If the Star's latest version is newer, that's a version mismatch — the client needs to refresh its schema.
3. **Read-time migration** (Phase 5.5): The version tells the Star which schema the client understands, enabling migration of resources written at older versions.

### Append-Only Ontology

Ontology versions are **immutable once published**. The Galaxy enforces this — new versions can only be appended, never modified in place. This is critical because:

- Stars cache ontology versions locally. If a version could be mutated, cached copies would be stale with no way to detect it.
- Resources store their `ontologyVersion` — the type definitions that version references must be stable forever.
- Append-only means: to change anything, publish a new version. Old versions remain valid for resources written against them.

### Galaxy: Ontology Source of Truth

The Galaxy stores the canonical append-only ontology. It has two ontology-specific methods:

```typescript
// Append a new version — validates eagerly, appends to stored array
@mesh(requireAdmin)
appendOntologyVersion(versionConfig: OntologyVersionConfig) {
  const stored = this.ctx.storage.kv.get<OntologyVersionConfig[]>('ontology') ?? [];

  // Duplicate version label check
  if (stored.some(v => v.version === versionConfig.version)) {
    throw new Error(`Ontology version '${versionConfig.version}' already exists — versions are append-only`);
  }

  // Validate eagerly: construct Ontology to catch parse errors in type definitions
  const updated = [...stored, versionConfig];
  new Ontology(updated);

  this.ctx.storage.kv.put('ontology', updated);
}

// Return the full ontology config array — called by Stars on cache miss
@mesh()
getOntology(): OntologyVersionConfig[] {
  return this.ctx.storage.kv.get<OntologyVersionConfig[]>('ontology') ?? [];
}
```

`getOntology()` is not admin-gated — Stars need to call it, and they may not have admin claims. `appendOntologyVersion()` is admin-gated since it mutates the schema.

**Why the full array**: `getOntology()` returns the complete ontology array, not a delta. This is intentional: (1) version labels are arbitrary user-defined strings with no inherent ordering — array position is the only canonical order, so a delta fetch would need an array index, not a version label; (2) the Star needs the full array to construct `new Ontology(versions)` for migration ordering; (3) the array is small (type definitions are a few KB each). If ontology arrays grow very large (many versions with complete type snapshots), a paginated or delta fetch could be added later without changing the storage model.

### Star: Local Cache + Galaxy Fetch on Miss

The Star caches the ontology locally in KV for synchronous access during transactions. When an operation arrives with an `ontologyVersion` the Star doesn't have, it fetches from Galaxy using the continuation pattern.

**Cache check helper** (derives Galaxy name from Star's dot-separated instance name — relies on the invariant that `validateSlug` rejects dots in scope segments):

```typescript
#ontology: Ontology | null = null;

get #galaxyName(): string {
  // Star instanceName is "{universe}.{galaxy}.{star}", Galaxy is "{universe}.{galaxy}"
  const parts = this.lmz.instanceName!.split('.');
  return parts.slice(0, 2).join('.');
}

#hasOntologyVersion(version: string): boolean {
  const stored = this.ctx.storage.kv.get<OntologyVersionConfig[]>('ontology');
  return stored?.some(v => v.version === version) ?? false;
}

get #currentOntology(): Ontology {
  if (!this.#ontology) {
    const stored = this.ctx.storage.kv.get<OntologyVersionConfig[]>('ontology');
    if (!stored?.length) throw new Error('No ontology cached — Galaxy fetch should have run first');
    this.#ontology = new Ontology(stored);
  }
  return this.#ontology;
}
```

### Continuation-Based Galaxy Fetch

The Star's mesh methods follow a **two-handler pattern**: Handler 1 checks the cache and dispatches; Handler 2 always does the actual work. On cache hit, Handler 1 calls Handler 2 as a simple method call. On cache miss, Handler 1 fires a continuation to Galaxy and Handler 2 runs as the response handler when Galaxy responds.

```typescript
// Handler 1: Check cache, dispatch to Handler 2
@mesh()
transaction(ontologyVersion: string, ops: Record<string, OperationDescriptor>) {
  const clientId = this.lmz.callContext.callChain[0]?.instanceName;

  if (this.#hasOntologyVersion(ontologyVersion)) {
    // Cache hit — execute directly, skip Galaxy entirely
    this.doTransaction(null, ontologyVersion, ops, clientId);
  } else {
    // Cache miss — ask Galaxy, carry context in the response handler
    this.lmz.call(
      'GALAXY', this.#galaxyName,
      this.ctn<Galaxy>().getOntology(),
      this.ctn().doTransaction(
        this.ctn().$result, ontologyVersion, ops, clientId
      )
    );
  }
}

// Handler 2: Execute transaction + deliver result to client
// Called directly (with null) on cache hit, or as response handler (4th param) on cache miss.
// Response handlers are local continuation targets — no @mesh() needed (same as handleResult pattern).
// Note: When a continuation fails, Lumenize Mesh puts an Error instance in the $result placeholder.
// That's why ontologyConfig can be Error — it handles Galaxy fetch failures.
doTransaction(
  ontologyConfig: OntologyVersionConfig[] | null | Error,
  ontologyVersion: string,
  ops: Record<string, OperationDescriptor>,
  clientId: string,
) {
  // Handle Galaxy fetch failure
  if (ontologyConfig instanceof Error) {
    this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
      this.ctn<NebulaClient>().handleTransactionResult(ontologyConfig));
    return;
  }

  // Cache miss path: store the fetched ontology from Galaxy
  if (ontologyConfig !== null) {
    if (!ontologyConfig.some(v => v.version === ontologyVersion)) {
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleTransactionResult(
          new Error(`Ontology version '${ontologyVersion}' not found`)));
      return;
    }
    this.ctx.storage.kv.put('ontology', ontologyConfig);
    this.#ontology = null;  // Reset cached Ontology instance
  }
  // Cache hit path: ontologyConfig is null, local KV already has the ontology

  // Version mismatch check: reject stale clients
  const ontology = this.#currentOntology;
  if (ontologyVersion !== ontology.latestVersion) {
    this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
      this.ctn<NebulaClient>().handleTransactionResult(
        new Error(`Ontology version mismatch: client sent '${ontologyVersion}' but latest is '${ontology.latestVersion}'. Refresh your schema.`)));
    return;
  }
  const result = this.#resources.transaction(ops, ontology);

  // Deliver result to client
  this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
    this.ctn<NebulaClient>().handleTransactionResult(result));
}
```

**Key properties of this pattern:**
- **One code path**: `doTransaction` is always the executor — no duplicated logic. Cache hit passes `null` (use local KV); cache miss passes `$result` from Galaxy (store then use). The `null` vs non-null check is the only branch.
- **Fire-and-forget from client**: The client never waits. It sends the operation and receives the result later via callback.
- **Wall-clock billing on cache miss only**: The response handler (4th param to `lmz.call`) keeps the Star in wall-clock billing while waiting for Galaxy. This is acceptable because: (a) cache misses are rare — only on ontology version change, and (b) Galaxy's `getOntology()` is a KV read — microseconds.
- **No storage of pending work**: The `$result` placeholder plus extra context params (`ontologyVersion`, `ops`, `clientId`) carry everything through the continuation. No KV writes, no ephemeral Maps.
- **Continuation serialization**: Context params (`ops` values contain arbitrary user data — Maps, Sets, Dates, cycles) survive the Galaxy roundtrip because Lumenize Mesh uses `@lumenize/structured-clone` for continuation parameter serialization, which handles all structured-clone-compatible types.

### Client Calling Pattern

**`handleTransactionResult` and `handleReadResult` are new `@mesh()` methods on the `NebulaClient` base class** (in `apps/nebula/src/nebula-client.ts`). `NebulaClient` extends `LumenizeClient` — a browser-side class (not a DO) with WebSocket connectivity and full `this.lmz.call()` / `this.ctn()` mesh capabilities for both sending and receiving calls. Stars deliver results to clients via `lmz.call()` targeting these methods through the `NEBULA_CLIENT_GATEWAY`.

**Base class implementations warn by default** — the real implementations will be fleshed out in Phase 5.3 (subscriptions), which designs the local cache, UI update model, and failure events (e.g., showing a red outline on reverted fields). For now, the base class just marks the method signatures with a `console.warn` (not a throw — throwing in a callback-style mesh method could cause unexpected behavior on the caller side):

```typescript
// NebulaClient base class — Phase 5.3 will add real implementations
// with local cache management and UI event dispatch
@mesh()
handleTransactionResult(result: TransactionResult | Error): void {
  console.warn('handleTransactionResult not yet implemented — see Phase 5.3');
}

@mesh()
handleReadResult(result: Snapshot | null | Error): void {
  console.warn('handleReadResult not yet implemented — see Phase 5.3');
}
```

**`NebulaClientTest` overrides these** for test assertions — storing results on instance variables. This is a throwaway test subclass; tests will be updated to use the real `NebulaClient` methods once Phase 5.3 fleshes them out:

```typescript
// NebulaClientTest — stores results for test assertions (throwaway pattern)
@mesh()
override handleTransactionResult(result: TransactionResult | Error): void {
  if (result instanceof Error) {
    this.lastError = result.message;
    this.lastResult = undefined;
  } else {
    this.lastResult = result;
    this.lastError = undefined;
  }
  this.callCompleted = true;
}
```

The existing `NebulaClientTest.handleResult` and its response-handler-based test initiators (`callStarResourcesTransaction`, `callStarResourcesRead`) are replaced. The new test initiators are one-way fire-and-forget calls — Stars deliver results back via `handleTransactionResult`/`handleReadResult`. Note: only resource initiators change to fire-and-forget; DagTree initiators continue using the existing response-handler pattern (DagTree doesn't involve continuation-based Galaxy fetches):

```typescript
// NebulaClientTest — new test initiators (one-way, no response handler)
callStarTransaction(starName: string, ontologyVersion: string, ops: Record<string, OperationDescriptor>): void {
  this.resetResults();
  this.lmz.call('STAR', starName,
    this.ctn<Star>().transaction(ontologyVersion, ops));
}

callStarRead(starName: string, ontologyVersion: string, resourceId: string): void {
  this.resetResults();
  this.lmz.call('STAR', starName,
    this.ctn<Star>().read(ontologyVersion, resourceId));
}
```

**Test pattern**: Since the round trip is async (client → gateway → Star → Galaxy? → Star → gateway → client), tests use `vi.waitFor()` to poll for completion — the same pattern already used throughout the test suite:

```typescript
client.callStarTransaction(starName, 'v1', ops);
await vi.waitFor(() => {
  expect(client.callCompleted).toBe(true);
});
expect(client.lastError).toBeUndefined();
const txnResult = client.lastResult as TransactionResult;
expect(txnResult.ok).toBe(true);
```

This applies to all resource operations (transactions, reads, queries) — the `ontologyVersion` + continuation pattern is the uniform external API. `Resources` internal methods remain synchronous.

### Why `star.resources()` Is No Longer the Client-Facing API

The current Star exposes `@mesh() resources(): Resources`, allowing callers to chain `star.resources().transaction(ops)`. This task **removes the `@mesh() resources()` method** — callers now go through Star's ontology-aware mesh methods (`star.transaction(ontologyVersion, ops)`) instead. The private `#resources` field remains as-is.

**Why the change is necessary**: The Galaxy fetch for ontology cache misses is an async continuation-based operation that only DOs with mesh capabilities can perform. Resources is a plain synchronous class — it can't fire continuations to Galaxy. The Star must intercept before the call reaches Resources, check the cache, potentially fetch from Galaxy, and only then delegate to Resources with the resolved Ontology.

**Resources still encapsulates ALL resource logic**: validation, defaults, storage, transactions, temporal snapshots. The Star adds ONLY the infrastructure coordination layer (Galaxy fetch, version mismatch check, result delivery to client). Think of Resources as the engine and Star as the ignition — you go through the ignition, but it doesn't do any engine work.

Existing Phase 5.1 tests that call `star.resources().transaction(ops)` must be rewritten to use the fire-and-forget pattern with `ontologyVersion`.

### Read Continuation Pattern

Reads also take `ontologyVersion` and follow the same cache-check → Galaxy-fetch-if-needed → execute → deliver-to-client flow. The Handler 1 / Handler 2 split is identical to transactions — only Handler 2's body differs.

**Reads also require latest version.** Although reads don't run validation, they still require `ontologyVersion` matching the Star's latest. Reasons: (1) consistency — same contract for all operations simplifies the mental model; (2) when Phase 5.2.5 adds graph queries that hydrate foreign-key references, the ontology's relationship metadata determines how to resolve those references, so the client must be working against the correct schema; (3) version mismatch on read is a cheap string comparison, not a tsc call. The version check lives in the Star's `doRead()` (same as `doTransaction()`). `Resources.read(resourceId)` does **not** receive the Ontology — it only handles storage and permission checks. The Star is responsible for version coordination before calling `Resources.read()`.

```typescript
// Handler 1: Check cache, dispatch to Handler 2
@mesh()
read(ontologyVersion: string, resourceId: string) {
  const clientId = this.lmz.callContext.callChain[0]?.instanceName;

  if (this.#hasOntologyVersion(ontologyVersion)) {
    this.doRead(null, ontologyVersion, resourceId, clientId);
  } else {
    this.lmz.call(
      'GALAXY', this.#galaxyName,
      this.ctn<Galaxy>().getOntology(),
      this.ctn().doRead(
        this.ctn().$result, ontologyVersion, resourceId, clientId
      )
    );
  }
}

// Handler 2: Execute read + deliver result to client (response handler — no @mesh() needed)
doRead(
  ontologyConfig: OntologyVersionConfig[] | null | Error,
  ontologyVersion: string,
  resourceId: string,
  clientId: string,
) {
  // Handle Galaxy fetch failure
  if (ontologyConfig instanceof Error) {
    this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
      this.ctn<NebulaClient>().handleReadResult(ontologyConfig));
    return;
  }

  // Cache miss path: store the fetched ontology from Galaxy
  if (ontologyConfig !== null) {
    if (!ontologyConfig.some(v => v.version === ontologyVersion)) {
      this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
        this.ctn<NebulaClient>().handleReadResult(
          new Error(`Ontology version '${ontologyVersion}' not found`)));
      return;
    }
    this.ctx.storage.kv.put('ontology', ontologyConfig);
    this.#ontology = null;
  }

  // Version mismatch check
  const ontology = this.#currentOntology;
  if (ontologyVersion !== ontology.latestVersion) {
    this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
      this.ctn<NebulaClient>().handleReadResult(
        new Error(`Ontology version mismatch: client sent '${ontologyVersion}' but latest is '${ontology.latestVersion}'. Refresh your schema.`)));
    return;
  }

  const snapshot = this.#resources.read(resourceId);

  this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
    this.ctn<NebulaClient>().handleReadResult(snapshot));
}
```

`handleReadResult` receives `Snapshot | null | Error` — `null` for not-found, `Error` for version mismatch or Galaxy fetch failure, `Snapshot` for success. See Client Calling Pattern above for the base class design.

### Same Pattern for Queries (Phase 5.2.5)

Queries will follow the same Handler 1 / Handler 2 pattern when implemented. The infrastructure is the same — only the executor body differs.

### How Resources Gets the Ontology

`Resources.transaction()` gains a second parameter: `ontology: Ontology`. The Star resolves the Ontology (from cache or Galaxy fetch) before calling. This keeps Resources synchronous and decoupled from the Galaxy fetch mechanism. The signature change from `transaction(ops)` to `transaction(ops, ontology)` must be reflected in all call sites (Star's `doTransaction` and `doRead`, plus any test code that calls `Resources.transaction` directly):

```typescript
// Resources — purely synchronous, no knowledge of Galaxy
transaction(ops: Record<string, OperationDescriptor>, ontology: Ontology): TransactionResult {
  // Step 5: validate using ontology
  // Steps 6-10: transactionSync (eTag conflict shape updated, otherwise unchanged)
}

// Resources.read() is unchanged — no ontology parameter needed.
// The Star handles version mismatch checks before calling read().
read(resourceId: string): Snapshot | null {
  // Permission check (unchanged), return snapshot
}
```

### `@mesh(requireAdmin)` for Galaxy's `appendOntologyVersion()`

The `requireAdmin` guard already exists in `nebula-do.ts` and is used by Galaxy's existing `setGalaxyConfig()`. Galaxy's `appendOntologyVersion()` uses the same guard.

### Ontology Constructor Validation

The `Ontology` constructor calls `extractTypeMetadata()` from `@lumenize/ts-runtime-validator` for the latest version's type definitions, getting back both the relationship metadata and write-shape type definitions in a single AST walk. (Whether per-version metadata is needed for Phase 5.5 migrations is an open question tracked in `tasks/nebula-5.5-schema-evolution.md` § Open Questions → Per-Version Metadata. For now, only the latest version is processed.) `extractTypeMetadata()` uses `ts.createSourceFile()` (fast parse, no type-checking) — so it catches **parse errors** (missing braces, invalid syntax, malformed declarations) but not **semantic errors** (type conflicts between interfaces, duplicate identifiers). Parse errors throw at construction time, giving immediate feedback when the vibe coder registers a broken ontology. Semantic errors in type definitions would surface later as tsc diagnostics when `validate()` runs — but in practice, type definitions written for schema purposes rarely have semantic errors that aren't also parse errors.

### Export Changes

**`packages/ts-runtime-validator/src/index.ts`** — add exports:
- `extractTypeMetadata` (function)
- `TypeMetadata`, `Relationship` (types)
- Existing exports remain: `toTypeScript`, `validate`, `stripExportsAndImports`, `ValidationResult`, `ValidationError`

**`apps/nebula/src/index.ts`** — update exports:
- Add: `Ontology` class, `OntologyVersionConfig` type, `TransactionError` type
- Update: `TransactionResult` (new shape), `OperationDescriptor` (renamed `update` → `put`, added `typeName` to `create`), `SnapshotMeta` (new `typeName` and `ontologyVersion` fields)
- Keep: `Snapshot` (used by `handleReadResult` and conflict errors), `Resources`, `END_OF_TIME`
- Remove: `resources()` mesh method on Star (the `@mesh()` decorator is removed; the private `#resources` field and `Resources` class are unchanged)

## Resolved Design Decisions

### `put` Validation: Full Value, Not Partial

**Decision: Both `create` and `put` validate the full `op.value`.**

`put` operations in `resources.ts` are **full replacements** — `#writeSnapshot` calls `stringify(op.value)` directly with no merge against existing state. Validating the complete value matches the actual storage semantics and ensures cross-field consistency (e.g., a conditional type like `{ status: 'shipped'; trackingId: string } | { status: 'pending' }` requires both fields to be checked together — partial validation would miss this).

If PATCH semantics are needed later, that should be a new `patch` operation type with its own merge + validate strategy.

### Defaults Are Create-Only

Defaults are applied before validation only on `create`. `put` operations must supply the full object with all required fields explicitly. This is consistent with full-replacement semantics — the caller is already sending the complete value.

### Delete and Move Skip Validation

- **`delete`**: No value to validate. Skip.
- **`move`**: Changes the DAG node, not the value. Skip. With per-resource typing, moving between nodes doesn't change the expected type.

### Always Validate Against Latest Version

`ontology.validate()` always uses the latest version's type definitions. The client sends `ontologyVersion` on every operation as a declaration of what it believes is the latest version. If the Star's actual latest is newer (after fetching from Galaxy), that's a **version mismatch** — the client needs to refresh its schema. This prevents writes against stale schemas.

The `ontologyVersion` stored in each snapshot records what version the write was validated against, enabling Phase 5.5 migrations to know the starting point. Callers cannot write against older versions — all new writes must conform to the latest schema. Reverse migrations are not supported (always roll forward). Phase 5.5 will handle read-time migration of resources written at older versions.

## Open Questions

### Validation

- **Validation bypass**: Should admin operations have a way to bypass validation? Useful for data repair. Dangerous for data integrity. Probably not — if the data is broken, fix the type definition.
- **Bundle size impact**: The tsc bundle (3.4 MB minified, ~1 MB gzipped) is now part of the Star's Worker bundle rather than a separate DWL module. Workers paid plan allows 10 MB compressed. Need to verify the total bundle stays under the limit.
- **Memory**: tsc uses ~40-50 MB per call in the Star's 128 MB isolate. The spike showed this is fine with ~78 MB headroom. Monitor in production.

### Relationship ID Validation

tsc validates the write shape (reference fields as `string`/`string[]`), but can't check that IDs point to real resources. That's a storage-layer concern — does `"person-uuid-1"` actually exist as a Person? Options:
- **Validate on write**: Look up each referenced ID in SQLite. Prevents dangling references. Potentially expensive for large `string[]` fields.
- **Validate on read (lazy)**: Accept any string at write time, fail gracefully when resolving relationships in Phase 5.2.5 queries. Simpler, but allows bad data in.
- **Validate on write for `one`, skip for `many`**: Compromise — single-reference fields are cheap to check, arrays can wait.

### Relationship Storage Model

The TypeScript types describe rich object graphs (`assignedTo: Person[]`), but the storage layer needs a concrete strategy for relationship data. This decision is deferred to implementation time — the write-shape type generation (relationship refs → `string`/`string[]`) works with any approach.

Key options:

**Embedded arrays** (store `assignedTo: ["person-uuid-1", "person-uuid-2"]` in the resource JSON):
- ✅ Self-contained — no joins needed to reconstruct the resource
- ✅ Single row update within `transactionSync`
- ❌ Inverse queries require scanning all resources of that type
- ❌ No referential integrity

**Temporal junction tables** (`TodoAssignees(todoId, personId, validFrom, validTo)`):
- ✅ Efficient inverse queries via index
- ✅ Point-in-time consistency (same `validFrom` as the parent resource write)
- ✅ Referential integrity possible via foreign keys
- ⚠️ More rows to write per transaction (one per relationship edge)
- ⚠️ The ontology must auto-manage these tables based on AST-extracted relationships

The temporal junction table approach is appealing because the ontology already knows the relationships from the AST — it could auto-create and auto-maintain the junction tables transparently. With temporal junction tables, the diff-vs-replace problem traditional ORMs face doesn't exist: close out `validTo` on current edges, insert new rows with the transaction's `validFrom`. Old edges become history, not deleted. Phase 5.2.5's query engine would use them for relationship resolution in both directions.

The wire format stays natural — `assignedTo: ["person-uuid-1", "person-uuid-2"]`. The translation between wire format and storage model is internal to the transaction flow, driven by the Ontology's relationship metadata.

### AST Parsing Scope

**This task handles only `T` and `T[]`** (plus `T?` / `T | null` for optional). The following edge cases are deferred to a future phase — they're real but not needed for the initial resource model:

- `Record<string, Person>` / `Map<string, Person>` — map-of-entity relationships
- `Person | Company` — polymorphic/union relationships
- `Person[][]` — nested arrays (likely an error)
- `interface TreeNode { children: TreeNode[] }` — self-referential types (valid but needs care in query resolution)
- `type Assignees = Person[]` then `assignedTo: Assignees` — type alias resolution

If `extractTypeMetadata()` encounters these patterns, it should treat them as regular fields (no relationship extracted, no substitution in write-shape) rather than erroring. The vibe coder gets tsc validation on the value shape regardless — relationship extraction is about metadata for the query engine, not correctness.

### Versioning

- **Complete snapshots vs incremental deltas**: The versioned array uses complete snapshots (each version has all types). This is explicit and avoids delta-composition complexity, but means larger ontology configs. Is this a problem in practice? Probably not — type definitions are small.
- **Version ordering**: Array position is the canonical ordering for migration purposes. Is this sufficient, or do we need explicit ordering metadata?
- Migration-related open questions (chaining, defaults overlap) are in Phase 5.5 (`tasks/nebula-5.5-schema-evolution.md`).

## Testing Strategy

### Ontology Unit Tests (Node.js)

The `Ontology` class is pure — no DO bindings needed. Test in Node.js via vitest:

- **Construction**: Versioned array config parsed correctly, relationships extracted from AST
- **`validate()` delegation**: Calls through to `@lumenize/ts-runtime-validator`'s `validate()` with correct write-shape type definitions for the latest version
- **Write-shape generation**: Relationship refs replaced with `string`/`string[]` in generated type definitions
- **`latestVersion`**: Returns last version label from the versioned array
- **Defaults**: `getDefaults()` returns correct defaults per type for the latest version
- **Relationship metadata**: `getRelationship()` returns correct target, cardinality, optional flag
- **Constructor validation**: Unparseable TypeScript in type definitions → throws at construction time (parse errors only, not semantic errors)
- **Edge cases**: Empty ontology, single version, type not found

### `extractTypeMetadata()` Unit Tests (Node.js)

Tests for the new export from `@lumenize/ts-runtime-validator`:

- **Simple relationships**: `Person` → one, `Person[]` → many, `Person?` → optional one
- **Non-relationships**: `string`, `number`, `boolean`, etc. → no relationship
- **Multiple interfaces**: Cross-references between interfaces in the same type definitions string
- **Unknown types**: References to types not in the type definitions → no relationship (just a regular field)
- **Write-shape generation**: `Person` → `string`, `Person[]` → `string[]`, `Person?` → `string?` in output type definitions
- **Non-relationship fields preserved**: Primitives, built-in types unchanged in write-shape output
- **All interfaces present**: Write-shape output includes all interfaces (tsc needs them for cross-type resolution)

### Galaxy Ontology Tests (vitest-pool-workers)

Integration tests for Galaxy's ontology management:

- **`appendOntologyVersion`**: Appends a version, `getOntology()` returns it
- **Append-only enforcement**: Appending a version with a duplicate label → throws, original unchanged
- **Eager validation**: Appending a version with unparseable TypeScript in `types` → throws, nothing stored
- **Multiple versions**: Append v1 then v2 → `getOntology()` returns both in order
- **Admin gating**: `appendOntologyVersion` requires admin; `getOntology` does not

### Transaction Integration Tests (vitest-pool-workers)

Integration tests using the existing `test/test-apps/` pattern with `instrumentDOProject`. Tests exercise the full continuation-based flow (Client → Star → Galaxy → Star → Client):

- **Cache hit**: Star has ontology locally → transaction completes without Galaxy call
- **Cache miss → Galaxy fetch**: Star doesn't have the requested `ontologyVersion` → fetches from Galaxy, caches locally, executes transaction, delivers result to client
- **Unknown ontologyVersion**: Client sends version that Galaxy doesn't have → error delivered to client
- **Valid create**: Value conforming to type → passes validation, resource created
- **Invalid create**: Value not conforming to type → `{ ok: false, errors: {...} }`, no resource written
- **Defaults on create**: Missing field with default → default applied, validation passes
- **`put` validation**: Full value checked against type (full-replacement semantics)
- **Delete skips validation**: Delete operations pass without validation
- **Batch with mixed valid/invalid**: Multiple resources in one transaction, some valid, some not → all validation errors collected, nothing written
- **No ontology cached and Galaxy has none**: `transaction()` delivers error to client
- **TransactionError discrimination**: `error.type === 'validation'` has `errors: ValidationError[]`; `error.type === 'conflict'` has `currentSnapshot`
- **Snapshot metadata**: Created resources have correct `typeName` and `ontologyVersion` in their snapshot meta
- **Debounce + ontology version**: Debounce UPDATE path correctly stores `typeName` and `ontologyVersion` (verify the in-place overwrite includes the new columns)
- **Version mismatch**: Client sends v1 but Star's latest (after Galaxy fetch) is v2 → error delivered to client ("Refresh your schema")
- **Read tests**: `star.read(ontologyVersion, resourceId)` via fire-and-forget with `handleReadResult` callback. Version mismatch on read → error. Successful read → `Snapshot | null`. Cache miss on read triggers Galaxy fetch (same as transaction path).
- **Existing tests**: Phase 5.1 resource tests updated: (1) register an ontology before transacting, (2) `op: 'update'` → `op: 'put'`, (3) add `typeName` to every `op: 'create'` descriptor, (4) `star.resources().transaction(ops)` → fire-and-forget calling pattern via `star.transaction(ontologyVersion, ops)`, (5) `star.resources().read(id)` → fire-and-forget via `star.read(ontologyVersion, id)` with `handleReadResult` callback, (6) conflict assertions use `error.type === 'conflict'` instead of raw `conflicts` field

## Success Criteria

### Ontology Class
- [x] `Ontology` class at `apps/nebula/src/ontology.ts` with versioned array config, type registry, and `validate()` delegation
- [x] `ontology.validate(value, typeName)` always uses latest version's write-shape type definitions and calls `validate(value, typeName, typeDefinitions)` from Phase 5.2.2, passing `writeShapeTypeDefinitions` as the `typeDefinitions` parameter
- [x] `ontology.latestVersion` returns the latest version label (for storing in snapshot metadata)
- [x] `extractTypeMetadata(typeDefinitions)` exported from `@lumenize/ts-runtime-validator` — single AST walk returns both `relationships` (Record<string, Record<string, Relationship>>) and `writeShapeTypeDefinitions` (string). Ontology does NOT import `typescript` directly
- [x] Relationships auto-extracted from TypeScript AST (`T` → one, `T[]` → many, `T?` → optional one)
- [x] Write-shape type definitions auto-generated in the same AST walk (relationship refs → `string`/`string[]`)
- [x] `ontology.getRelationship()` returns extracted relationship metadata for query resolution
- [x] `defaults` from ontology config applied before validation on `create` (client values override)
- [x] `defaults` not applied on `put` (`put` is a full replacement — caller sends complete value)
- [x] `migrate` property accepted in ontology config (placeholder — execution deferred to Phase 5.5)
- [x] Constructor validates type definitions eagerly — parse errors (missing braces, invalid syntax) throw at construction time via `extractTypeMetadata()`

### Transaction Integration
- [x] `op: 'update'` renamed to `op: 'put'` across `OperationDescriptor`, `#writeSnapshot`, validation logic, permission checks, and all existing tests
- [x] `transaction()` validates ALL resource values against their TypeScript types before `transactionSync()` — synchronously, in-process
- [x] Validation errors collected across ALL resources in the batch (not fail-fast) and returned as `{ ok: false, errors: {...} }`
- [x] `TransactionError` is a discriminated union: `{ type: 'conflict'; currentSnapshot } | { type: 'validation'; errors: ValidationError[] }`
- [x] `TransactionResult` unified: `{ ok: false; errors: Record<string, TransactionError> }` for both conflicts and validation failures
- [x] Transaction remains fully synchronous (no new `await`, no interleaving risk)

### Schema & Type Tracking
- [x] `create` variant of `OperationDescriptor` includes `typeName: string`
- [x] Per-resource type tracking: `typeName` and `ontologyVersion` columns added to Snapshots table
- [x] `SnapshotMeta` interface gains `typeName: string` and `ontologyVersion: string` fields
- [x] `ontologyVersion` is always `ontology.latestVersion` for this task (Phase 5.5 uses it for migration starting point)
- [x] `#writeSnapshot` stores `typeName` and `ontologyVersion` in each snapshot row (both INSERT and debounce UPDATE paths)

### Galaxy
- [x] `appendOntologyVersion(versionConfig)` — admin-gated, validates eagerly, appends to KV array
- [x] Append-only enforcement — duplicate version label → throws, nothing stored
- [x] `getOntology()` — returns full ontology config array, not admin-gated (Stars call it)

### Star & Continuation Pattern
- [x] `star.resources()` mesh method removed from client-facing API (becomes private `#resources`) — callers use `star.transaction(ontologyVersion, ops)` instead
- [x] Every resource operation (transaction, read, query) requires `ontologyVersion` from the caller — reads also enforce latest version (no validation, but version mismatch check)
- [x] Star caches ontology locally in KV, reconstructs `Ontology` instance on demand (ephemeral cache)
- [x] Cache hit → Handler 2 (`doTransaction`/`doRead`) called as simple method call (synchronous, no Galaxy roundtrip)
- [x] Cache miss → continuation to Galaxy's `getOntology()` with `$result` + context in response handler → Handler 2 runs as response handler
- [x] `doTransaction` and `doRead` are plain methods (NOT `@mesh()`) — they're response handlers (4th param to `lmz.call`), not remote targets
- [x] Version mismatch → error delivered to client (client's `ontologyVersion` must equal `ontology.latestVersion`)
- [x] Galaxy fetch error → delivered to client as `Error`
- [x] Unknown `ontologyVersion` (not in Galaxy's config) → error delivered to client
- [x] `doTransaction` is the single executor — one code path for both cache hit and miss
- [x] `doRead` follows same Handler 1 / Handler 2 pattern — receives `Snapshot | null` from `Resources.read()` and delivers via `handleReadResult`
- [x] Client API is always fire-and-forget — result delivered via callback continuation
- [x] `handleTransactionResult` and `handleReadResult` are new `@mesh()` methods on `NebulaClient` base class — warn by default (real implementations deferred to Phase 5.3 subscriptions with local cache + UI events)
- [x] `NebulaClientTest` overrides these with throwaway instance-variable storage for assertions (will be updated to use real `NebulaClient` methods in Phase 5.3)
- [x] `NebulaClientTest` test initiators replaced: `callStarResourcesTransaction`/`callStarResourcesRead` → `callStarTransaction`/`callStarRead` (one-way fire-and-forget, no response handler)
- [x] All resource tests use `vi.waitFor(() => expect(client.callCompleted).toBe(true))` to await the async round trip
- [x] `Resources.transaction()` receives `Ontology` instance as a second parameter — synchronous, no knowledge of Galaxy
- [x] `Resources.read()` signature unchanged (`resourceId: string`) — version mismatch check is the Star's responsibility, not Resources'
- [x] `delete` and `move` operations skip validation

### Exports
- [x] `packages/ts-runtime-validator/src/index.ts` exports `extractTypeMetadata`, `TypeMetadata`, `Relationship`
- [x] `apps/nebula/src/index.ts` exports updated: `Ontology`, `OntologyVersionConfig`, `TransactionError` added; `OperationDescriptor`, `TransactionResult`, `SnapshotMeta` updated

### Code Hygiene
- [x] `#calculateValidFrom()` has a code comment explaining why `Date.now()` is correct in Workers: the loop advances past any existing `validFrom` timestamps, ensuring temporal ordering even when the clock doesn't advance during synchronous execution

### Testing & Performance
- [x] Warm validation latency ~1ms (confirmed by spike; not re-measured in integration but tests complete in <500ms per test including full mesh round-trip)
- [x] Existing Phase 5.1 resource tests updated: ontology registered, `op: 'update'` → `op: 'put'`, `typeName` added to creates, `star.resources().transaction()` → fire-and-forget via `star.transaction(ontologyVersion, ops)`, `star.resources().read()` → fire-and-forget via `star.read(ontologyVersion, id)`, conflict assertions use `TransactionError` discriminated union
- [x] Galaxy ontology tests: append, append-only enforcement, eager validation, admin gating
- [x] Ontology unit tests: construction, validation delegation, write-shape generation, defaults, relationships, version resolution, error handling
- [x] Transaction integration tests: cache hit, cache miss → Galaxy fetch, unknown version, valid/invalid creates, defaults, puts, deletes, debounce + ontology version, batch with mixed valid/invalid
- [x] Read integration tests: fire-and-forget read with `handleReadResult`, version mismatch on read, cache miss triggering Galaxy fetch, not-found returning null
- [ ] Test coverage: >80% branch, >90% statement (not measured — deferred to Phase 5.7 coverage pass)
