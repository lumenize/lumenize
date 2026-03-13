# Phase 5.2.1: Structured-Clone `toTypeScript()` Serialization

**Status**: Pending
**Package**: `packages/ts-runtime-validator/` (`@lumenize/ts-runtime-validator`)
**Depends on**: Phase 5.2.1.1 (Wrangler Upgrade) — **Complete** (commit 0608264)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`

## Goal

Add a `toTypeScript()` export to `@lumenize/ts-runtime-validator` that converts any JavaScript value into a mini TypeScript program suitable for type-checking with `tsc`. This is the serialization part of the "TypeScript IS the schema" vision — `toTypeScript()` produces the program, and Phase 5.2.2's `validate()` feeds it to `tsc`. Both functions live in the same package.

## Why a Separate Package

`toTypeScript()` reuses `preprocess()` from `@lumenize/structured-clone` to get the tagged-tuple intermediate representation with cycles/aliases already resolved, then walks those tuples to emit TypeScript. This avoids reimplementing the tree walk (which was hard to get right). However, Phase 5.2.2's `validate()` bundles tsc (3.4 MB). Putting both in structured-clone would force every consumer of `stringify()`/`parse()` to pay for tsc even when they only need wire transport.

`@lumenize/ts-runtime-validator` keeps structured-clone lean and pairs the two functions that are always used together: `toTypeScript()` produces the program, `validate()` runs tsc on it. The package depends on `@lumenize/structured-clone` for `preprocess()`, `LmzIntermediate`, and the `RequestSync`/`ResponseSync` classes (used in echo tests to construct values and injected into the `vm` sandbox for evaluation).

**Prerequisite** ✅: `LmzIntermediate` is now exported from `@lumenize/structured-clone`'s `index.ts` as a public type (the `@internal` JSDoc tag was removed — it should never have been `@internal` since it's the return type of the public `preprocess()` function).

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

### Inline-First Strategy

The guiding principle: **emit one big object literal whenever possible**. tsc performs excess property checking on object literals at assignment sites — this is our primary defense against typos and unexpected fields. Every property that's part of an object literal gets checked. The only exception is cycle back-edges, which require a post-literal fixup mutation.

- **Acyclic, no aliases**: Single inline literal. Full excess property checking.
- **Aliases (no cycles)**: Duplicate the aliased object at each use site. Each copy is part of the literal → full excess property checking. Reference identity is lost, but for type checking that's irrelevant.
- **Cycles**: Inline the object literal as deep as possible. Where the cycle closes (the back-edge), emit `null as any` as a placeholder. After the literal, one fixup mutation per back-edge fills it in with a correctly-typed path expression.

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

Inline literal with `null as any` placeholder for the back-edge, plus fixup:

```typescript
// toTypeScript(cyclicTree, "TreeNode")
const __validate: TreeNode = {"value": "root", "children": [{"value": "child", "children": [null as any]}]};
__validate["children"][0]["children"][0] = __validate;
```

The entire object graph is a single literal → tsc performs excess property checking on every property. If `"typo": "oops"` appeared anywhere in the literal, tsc would catch it. The `null as any` placeholder is immediately overwritten by the fixup with `__validate` (type `TreeNode`), which tsc verifies is assignable to the slot.

Non-root cycles work too. If B→C→B (neither is root A):

```typescript
const __validate: AType = {"child": {"child": {"child": null as any}}};
__validate["child"]["child"]["child"] = __validate["child"];
```

tsc typechecks the full path expression, so the fixup is type-safe.

All property keys in fixup statements use bracket notation with quoted keys (e.g., `__validate["children"]` not `__validate.children`). This uniformly handles keys that aren't valid JS identifiers (e.g., `"foo-bar"`, `"123"`, keys with spaces). Since no human reads this output, readability is irrelevant.

**Map/Set cycle fixups**: When a cycle back-edge appears inside a Map value or Set, the fixup uses `.set()` or `.add()` instead of bracket assignment:

```typescript
// Map value cycle: replace the null placeholder via .set()
__validate["myMap"].set("key", __validate);

// Set cycle: remove the null placeholder, then add the real reference
__validate["mySet"].delete(null);
__validate["mySet"].add(__validate);
```

**Map cycle fixups require primitive keys.** The fixup `.set(key, target)` must reference the Map key as a TypeScript literal expression (e.g., `.set("key", target)` or `.set(42, target)`). Object keys cannot be used in fixups because `.set({...newObj...}, target)` creates a new reference — Map uses reference equality, so this adds a new entry instead of updating the existing one. If a cycle back-edge passes through a Map value with a non-primitive key, `toTypeScript()` throws `TypeError`. Acyclic Maps with object keys work fine (the key is inlined in the `new Map([...])` literal). This aligns with `@lumenize/structured-clone`'s guidance to [use primitive keys for Maps](/docs/structured-clone/maps-and-sets). Map *keys* that are themselves cyclic references are also not supported (pathological, no real-world use case).

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

Aliases are duplicated — each use site gets its own inline copy within the literal:

```typescript
const __validate: Company = {"shipping": {"city": "Portland"}, "billing": {"city": "Portland"}};
```

Both copies are part of the object literal → full excess property checking. No `__refN` variables needed.

**Performance note**: Alias duplication means the output grows linearly with the number of references to a shared object. For typical data (shared addresses, configs, user objects), this is negligible. Pathological cases (huge object aliased hundreds of times) would produce large output; if this becomes a real problem, a size-threshold fallback to `__refN` could be added later.

### Type Mapping

This is the same set of types supported by `@lumenize/structured-clone`'s `preprocess()` — every type that can be serialized on the wire must also be expressible as TypeScript for validation.

**Primitives** (inline values):

| JS Value | TypeScript Output |
|----------|-------------------|
| `string` | `"value"` (quoted via `JSON.stringify()` for proper escaping) |
| `number` | `42`, `NaN`, `Infinity`, `-Infinity` |
| `boolean` | `true` / `false` |
| `null` | `null` (from single-element tuple `["null"]`) |
| `undefined` | `undefined` (from single-element tuple `["undefined"]`) |
| `bigint` | `BigInt("123")` |

**Built-in objects** (inline constructors):

| JS Value | TypeScript Output |
|----------|-------------------|
| `Date` | `new Date("2026-01-01T00:00:00.000Z")` |
| `RegExp` | `new RegExp("pattern", "flags")` — source and flags escaped via `JSON.stringify()` |
| `URL` | `new URL("https://example.com")` |

**Collections** (recursive):

| JS Value | TypeScript Output |
|----------|-------------------|
| `Array` | `[item1, item2]` |
| `Object` | `{"key": value}` (JSON-style quoted keys) |
| `Map` | `new Map([["key", value]])` |
| `Set` | `new Set([value1, value2])` |

**Binary data**:

| JS Value | TypeScript Output | Notes |
|----------|-------------------|-------|
| `ArrayBuffer` | `new ArrayBuffer(8)` | Size only — content not preserved (sufficient for type checking) |
| `DataView` | `new DataView(new ArrayBuffer(8), byteOffset)` | Size/offset preserved, content not preserved. `byteOffset` included when non-zero. |
| `Uint8Array` etc. | `new Uint8Array([1, 2, 3])` | Content preserved (element values are numeric literals) |

**Error types**:

| JS Value | TypeScript Output |
|----------|-------------------|
| `Error` (simple, standard name) | `new TypeError("message")` (constructor matches `errorData.name`) |
| `Error` (simple, custom name) | `Object.assign(new Error("message"), {"name": "AppError"})` (fallback to `Error`, name preserved) |
| `Error` (with custom props) | `Object.assign(new TypeError("message"), {"code": 42, "cause": ...})` |

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

| JS Value | Where it throws | Behavior |
|----------|----------------|----------|
| `symbol` | `preprocess()` (Pass 1) | Throws `TypeError('unable to serialize symbol')` — already thrown by structured-clone before `toTypeScript()` sees it |
| `function` | `toTypeScript()` (Pass 2) | Throws `TypeError('unable to serialize function')` — `preprocess()` converts functions to `["function", {name}]` marker tuples for RPC method discovery, but `toTypeScript()` detects these tuples during the walk and throws because a marker object would produce misleading tsc errors against function-typed properties |
| Native `Request` | Throws `Error` | Use `RequestSync` instead |
| Native `Response` | Throws `Error` | Use `ResponseSync` instead |

**`-0` (negative zero)**: Not supported. `@lumenize/structured-clone` loses `-0` during JSON round-trip (becomes `+0`). Since `toTypeScript()` consumes the same intermediate format, `-0` will never reach this function in a Lumenize Mesh/Nebula pipeline. Users of `toTypeScript()` outside Lumenize should be aware that `-0` is not preserved.

**Sparse arrays**: `preprocess()` converts sparse arrays (e.g., `[1, , 3]`) to dense arrays with `undefined` at the holes (e.g., `[1, undefined, 3]`). This is because its `for (let i = 0; i < value.length; i++)` loop accesses `value[i]` directly, which returns `undefined` for holes. This differs from native `structuredClone()` which preserves holes, but is consistent with JSON semantics (`JSON.stringify` also loses sparseness). The difference is harmless for `toTypeScript()` — both produce valid TypeScript. Not a concern for this phase.

**Error handling strategy**: `preprocess()` preserves error `name`, `message`, `stack`, `cause`, and custom properties (via `Object.getOwnPropertyNames`). `toTypeScript()` uses this data selectively:

- **`name`** → Constructor selection, mirroring `@lumenize/structured-clone`'s `globalThis[error.name] || Error` fallback pattern:
  - **Standard names** (`Error`, `TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`, `URIError`, `EvalError`) → emit the matching constructor: `new TypeError(...)`. These are always available in tsc's scope.
  - **Non-standard names** (e.g., `"AppError"`, `"ValidationError"`) → fall back to `new Error(...)` and preserve the `name` as a custom property via `Object.assign`: `Object.assign(new Error("msg"), {"name": "AppError", ...})`. This ensures the output always compiles regardless of what type definitions the user provides. If the user types the property as just `Error`, it works. If they type it as `interface AppError extends Error { name: "AppError"; code: number }`, tsc checks the structural shape including the preserved `name`. Compatible with Phase 5.2.2's guidance that "tsc checks structural shape, not class identity" (see `tasks/nebula-5.2.2-validate.md` Error Type Behavior section).
- **`message`** → Always emitted as the constructor argument.
- **`cause`** → Emitted recursively via `Object.assign`. Users may type `{ cause: SpecificError }` and tsc should check it.
- **Custom properties** (`code`, `statusCode`, etc.) → Emitted via `Object.assign`. This is the key value — without custom properties, type checking against `interface ApiError extends Error { code: number }` would incorrectly fail.
- **`stack`** → Skipped. Runtime-specific string, typed as `string | undefined` on `Error`. Never meaningful for schema validation.

For standard errors with no custom properties or cause, the output is a simple constructor call: `new TypeError("message")`. When custom properties, cause, or non-standard name exist, the output uses `Object.assign`:

```typescript
// Standard name + custom properties
Object.assign(new TypeError("network failure"), {"code": 500, "cause": new Error("timeout")})

// Non-standard name (fallback to Error, name preserved)
Object.assign(new Error("validation failed"), {"name": "AppError", "code": 422})
```

**Excess property checking note**: `Object.assign` does not trigger tsc's excess property checking — the result type is the intersection of the target and source types. This means extra properties on errors won't be caught. This is acceptable because: (1) the main value is verifying required custom properties exist with correct types, and (2) error objects rarely have typo-prone hand-constructed properties in the way plain data objects do.

## Testing Strategy

### Round-Trip Echo Tests in Node.js

Two complementary test approaches, chosen by type:

#### Echo Tests (content-preserving round-trip)

For types where the TypeScript output preserves the actual value content:

1. **Serialize**: Call `toTypeScript(value, typeName)` to produce a TypeScript program
2. **Compile**: Use `ts.createProgram()` to compile the TypeScript to JavaScript
3. **Evaluate**: Execute the compiled JS via `vm.runInNewContext()` and extract the constructed value
4. **Compare**: Assert the returned value deeply equals the original

This catches subtle bugs where the TypeScript output compiles but doesn't reconstruct the value faithfully (e.g., wrong Date format, lost Map entries).

**Eval scope**: Most constructors are already available in `vm.runInNewContext()` in Node.js 22: `Map`, `Set`, `BigInt`, `Date`, `RegExp`, `Error`, `TypeError`, `RangeError`, `ArrayBuffer`, `DataView`, all TypedArray constructors, `Object`, `NaN`, `Infinity`. The sandbox only needs explicit injection of: `URL`, `Headers`, `RequestSync`, and `ResponseSync`.

**Applies to**: strings, numbers, booleans, null, undefined, bigint, Date, RegExp, URL, Map, Set, TypedArrays, Error (with custom properties), wrapper objects, Headers, RequestSync, ResponseSync, plain objects, arrays.

#### Type-Only Tests (structural verification)

For types where `toTypeScript()` intentionally discards content (only the type matters for validation):

1. **Serialize**: Call `toTypeScript(value, typeName)` to produce a TypeScript program
2. **Compile**: Verify it compiles without errors
3. **Evaluate**: Execute and verify `instanceof` / `byteLength` / structural properties

**Applies to**: `ArrayBuffer` (emits `new ArrayBuffer(n)` — zero-filled, size preserved, content not preserved), `DataView` (emits `new DataView(new ArrayBuffer(n))` — size/offset preserved, content not preserved).

**Why Node.js, not DWL**: `toTypeScript()` is a pure function with no Cloudflare dependencies. Testing in Node.js gives direct value comparison without HTTP serialization (which would lose fidelity on Date, Map, etc.). DWL is already proven for production use (Phase 4.1 spike); the testing environment doesn't need it. Phase 5.2.1.2 (DWL-in-vitest spike) was superseded by this decision.

**Test progression**:
- **Single-type tests**: One property per supported type (string, number, bigint, Date, RegExp, URL, Map, Set, ArrayBuffer, typed arrays, Error subtypes, Error with custom properties, wrapper objects, Headers, RequestSync, ResponseSync)
- **Special values**: `NaN`, `Infinity`, `-Infinity`, `null`, `undefined`, `0`, `""`, empty collections
- **Mixed objects**: Objects with multiple property types at varying depths
- **Cycles**: Parent→child→parent circular references (objects, arrays, Map values, Set values)
- **Aliases**: Multiple paths referencing the same object
- **Cycles + aliases combined**: Real-world-like object graphs

**Negative tests** (verify `toTypeScript()` throws or tsc catches errors):
- **Symbols**: `{ a: Symbol('x') }` — `preprocess()` throws `TypeError('unable to serialize symbol')`
- **Functions**: `{ fn: () => {} }` — `toTypeScript()` throws `TypeError('unable to serialize function')`
- **Cyclic Map keys**: Map using itself as a key — throws `TypeError('cycle in Map key not supported')`
- **Object-keyed Map value cycle**: Map with object key whose value forms a cycle — throws `TypeError('cycle fixup not supported for Map entries with non-primitive keys')`
- **Native Request/Response**: `new Request(...)` — `preprocess()` throws `Error('Cannot serialize native Request object')`

**Type-checking negative tests**: Moved to Phase 5.2.2 (`tasks/nebula-5.2.2-validate.md`). Those tests require prepending type definitions and checking tsc diagnostics, which is the `validate()` function's job. Phase 5.2.1 echo tests verify the output is valid TypeScript that faithfully reconstructs values; Phase 5.2.2 tests verify tsc catches mismatches against type definitions.

## Implementation Strategy

### Reuse `preprocess()`, Don't Reimplement the Walk

`@lumenize/ts-runtime-validator` depends on `@lumenize/structured-clone` and calls `preprocess()` to get the tagged-tuple intermediate representation (`LmzIntermediate`). This gives us battle-tested cycle/alias detection for free — the WeakMap bookkeeping, ID assignment, and reference tracking are all handled by `preprocess()`.

`toTypeScript()` then walks the tagged tuples to emit TypeScript strings. Each tag maps directly to a TS construct:

| Tagged Tuple | TypeScript Output |
|---|---|
| **Primitives (inline in root tree)** | |
| `["string", "hello"]` | `"hello"` (via `JSON.stringify()`) |
| `["number", 42]` | `42` |
| `["number", "NaN"]` | `NaN` |
| `["number", "Infinity"]` | `Infinity` |
| `["number", "-Infinity"]` | `-Infinity` |
| `["boolean", true]` | `true` |
| `["null"]` | `null` (single-element tuple — dispatch on `tuple[0]` only) |
| `["undefined"]` | `undefined` (single-element tuple — dispatch on `tuple[0]` only) |
| `["bigint", "123"]` | `BigInt("123")` |
| **References (dereference via `objects[id]`)** | |
| `["$lmz", id]` | Inline the subtree (alias) or `null as any` (cycle back-edge) |
| **Complex types (stored in `objects[]`)** | |
| `["object", obj]` | `{"key": value}` — `obj` is a plain object whose values are themselves tagged tuples (e.g., `{"name": ["string", "Alice"]}`) |
| `["array", items]` | `[item1, item2]` — `items` is an array of tagged tuples |
| `["map", entries]` | `new Map([...])` — `entries` is array of `[keyTuple, valueTuple]` pairs |
| `["set", values]` | `new Set([...])` — `values` is array of tagged tuples |
| `["date", iso]` | `new Date("...")` |
| `["regexp", {source, flags}]` | `new RegExp("...", "...")` — both `source` and `flags` escaped via `JSON.stringify()` (handles backslashes, e.g., `/test\d+/` → `new RegExp("test\\d+", "")`) |
| `["url", {href}]` | `new URL("href")` — `href` is inside a wrapper object |
| `["headers", entries]` | `new Headers([...])` — `entries` is array of `[string, string]` pairs |
| `["error", errorData]` | Standard names → `new TypeError("message")` or `Object.assign(new TypeError("message"), {...})`. Non-standard names → `Object.assign(new Error("message"), {"name": "CustomName", ...})` — mirrors structured-clone's `globalThis[name] \|\| Error` fallback. See Error handling strategy for details. |
| `["arraybuffer", {type, data, ...}]` | Shared tag for all binary types — switch on `type` field (see note below) |
| `["request-sync", data]` | `new RequestSync(data.url, {method: data.method, headers: ..., body: data.body})` — `data.headers` is a `["$lmz", id]` reference to a `["headers", ...]` tuple |
| `["response-sync", data]` | `new ResponseSync(data.body, {status: data.status, statusText: data.statusText, headers: ...})` — `data.headers` is a `["$lmz", id]` reference to a `["headers", ...]` tuple |
| **Wrapper objects (stored in `objects[]`)** | |
| `["boolean-object", value]` | `new Boolean(true)` |
| `["number-object", value]` | `new Number(42)` — also handles `"NaN"`, `"Infinity"`, `"-Infinity"` string data (same dispatch as primitive `["number", ...]`) |
| `["string-object", value]` | `new String("hello")` |
| `["bigint-object", value]` | `Object(BigInt("123"))` |
| **Non-serializable** | |
| `["function", {name}]` | Throws `TypeError('unable to serialize function')` |

**Binary types note**: ArrayBuffer, DataView, and all TypedArrays share a single `["arraybuffer", {type, data, byteOffset?, byteLength?}]` tag. The `type` property (`"ArrayBuffer"`, `"DataView"`, `"Uint8Array"`, etc.) determines which constructor to emit.

**Inline vs `["$lmz", id]`**: The walk encounters both inline tagged tuples and `["$lmz", id]` references. Only primitives (`string`, `number`, `boolean`, `null`, `undefined`, `bigint`) appear inline in the tree. All object types — including Date, RegExp, wrapper objects, Array, Object, Map, Set, Error, Headers, URL, RequestSync, ResponseSync, binary types, and functions — are stored in `intermediate.objects` behind `["$lmz", id]` references. Both are handled by the same recursive walk — inline tuples emit directly, `["$lmz", id]` dereferences first via `objects[id]`.

> **Note**: A bug in `preprocess()` previously caused Date, RegExp, and wrapper objects to return inline tuples without storing in `objects[]`, breaking alias support for these types. This was fixed in commit bd0407a (tests in `packages/structured-clone/test/aliases.test.ts`). `postprocess()` retains a `resolveValue()` fallback that can reconstruct inline tuples from the old format, but backward compatibility with old wire data is not a goal — this task is the first consumer of the intermediate format directly, so the current format is the source of truth.

### `LmzIntermediate` Structure

`preprocess()` returns `{ root, objects }`. Every object gets an ID; `root` is a tree of `["$lmz", id]` nodes interspersed with primitive tuples, and `objects[id]` holds the actual tuple data for each object. To reconstruct the tree, the walk follows `["$lmz", id]` → `objects[id]`. Aliases appear as two `["$lmz", id]` with the same `id` at different locations in `root`. Cycles appear when following `objects[id]` leads back to an ancestor `["$lmz", id]` that's currently being processed.

**Implementation note**: `preprocess()` only serializes own enumerable properties on plain objects (via `Object.keys()`), matching native `structuredClone()` behavior. Inherited properties are not included.

**Path tracking note**: `preprocess()` already maintains a `PathElement[]` parameter for its transform hook, but `toTypeScript()` cannot reuse those paths — they describe the original object graph, not the intermediate representation. Pass 2's walk maintains its own `PathSegment[]` stack (see above) to construct fixup statements.

### 2-Pass Architecture

Two recursive tree walks — no more:

1. **Pass 1**: `preprocess(value)` → `LmzIntermediate`. Called without options — no transform hook, no `TRANSFORM_SKIP`. Symbols already throw in `preprocess()`, and functions are handled in Pass 2.
2. **Pass 2**: Single recursive walk of `intermediate.root`, dereferencing `["$lmz", id]` via `intermediate.objects[id]`. Maintains two pieces of state:
   - **`visiting: Set<number>`** — IDs currently being walked (for O(1) cycle detection). Scope-like (not ordered): IDs are added on entry and removed on exit, but lookup is O(1) by ID rather than by position. This removal is what enables alias duplication — after walking an aliased object and removing its ID, subsequent encounters re-walk (and duplicate) it rather than treating it as a cycle.
   - **`path: PathSegment[]`** — current traversal path from root, used to construct fixup statements

   `PathSegment` captures both the key and the container type:
   ```typescript
   type PathSegment =
     | { container: 'object'; key: string }         // obj["key"]
     | { container: 'array'; index: number }         // arr[0]
     | { container: 'map-value'; keyExpr: string | null }  // map.set(<keyExpr>, ...) — TS literal for primitive keys, null for object keys
     | { container: 'set'; }                         // set.add(...)
   ```

   The `keyExpr` field stores the TypeScript literal expression for the Map key, or `null` for non-primitive keys:
   - String key `"foo"` → `keyExpr: '"foo"'`
   - Number key `42` → `keyExpr: '42'`
   - Boolean key `true` → `keyExpr: 'true'`
   - Object key `{id: 1}` → `keyExpr: null` (acyclic case works fine — key is inlined in `new Map([...])` literal; only matters if a fixup is needed)

   When recording a cycle fixup, if the back-edge path includes a `map-value` segment with `keyExpr: null`, throw `TypeError('cycle fixup not supported for Map entries with non-primitive keys — use primitive Map keys')`. This defers the error to the actual problematic case: acyclic Maps with object keys work perfectly since the key is part of the inline `new Map([...])` literal and no fixup is needed. See Map/Set cycle fixups section for context.

   The walk recurses as follows:
   - **`["$lmz", id]` where `id` is in `visiting`** → **cycle back-edge** → emit `null as any` placeholder, record `{ targetPath, backEdgePath }` for fixup (both are snapshots of `path` at the target and current positions). **Exception**: if the current context is a Map key (see Map key handling below), throw `TypeError('cycle in Map key not supported')` instead of recording a fixup.
   - **`["$lmz", id]` where `id` is NOT in `visiting`** → **first visit or alias** → add `id` to `visiting`, walk `objects[id]` inline, remove `id` from `visiting`
   - **`["function", ...]`** → throw `TypeError('unable to serialize function')`
   - **Everything else** → emit TypeScript string for that tuple type (note: `["null"]` and `["undefined"]` are single-element tuples with no second element — dispatch on `tuple[0]` only)

   When walking into container children, the walk pushes a `PathSegment` before recursing and pops it after:
   - **Object** property `"foo"`: push `{ container: 'object', key: 'foo' }`, recurse, pop
   - **Array** index `2`: push `{ container: 'array', index: 2 }`, recurse, pop
   - **Map** key: recurse into the key with a `inMapKey: true` context flag (no `PathSegment` pushed — keys are inlined in the `new Map([...])` literal and have no addressable path). If the key walk encounters a cycle back-edge (`["$lmz", id]` where `id` is in `visiting`), throw `TypeError('cycle in Map key not supported')`. Acyclic object keys are walked normally and inlined.
   - **Map** value for key `"k"`: push `{ container: 'map-value', keyExpr: '"k"' }`, recurse, pop (keyExpr is the TS literal; for number key `42`: `keyExpr: '42'`)
   - **Set** element: push `{ container: 'set' }`, recurse, pop

   After the walk, assemble: `const __validate: T = {literal};` followed by one fixup statement per recorded back-edge. Each fixup is built from its recorded `targetPath` and `backEdgePath`:

   - **Object/Array back-edge**: `backEdgePath` renders as bracket notation. Example: `__validate["children"][0]["children"][0] = __validate;` (where `targetPath` is empty = root).
   - **Map value back-edge**: The last segment is `{ container: 'map-value', keyExpr }`. Everything up to the last segment renders as bracket notation, then `.set(keyExpr, target)`. Example: `__validate["myMap"].set("key", __validate);`
   - **Set back-edge**: The last segment is `{ container: 'set' }`. Everything up to the last segment renders as bracket notation. Emits two statements: first `.delete(null)` to remove the `null as any` placeholder, then `.add(target)` to insert the real reference. This ensures the Set has the correct element count after fixup. Example:
     ```typescript
     __validate["mySet"].delete(null);
     __validate["mySet"].add(__validate);
     ```

   When the back-edge target is not root, the target path also renders as bracket notation: `__validate["child"]["child"]["child"] = __validate["child"];`

### Output Structure

**File**: `src/to-typescript.ts`

```typescript
function toTypeScript(value: unknown, typeName: string): string {
  // Pass 1: Reuse structured-clone's preprocess() (symbols throw here automatically)
  const intermediate = preprocess(value);
  // Pass 2: Recursive walk of intermediate.root → objects[id]
  //   - Throws on ["function", ...] tuples
  //   - Aliases: inline (duplicate) at each use site
  //   - Cycle back-edges: null as any placeholder + fixup path recorded
  //   - Result: one object literal + zero or more fixup mutations
  return programText;
}
```

The caller (Phase 5.2.2's validator) prepends the type definition and feeds the combined program to tsc.

## Resolved Design Decisions

- **Special number handling**: `NaN`, `Infinity`, `-Infinity` are emitted as literal identifiers. tsc accepts `const x: number = NaN;` — these are global identifiers of type `number`.
- **Map/Set type parameters**: No explicit type params needed. tsc infers from the entries and checks assignability against the target type.
- **String escaping**: Use `JSON.stringify()` for string values. This handles quotes, backslashes, newlines, and unicode correctly. No fidelity loss for type checking purposes.
- **Property key format**: Object literals use JSON-style quoted keys (e.g., `{"foo-bar": value}`). Fixup path expressions use bracket notation with quoted strings (e.g., `__validate["children"][0]` not `__validate.children[0]`). Both approaches uniformly handle keys that aren't valid identifiers without needing special cases. Since this output is throwaway (never read by humans), readability is irrelevant.
- **`undefined` vs missing**: `toTypeScript()` preserves `undefined` properties explicitly (e.g., `{"a": undefined}`). Users define their types accordingly: `{a?: string}` for optional, `{a: string | undefined}` for required-but-nullable. This matches how `preprocess()` preserves `undefined` in the intermediate format.
- **`-0` (negative zero)**: Not supported — dropped by structured-clone's JSON round-trip. See note in Type Mapping section.
- **Excess property checking**: The inline-first strategy (see Design section) gives full excess property checking for all cases — acyclic, aliased, and cyclic. Aliases are duplicated within the literal; cycle back-edges use `null as any` placeholders with typed fixup mutations. The only unchecked slots are placeholders, which are immediately overwritten with correctly-typed values. Exception: errors use `Object.assign` which does not trigger excess property checking (see Known Limitations).
- **Error fidelity**: Standard error names (Error, TypeError, etc.) emit the matching constructor; non-standard names fall back to `new Error(...)` with `name` preserved as a custom property — mirroring `@lumenize/structured-clone`'s `globalThis[name] || Error` pattern. Custom properties and `cause` emitted via `Object.assign`, `stack` skipped. This ensures the output always compiles and enables type checking against custom error interfaces (`ApiError extends Error { code: number }`).
- **Nested type names / multi-resource validation**: No API change needed. Call `validate()` separately for each value-type pair: `validate(invoice, "Invoice", types)` then `validate(lineItems, "LineItem[]", types)`. The second call validates the entire array — tsc checks every element against `LineItem`. Typically 2-5 calls even for complex requests.

## Non-Goals

- **`instanceof` / class identity validation**: `toTypeScript()` validates structural shape, not class identity. `tsc` checks whether the object literal is assignable to the target type — it doesn't verify the value was constructed by a particular class. Users should define types as `interface` or `type` aliases. `declare class` in `.d.ts` files works too (it's structurally equivalent for assignability), but there's no runtime class to `instanceof` against.
- **Generic type parameter inference**: The generated program assigns a value to a typed variable (`const __validate: T = ...`). tsc doesn't infer generic parameters from this — generics must be fully resolved in the type definition. For example, use `interface TodoList { items: Todo[] }` not `interface TodoList<T> { items: T[] }`.
- **Conditional types / mapped types in validation**: Complex type-level computation (`T extends U ? X : Y`, `{ [K in keyof T]: ... }`) in user-provided type definitions may work incidentally but is not tested or supported. The target use case is straightforward structural types: interfaces, type aliases, unions, intersections, arrays, tuples, and literal types.
- **Type definition generation**: `toTypeScript()` only produces the value program. The type definitions themselves (`.d.ts` content) are authored by the user or extracted from their codebase. This phase does not generate types from values.
- **Reference identity preservation**: Aliases are duplicated in the output for excess property checking. The output is structurally equivalent but not referentially identical. This is by design (see Alias Case section).

## Known Limitations

### Output Size

The output grows linearly with alias duplication — each reference to a shared object gets its own inline copy. For typical data (2-5 aliases of small objects), this is negligible. For a 1 KB object aliased 10 times, expect ~10 KB output. Pathological cases (large object aliased hundreds of times) could produce outsized output and slow tsc compilation. If this becomes a real issue, a size-threshold fallback to `__refN` variables could be added — at the cost of losing excess property checking for those objects.

String values are NOT truncated (unlike ArrayBuffer content). String content matters for literal types (`type Status = "active" | "inactive"`) and template literal types — truncation could cause false negatives. The alias duplication strategy is the primary size driver, not individual string lengths.

### Cycle Back-Edge Placeholder Slots

`null as any` placeholders bypass type checking at their slot. The fixup mutation fills them with a correctly-typed value, but the assignment itself (e.g., `__validate["children"][0]["children"][0] = __validate`) only checks that the RHS type is assignable to the slot — it does NOT check excess properties on the RHS. This is acceptable because the RHS is `__validate` or a path into `__validate`, which is the same literal that already passed excess property checking during its construction.

### Echo Test Fidelity

Alias duplication means echo round-trip tests cannot verify reference identity (`===`). Two properties that pointed to the same object in the input will point to separate-but-equal objects in the output. Tests use deep value equality (`deepEqual`), which is sufficient for validating `toTypeScript()` correctness. Cycles DO preserve structural identity — the fixup mutations create real cycles in the evaluated JS.

Binary data (ArrayBuffer, DataView) uses type-only tests — content is not preserved because `toTypeScript()` emits size-only constructors (`new ArrayBuffer(n)`), which is sufficient for type checking.

### Cyclic Map Keys and Object-Keyed Map Cycle Fixups

**Cyclic Map keys** (e.g., a Map that uses itself as a key, or a key object containing a cycle) throw `TypeError('cycle in Map key not supported')`. Map keys have no addressable path in the output (they're inlined in the `new Map([...])` literal), so fixup statements cannot reference them. This is pathological with no real-world use case.

**Object-keyed Map value cycles**: Map cycle fixups (`.set(key, target)`) require the key to be expressible as a TypeScript literal — i.e., **primitive keys only** (string, number, boolean). Maps with object keys work fine for acyclic data (the key is inlined in the `new Map([...])` literal), but if a cycle back-edge passes through a Map *value* whose *key* is an object, the fixup `.set({...}, target)` would create a *new* object — Map uses reference equality, so this adds a new entry instead of updating the existing one. There is no workaround short of introducing `__mapKey` helper variables (which would break the inline-first strategy).

`toTypeScript()` throws `TypeError` only in the actual problematic cases: (1) cycle detected while walking a Map key, or (2) recording a cycle fixup whose path includes a `map-value` segment with a non-primitive key. Acyclic Maps with object keys are not affected. This aligns with `@lumenize/structured-clone`'s recommendation to [use primitive keys for Maps](/docs/structured-clone/maps-and-sets) — object keys have identity challenges across serialization boundaries, and cycle fixups are another such boundary.

**In practice**: data entering `toTypeScript()` in a Nebula/Mesh pipeline has already been through a `preprocess()` → wire → `postprocess()` cycle. Object Map keys survive this round-trip (reconstructed with preserved identity), but Maps with object keys whose values also form cycles are pathological — no known real-world use case.

### Error Excess Property Checking

Errors with custom properties use `Object.assign(new ErrorSubtype("msg"), {...})`. `Object.assign` does not trigger tsc's excess property checking — extra error properties won't be caught. This is acceptable because the main value is verifying required custom properties exist with correct types.

## Success Criteria

- [x] `@lumenize/structured-clone` bug fixes (prerequisite — committed):
  - [x] Date, RegExp, and wrapper objects now store in `objects[]` and return `$lmz` references (alias support fixed)
  - [x] Plain objects use `Object.keys()` instead of `for...in` (inherited properties excluded, matches `structuredClone()`)
  - [x] Binary types no longer double-assign IDs (no sparse gaps in `objects[]`)
- [ ] `packages/ts-runtime-validator/` scaffolded (`package.json`, `tsconfig.json`, `vitest.config.js`, `src/index.ts`)
- [x] `LmzIntermediate` added to `@lumenize/structured-clone`'s `index.ts` type exports (`@internal` tag removed)
- [ ] `toTypeScript(value, typeName)` produces valid TypeScript for all types supported by `@lumenize/structured-clone`
- [ ] Acyclic objects produce single `const __validate: T = literal;`
- [ ] Aliased objects are inlined (duplicated) within the literal — no `__refN` variables
- [ ] Cyclic objects produce an inline literal with `null as any` placeholders + fixup mutations
- [ ] Map cycle fixups use `.set()`; Set cycle fixups use `.delete(null)` + `.add()`
- [ ] Excess property checking works for acyclic, aliased, AND cyclic objects (test with extra properties)
- [ ] Functions in input throw `TypeError('unable to serialize function')`
- [ ] Errors emit custom properties and cause via `Object.assign` (skip stack)
- [ ] Round-trip test: `toTypeScript(value, typeName)` → prepend type definition → tsc compiles without errors for conforming values
- [ ] Echo fidelity: compile + eval round-trip produces deep-equal values (alias identity not required, cycle identity preserved)
- [ ] Type-only tests: ArrayBuffer/DataView verify instanceof and byteLength (content not preserved)
- [ ] Cyclic Map keys throw `TypeError('cycle in Map key not supported')`
- [ ] Object-keyed Map value cycles throw `TypeError('cycle fixup not supported for Map entries with non-primitive keys')`
- [ ] Negative type-checking tests moved to Phase 5.2.2 (validate task owns type-definition pairing)
- [ ] `@lumenize/structured-clone` `stringify()`/`parse()` tests unaffected
- [ ] Test coverage: >80% branch, >90% statement
