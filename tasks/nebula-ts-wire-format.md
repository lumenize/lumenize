# Phase 4.2: TypeScript as Wire Format

**Status**: Spike
**Prerequisite**: [ADR-001](../docs/adr/001-typescript-as-schema.md) — tsc in DWL validated at 1ms/call
**Package**: `@lumenize/structured-clone`

---

## Idea

What if tiny TypeScript programs became the wire format for Lumenize?

Currently, `@lumenize/structured-clone` serializes rich objects to a JSON-based `$lmz` tuple format with markers and references. Separately, ADR-001 proved that tsc can validate data against TypeScript types at 1ms in a DWL isolate. These are two separate concerns: serialization and validation.

The insight: **collapse them into one**. The wire format IS a TypeScript program. Validation happens as a side effect of deserialization. "Parse, don't validate" (Zod's principle) — the DWL returns the parsed, validated object over Workers RPC.

## Pipeline

```
Sender                          DWL Isolate                      Receiving DO
──────                          ───────────                      ────────────
rich object
  → toTypeScript()
    → TypeScript program ──────→ tsc type-checks (1ms)
      (wire format)              AST walk reconstructs object
                                   → rich object ──────────────→ received via
                                     (over Workers RPC)          Workers RPC
```

Three layers of protection, none requiring trust in the input:
1. **tsc** — rejects anything that doesn't match the declared type
2. **AST whitelist** — only reconstructs node types we explicitly handle
3. **Workers RPC** — structured-clone transfer strips functions passively

## Approach: Extend `@lumenize/structured-clone`

Add `toTypeScript()` / `fromTypeScript()` as an alternative codec alongside existing `stringify()` / `parse()`.

The serialization side (`toTypeScript()`) reuses the same object graph traversal and cycle detection from `preprocess()` — it's the same walk, different output format. Instead of `$lmz` tuples, emit TypeScript statements.

The deserialization side (`fromTypeScript()`) is new: tsc parses → AST walk reconstructs objects. This runs inside the DWL isolate.

### `toTypeScript()` output examples

**Acyclic (common case):**
```typescript
const __validate: Todo = { title: "Fix bug", done: false };
```

**With Map/Set/Date:**
```typescript
const __validate: Config = {
  tags: new Set<string>(["admin", "user"]),
  metadata: new Map<string, number>([["retries", 3]]),
  createdAt: new Date("2026-03-08T00:00:00.000Z"),
};
```

**Cyclic:**
```typescript
const __ref0 = {} as TreeNode;
const __ref1 = {} as TreeNode;
__ref0.value = "root";
__ref0.children = [__ref1];
__ref1.value = "child";
__ref1.parent = __ref0;
const __validate: TreeNode = __ref0;
```

### `fromTypeScript()` — AST reconstruction

Walks tsc's AST with a whitelist of supported node types:

| AST Node | Reconstructs to |
|----------|----------------|
| `ObjectLiteralExpression` | `{}` |
| `ArrayLiteralExpression` | `[]` |
| `StringLiteral` | `string` |
| `NumericLiteral` | `number` |
| `TrueKeyword` / `FalseKeyword` | `boolean` |
| `NullKeyword` | `null` |
| `Identifier("undefined")` | `undefined` |
| `NewExpression("Map", ...)` | `new Map(...)` |
| `NewExpression("Set", ...)` | `new Set(...)` |
| `NewExpression("Date", ...)` | `new Date(...)` |
| `Identifier("__refN")` | reference to previously constructed object |
| `PropertyAssignment` on `__refN` | mutation to wire cycles |

Anything not in this table → reject with error. No eval, no `new Function`.

## Constraints

- **No `eval` / `new Function`** — not available in Workers, and a security risk regardless
- **No Blob / ArrayBuffer** — can't be expressed as TypeScript literals. Out of scope for this format
- **Workers RPC is the exit** — the reconstructed object leaves the DWL via RPC, which only transfers structured-clonable types (passive function stripping)

## Spike scope

1. Add `toTypeScript(value, typeName, typeDefinitions)` to `packages/structured-clone`
   - Reuse `preprocess()` traversal patterns (cycle detection, alias tracking)
   - Output: string containing a valid TypeScript program
2. Add `fromTypeScript(program)` — AST walk that reconstructs the object
   - Uses tsc's parser (`ts.createSourceFile`) — no full `createProgram` needed for reconstruction
   - Whitelist-only node handling
3. Round-trip tests: `object → toTypeScript() → fromTypeScript() → deepEqual(original)`
   - Plain objects, nested objects
   - Map, Set, Date
   - Cycles, aliases
   - Type errors (wrong field types, missing fields, extra fields)
4. DWL integration test: `toTypeScript()` on sender side → DWL validates + reconstructs → object comes back over RPC

## Out of scope for spike

- Performance optimization (just prove the round-trip works)
- Schema evolution
- Error types, RegExp, TypedArrays, Web API objects
- Integration with `lmz.call()` pipeline
- Updating the ADR (do that after spike results are in)

## Open questions

- Does `ts.createSourceFile` (parser only, no type-checker) give us enough AST fidelity for reconstruction? Or do we need the full `createProgram`? (We need `createProgram` for validation, but reconstruction might be parser-only.)
- How to handle the type definitions — are they passed alongside the program, or pre-loaded in the DWL isolate?
- Should `toTypeScript()` live in structured-clone proper (runs everywhere) while `fromTypeScript()` lives in a DWL-specific package (needs tsc)?
