# Phase 5.2.1: Structured-Clone `toTypeScript()` Serialization

**Status**: Pending
**Package**: `packages/ts-runtime-validator/` (`@lumenize/ts-runtime-validator`)
**Depends on**: Phase 5.2.1.1 (Wrangler Upgrade), Phase 5.2.1.2 (DWL Spike)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`

## Goal

Add a `toTypeScript()` export to `@lumenize/ts-runtime-validator` that converts any JavaScript value into a mini TypeScript program suitable for type-checking with `tsc`. This is the serialization part of the "TypeScript IS the schema" vision — `toTypeScript()` produces the program, and Phase 5.2.2's `validate()` feeds it to `tsc`. Both functions live in the same package.

## Why a Separate Package

`toTypeScript()` reuses `preprocess()` from `@lumenize/structured-clone` to get the tagged-tuple intermediate representation with cycles/aliases already resolved, then walks those tuples to emit TypeScript. This avoids reimplementing the tree walk (which was hard to get right). However, Phase 5.2.2's `validate()` bundles tsc (3.4 MB). Putting both in structured-clone would force every consumer of `stringify()`/`parse()` to pay for tsc even when they only need wire transport.

`@lumenize/ts-runtime-validator` keeps structured-clone lean and pairs the two functions that are always used together: `toTypeScript()` produces the program, `validate()` runs tsc on it. The package depends on `@lumenize/structured-clone` for `preprocess()`, `LmzIntermediate`, `RequestSync`/`ResponseSync` types, and the `TRANSFORM_SKIP` sentinel.

## Design

### API Surface

```typescript
// Export from @lumenize/ts-runtime-validator
export function toTypeScript(value: unknown, typeName: string): string;
```

Given a value and a TypeScript type name, produces a valid TypeScript program that `tsc` can type-check. If the program compiles without errors, the value conforms to the type, but that type checking is in phase 5.2.2, not this one.

### Acyclic Case (Common)

Single `const` assignment with an object literal:

```typescript
// toTypeScript({ title: "Fix bug", done: false }, "Todo")
const __validate: Todo = {"title": "Fix bug", "done": false};
```

### Cyclic Case

Input shape — a tree where parent references a child array of the same type:

```typescript
interface TreeNode {
  value: string;
  children: TreeNode[];
}
```

```
root = {
  value: "root",
  children: [
    {
      value: "child",
      children: [ → root ]   // circular reference back to root
    }
  ]
}
```

Multi-statement program with declaration + mutation (from ADR-001):

```typescript
// toTypeScript(cyclicTree, "TreeNode")
const __ref0 = {} as TreeNode;
const __ref1 = {} as TreeNode;
__ref0.value = "root";
__ref0.children = [__ref1];
__ref1.value = "child";
__ref1.children = [__ref0];
```

The `as T` on empty objects is safe because every field is immediately assigned — tsc checks each property assignment against the type.

### Alias Case

Input shape — shipping and billing point to the same `Address` object:

```typescript
interface Address {
  city: string;
}
interface Company {
  shipping: Address;
  billing: Address;
}
```

```
shared = { city: "Portland" }

company = {
  shipping: → shared,
  billing:  → shared    // same object, not a copy
}
```

Shared references (same object at multiple paths) use the same `__refN` variable:

```typescript
const __ref0 = {} as Address;
__ref0.city = "Portland";
const __validate: Company = {"shipping": __ref0, "billing": __ref0};
```

### Type Mapping

This is the same set of types supported by `@lumenize/structured-clone`'s `preprocess()` — every type that can be serialized on the wire must also be expressible as TypeScript for validation.

**Primitives** (inline values):

| JS Value | TypeScript Output |
|----------|-------------------|
| `string` | `"value"` (quoted) |
| `number` | `42`, `NaN`, `Infinity`, `-Infinity` |
| `boolean` | `true` / `false` |
| `null` | `null` |
| `undefined` | `undefined` |
| `bigint` | `BigInt("123")` |

**Built-in objects** (inline constructors):

| JS Value | TypeScript Output |
|----------|-------------------|
| `Date` | `new Date("2026-01-01T00:00:00.000Z")` |
| `RegExp` | `new RegExp("pattern", "flags")` |
| `URL` | `new URL("https://example.com")` |

**Collections** (recursive):

| JS Value | TypeScript Output |
|----------|-------------------|
| `Array` | `[item1, item2]` |
| `Object` | `{"key": value}` |
| `Map` | `new Map([["key", value]])` |
| `Set` | `new Set([value1, value2])` |

**Binary data**:

| JS Value | TypeScript Output |
|----------|-------------------|
| `ArrayBuffer` | `new ArrayBuffer(8)` |
| `DataView` | `new DataView(new ArrayBuffer(8))` |
| `Uint8Array` etc. | `new Uint8Array([1, 2, 3])` |

**Error types**:

| JS Value | TypeScript Output |
|----------|-------------------|
| `Error` (and subtypes) | `new Error("message")` / `new TypeError("message")` |

**Wrapper objects** (rare but supported):

| JS Value | TypeScript Output |
|----------|-------------------|
| `new Boolean(x)` | `new Boolean(true)` |
| `new Number(x)` | `new Number(42)` |
| `new String(x)` | `new String("value")` |
| `Object(BigInt(n))` | `Object(BigInt("123"))` |

**Lumenize-specific types**:

| JS Value | TypeScript Output |
|----------|-------------------|
| `Headers` | `new Headers([["content-type", "application/json"]])` |
| `RequestSync` | `new RequestSync("https://example.com", { ... })` |
| `ResponseSync` | `new ResponseSync("body", { ... })` |

**Non-serializable**:

| JS Value | Behavior |
|----------|----------|
| `function` | Throws `TypeError` |
| `symbol` | Throws `TypeError` |
| Native `Request` | Throws `Error` |
| Native `Response` | Throws `Error` |

Note: `preprocess()` converts functions to marker objects for RPC method discovery, but `toTypeScript()` throws instead because a marker object would produce misleading tsc errors against function-typed properties.

## Testing Strategy

### Round-Trip Echo Tests via Dynamic Worker Loader

Rather than only checking that `toTypeScript()` output compiles, we verify semantic fidelity with full round-trip echo tests:

1. **Serialize**: Call `toTypeScript(value, typeName)` to produce a TypeScript program
2. **Execute**: Use DWL to run the generated program in an isolate, returning the constructed value
3. **Compare**: Assert the returned value deeply equals the original using Vitest's strictest comparison (`toStrictEqual` or equivalent)

This catches subtle bugs where the TypeScript output compiles but doesn't reconstruct the value faithfully (e.g., wrong Date format, lost Map entries, mangled binary data).

**Test progression**:
- **Single-type tests**: One property per supported type (string, number, bigint, Date, RegExp, URL, Map, Set, ArrayBuffer, typed arrays, Error subtypes, wrapper objects, Headers, RequestSync, ResponseSync)
- **Special values**: `NaN`, `Infinity`, `-Infinity`, `null`, `undefined`, `0`, `-0`, `""`, empty collections
- **Mixed objects**: Objects with multiple property types at varying depths
- **Cycles**: Parent→child→parent circular references
- **Aliases**: Multiple paths referencing the same object
- **Cycles + aliases combined**: Real-world-like object graphs

Phase 5.2.1.2 validates that DWL works inside vitest-pool-workers tests. Assuming it does: configure `"worker_loaders"` in the package's `wrangler.jsonc` and access `env.LOADER` in tests like any other binding. The generated code runs in the DWL isolate; we extract the `__validate` (or `__ref0` etc.) value and send it back for comparison. If DWL module loading only supports `.js` (not `.ts`), strip type annotations before loading — annotations don't affect runtime behavior, so the round-trip test still validates semantic fidelity. See the spike's results for the exact pattern and any gotchas.

## Implementation Strategy

### Reuse `preprocess()`, Don't Reimplement the Walk

`@lumenize/ts-runtime-validator` depends on `@lumenize/structured-clone` and calls `preprocess()` to get the tagged-tuple intermediate representation (`LmzIntermediate`). This gives us battle-tested cycle/alias detection for free — the WeakMap bookkeeping, ID assignment, and reference tracking are all handled by `preprocess()`.

`toTypeScript()` then walks the tagged tuples to emit TypeScript strings. Each tag maps directly to a TS construct:

| Tagged Tuple | TypeScript Output |
|---|---|
| `["string", "hello"]` | `"hello"` |
| `["number", "NaN"]` | `NaN` |
| `["date", iso]` | `new Date("...")` |
| `["map", entries]` | `new Map([...])` |
| `["set", values]` | `new Set([...])` |
| `["regexp", {source, flags}]` | `new RegExp("...", "...")` |
| `["$lmz", id]` | `__refN` (variable reference) |
| etc. | etc. |

**2-pass architecture (hard maximum — no additional passes):**

1. **Pass 1**: `preprocess(value, { transform })` → `LmzIntermediate`. The transform hook throws on functions, symbols, native Request/Response (where `preprocess()` would otherwise create marker objects).
2. **Pass 2**: Walk the `LmzIntermediate` tuples. Count `["$lmz", id]` references to decide inline vs. variable. Emit TypeScript strings. Objects referenced once → inline literal. Objects referenced 2+ times or involved in cycles → `const __refN` variable declarations.

### Output Structure

```typescript
function toTypeScript(value: unknown, typeName: string): string {
  // Pass 1: Reuse structured-clone's preprocess()
  const intermediate = preprocess(value, { transform: throwOnNonSerializable });
  // Pass 2: Walk tagged tuples, emit TypeScript
  //   - Count references to decide inline vs. __refN variables
  //   - If no shared refs: single `const __validate: T = literal;`
  //   - If shared refs/cycles: multi-statement program with __refN declarations
  return programText;
}
```

The caller (Phase 5.2.2's validator) prepends the type definition and feeds the combined program to tsc.

## Open Questions

- **Special number handling**: `NaN`, `Infinity`, `-Infinity` — should these be emitted as literal identifiers? tsc recognizes them as `number`. Confirm tsc accepts `const x: number = NaN;`.
- **Excess property checking**: By default, tsc flags excess properties in object literals (`Object literal may only specify known properties`). This is the behavior we want — it catches typos and unexpected fields. But does it apply to the `as T` + mutation pattern for cyclic objects? Need to verify.
- **`undefined` vs missing**: `{a: undefined}` and `{}` are different in JS but may type-check the same way in TS if `a` is optional. Is this a problem?
- **Map/Set type parameters**: Resolved — no explicit type params needed. tsc infers from the entries and checks assignability against the target type.
- **Nested type names**: For multi-resource validation (Phase 5.2.5), will we need multiple type names in a single program? E.g., `const __v0: Invoice = {...}; const __v1: LineItem = {...};`. If so, the API signature may need to accept multiple `(value, typeName)` pairs.

## Success Criteria

- [ ] `toTypeScript(value, typeName)` produces valid TypeScript for all types supported by `@lumenize/structured-clone`
- [ ] Cyclic objects produce multi-statement programs with `__refN` declarations
- [ ] Aliased objects reuse the same `__refN` variable
- [ ] Acyclic objects produce single `const __validate: T = literal;`
- [ ] Round-trip test: `toTypeScript(value, typeName)` → prepend type definition → tsc compiles without errors for conforming values
- [ ] Round-trip test: `toTypeScript(badValue, typeName)` → prepend type definition → tsc produces expected diagnostic for non-conforming values
- [ ] `@lumenize/structured-clone` unmodified — `stringify()`/`parse()` tests unaffected
- [ ] Test coverage: >80% branch, >90% statement
