# Phase 5.2.1: Structured-Clone `toTypeScript()` Serialization

**Status**: Pending
**Package**: `packages/ts-runtime-validator/` (`@lumenize/ts-runtime-validator`)
**Depends on**: Phase 5.1 (Storage Engine)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`
**ADR**: `docs/adr/001-typescript-as-schema.md`

## Goal

Add a `toTypeScript()` export to `@lumenize/ts-runtime-validator` that converts any JavaScript value into a mini TypeScript program suitable for type-checking with `tsc`. This is the serialization part of the "TypeScript IS the schema" vision — `toTypeScript()` produces the program, and Phase 5.2.2's `validate()` feeds it to `tsc`. Both functions live in the same package.

## Why a Separate Package

Originally we considered extending `@lumenize/structured-clone`, since `toTypeScript()` follows the same `WeakMap` cycle/alias detection pattern as `preprocess()`. However, the shared code is just the *pattern* (~100 lines of straightforward recursion), not actual code reuse — `toTypeScript()` does its own walk with fundamentally different output. More importantly, Phase 5.2.2's `validate()` bundles tsc (3.4 MB). Putting both in structured-clone would force every consumer of `stringify()`/`parse()` to pay for tsc even when they only need wire transport.

`@lumenize/ts-runtime-validator` keeps structured-clone lean and pairs the two functions that are always used together: `toTypeScript()` produces the program, `validate()` runs tsc on it. The package depends on `@lumenize/structured-clone` for `RequestSync`/`ResponseSync` types.

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

## Implementation Strategy

### Custom Walk (Same Pattern, Different Output)

`toTypeScript()` uses the same `WeakMap` cycle/alias detection pattern as `@lumenize/structured-clone`'s `preprocess()`, but does its own traversal and emits TypeScript strings directly. The output format is fundamentally different from `preprocess()`'s tagged tuples, so sharing code would mean fighting the tuple format. The traversal logic is ~100 lines of straightforward recursion.

### Output Structure

```typescript
function toTypeScript(value: unknown, typeName: string): string {
  // Phase 1: Walk the value graph, identify cycles and aliases
  // Phase 2: Emit TypeScript
  //   - If no cycles/aliases: single `const __validate: T = literal;`
  //   - If cycles/aliases: multi-statement program with __refN declarations
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
- [ ] Round-trip test: `toTypeScript(value)` → prepend type definition → tsc compiles without errors for conforming values
- [ ] Round-trip test: `toTypeScript(badValue)` → prepend type definition → tsc produces expected diagnostic for non-conforming values
- [ ] `@lumenize/structured-clone` unmodified — `stringify()`/`parse()` tests unaffected
- [ ] Test coverage: >80% branch, >90% statement
