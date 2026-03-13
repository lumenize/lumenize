# Phase 5.2.1: Structured-Clone `toTypeScript()` Serialization

**Status**: Pending
**Package**: `packages/ts-runtime-validator/` (`@lumenize/ts-runtime-validator`)
**Depends on**: Phase 5.2.1.1 (Wrangler Upgrade)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`

## Goal

Add a `toTypeScript()` export to `@lumenize/ts-runtime-validator` that converts any JavaScript value into a mini TypeScript program suitable for type-checking with `tsc`. This is the serialization part of the "TypeScript IS the schema" vision — `toTypeScript()` produces the program, and Phase 5.2.2's `validate()` feeds it to `tsc`. Both functions live in the same package.

## Why a Separate Package

`toTypeScript()` reuses `preprocess()` from `@lumenize/structured-clone` to get the tagged-tuple intermediate representation with cycles/aliases already resolved, then walks those tuples to emit TypeScript. This avoids reimplementing the tree walk (which was hard to get right). However, Phase 5.2.2's `validate()` bundles tsc (3.4 MB). Putting both in structured-clone would force every consumer of `stringify()`/`parse()` to pay for tsc even when they only need wire transport.

`@lumenize/ts-runtime-validator` keeps structured-clone lean and pairs the two functions that are always used together: `toTypeScript()` produces the program, `validate()` runs tsc on it. The package depends on `@lumenize/structured-clone` for `preprocess()`, `LmzIntermediate`, and the `RequestSync`/`ResponseSync` classes (used in echo tests to construct values and injected into the `vm` sandbox for evaluation).

**Prerequisite**: `LmzIntermediate` is currently exported from `preprocess.ts` but not re-exported from `@lumenize/structured-clone`'s `index.ts`. Add it to the type exports and remove the `@internal` JSDoc tag (it becomes a public type once `ts-runtime-validator` depends on it) as part of this phase's implementation.

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

// Set cycle: add the real reference (.add() is idempotent, null placeholder remains but is harmless for type checking)
__validate["mySet"].add(__validate);
```

Map *keys* that are themselves cyclic references are not supported (pathological, no real-world use case).

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
| `DataView` | `new DataView(new ArrayBuffer(8))` | Size/offset only — content not preserved |
| `Uint8Array` etc. | `new Uint8Array([1, 2, 3])` | Content preserved (element values are numeric literals) |

**Error types**:

| JS Value | TypeScript Output |
|----------|-------------------|
| `Error` (simple) | `new TypeError("message")` (constructor matches `errorData.name`) |
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

**Sparse arrays**: `preprocess()` converts sparse arrays (e.g., `[1, , 3]`) to dense arrays with `undefined` at the holes (e.g., `[1, undefined, 3]`). This differs from native `structuredClone()` which preserves holes. The difference is harmless for `toTypeScript()` (both produce valid TypeScript), and consistent with JSON semantics (`JSON.stringify` also loses sparseness). If preserving holes becomes important for structured-clone fidelity, that's a separate fix to `preprocess()`'s array handling (check `i in value` before accessing `value[i]`).

**Error handling strategy**: `preprocess()` preserves error `name`, `message`, `stack`, `cause`, and custom properties (via `Object.getOwnPropertyNames`). `toTypeScript()` uses this data selectively:

- **`name`** → Correct constructor: `new TypeError(...)`, `new RangeError(...)`, etc. Standard subtypes are structurally identical to `Error` in tsc, but we emit the right constructor for fidelity.
- **`message`** → Always emitted as the constructor argument.
- **`cause`** → Emitted recursively via `Object.assign`. Users may type `{ cause: SpecificError }` and tsc should check it.
- **Custom properties** (`code`, `statusCode`, etc.) → Emitted via `Object.assign`. This is the key value — without custom properties, type checking against `interface ApiError extends Error { code: number }` would incorrectly fail.
- **`stack`** → Skipped. Runtime-specific string, typed as `string | undefined` on `Error`. Never meaningful for schema validation.

For errors with no custom properties or cause, the output is a simple constructor call: `new TypeError("message")`. When custom properties or cause exist, the output uses `Object.assign`:

```typescript
Object.assign(new TypeError("network failure"), {"code": 500, "cause": new Error("timeout")})
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
| `["error", errorData]` | `new ErrorSubtype("message")` or `Object.assign(new ErrorSubtype("message"), {...})` — switch on `errorData.name`; emit `message` + `cause` + custom properties, skip `stack` (see Error handling strategy) |
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

> **Note**: A bug in `preprocess()` previously caused Date, RegExp, and wrapper objects to return inline tuples without storing in `objects[]`, breaking alias support for these types. This was fixed in this phase (tests in `packages/structured-clone/test/aliases.test.ts`). `postprocess()` was updated to handle both the new `$lmz` format (via first-pass object creation) and the old inline format (via `resolveValue()` fallback), so existing wire data is not broken.

### `LmzIntermediate` Structure

`preprocess()` returns `{ root, objects }`. Every object gets an ID; `root` is a tree of `["$lmz", id]` nodes interspersed with primitive tuples, and `objects[id]` holds the actual tuple data for each object. To reconstruct the tree, the walk follows `["$lmz", id]` → `objects[id]`. Aliases appear as two `["$lmz", id]` with the same `id` at different locations in `root`. Cycles appear when following `objects[id]` leads back to an ancestor `["$lmz", id]` that's currently being processed.

**Implementation note**: `preprocess()` only serializes own enumerable properties on plain objects (via `Object.keys()`), matching native `structuredClone()` behavior. Inherited properties are not included.

**Path tracking note**: `preprocess()` already maintains a `PathElement[]` parameter for its transform hook, but `toTypeScript()` cannot reuse those paths — they describe the original object graph, not the intermediate representation. Pass 2's walk maintains its own `PathSegment[]` stack (see above) to construct fixup statements.

### 2-Pass Architecture

Two recursive tree walks — no more:

1. **Pass 1**: `preprocess(value)` → `LmzIntermediate`. Called without options — no transform hook, no `TRANSFORM_SKIP`. Symbols already throw in `preprocess()`, and functions are handled in Pass 2.
2. **Pass 2**: Single recursive walk of `intermediate.root`, dereferencing `["$lmz", id]` via `intermediate.objects[id]`. Maintains two pieces of state:
   - **`visiting: Set<number>`** — IDs currently being walked (for O(1) cycle detection)
   - **`path: PathSegment[]`** — current traversal path from root, used to construct fixup statements

   `PathSegment` captures both the key and the container type:
   ```typescript
   type PathSegment =
     | { container: 'object'; key: string }    // obj["key"]
     | { container: 'array'; index: number }    // arr[0]
     | { container: 'map-value'; key: string }  // map.set("key", ...)
     | { container: 'set'; }                    // set.add(...)
   ```

   The walk recurses as follows:
   - **`["$lmz", id]` where `id` is in `visiting`** → **cycle back-edge** → emit `null as any` placeholder, record `{ targetPath, backEdgePath }` for fixup (both are snapshots of `path` at the target and current positions)
   - **`["$lmz", id]` where `id` is NOT in `visiting`** → **first visit or alias** → add `id` to `visiting`, walk `objects[id]` inline, remove `id` from `visiting`
   - **`["function", ...]`** → throw `TypeError('unable to serialize function')`
   - **Everything else** → emit TypeScript string for that tuple type (note: `["null"]` and `["undefined"]` are single-element tuples with no second element — dispatch on `tuple[0]` only)

   When walking into container children, the walk pushes a `PathSegment` before recursing and pops it after:
   - **Object** property `"foo"`: push `{ container: 'object', key: 'foo' }`, recurse, pop
   - **Array** index `2`: push `{ container: 'array', index: 2 }`, recurse, pop
   - **Map** value for key `"k"`: push `{ container: 'map-value', key: 'k' }`, recurse, pop
   - **Set** element: push `{ container: 'set' }`, recurse, pop

   After the walk, assemble: `const __validate: T = {literal};` followed by one fixup statement per recorded back-edge. Each fixup is built from its recorded `targetPath` and `backEdgePath`:

   - **Object/Array back-edge**: `backEdgePath` renders as bracket notation. Example: `__validate["children"][0]["children"][0] = __validate;` (where `targetPath` is empty = root).
   - **Map value back-edge**: The last segment is `{ container: 'map-value', key }`. Everything up to the last segment renders as bracket notation, then `.set(key, target)`. Example: `__validate["myMap"].set("key", __validate);`
   - **Set back-edge**: The last segment is `{ container: 'set' }`. Everything up to the last segment renders as bracket notation, then `.add(target)`. Example: `__validate["mySet"].add(__validate);`

   When the back-edge target is not root, the target path also renders as bracket notation: `__validate["child"]["child"]["child"] = __validate["child"];`

### Output Structure

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
- **Error fidelity**: Emit custom properties and `cause` via `Object.assign`, skip `stack`. This enables type checking against custom error classes (`ApiError extends Error { code: number }`). Simple errors with no custom properties emit as plain constructor calls.
- **Nested type names / multi-resource validation**: No API change needed. Call `validate()` separately for each value-type pair: `validate(invoice, "Invoice", types)` then `validate(lineItems, "LineItem[]", types)`. The second call validates the entire array — tsc checks every element against `LineItem`. Typically 2-5 calls even for complex requests.

## Known Limitations

### Alias Duplication Overhead

Aliased objects are inlined (duplicated) at each use site to ensure full excess property checking. For typical data this is negligible, but pathological cases (large object aliased many times) could produce outsized output and slow tsc compilation. If this becomes a real issue, a size-threshold fallback to `__refN` variables could be added — at the cost of losing excess property checking for those objects.

### Cycle Back-Edge Placeholder Slots

`null as any` placeholders bypass type checking at their slot. The fixup mutation fills them with a correctly-typed value, but the assignment itself (e.g., `__validate["children"][0]["children"][0] = __validate`) only checks that the RHS type is assignable to the slot — it does NOT check excess properties on the RHS. This is acceptable because the RHS is `__validate` or a path into `__validate`, which is the same literal that already passed excess property checking during its construction.

### Echo Test Fidelity

Alias duplication means echo round-trip tests cannot verify reference identity (`===`). Two properties that pointed to the same object in the input will point to separate-but-equal objects in the output. Tests use deep value equality (`deepEqual`), which is sufficient for validating `toTypeScript()` correctness. Cycles DO preserve structural identity — the fixup mutations create real cycles in the evaluated JS.

Binary data (ArrayBuffer, DataView) uses type-only tests — content is not preserved because `toTypeScript()` emits size-only constructors (`new ArrayBuffer(n)`), which is sufficient for type checking.

### Cyclic Map Keys

Map keys that are themselves cyclic references (e.g., a Map that uses itself as a key) are not supported. This is pathological with no real-world use case. Map *values* that are cyclic are fully supported via `.set()` fixups.

### Error Excess Property Checking

Errors with custom properties use `Object.assign(new ErrorSubtype("msg"), {...})`. `Object.assign` does not trigger tsc's excess property checking — extra error properties won't be caught. This is acceptable because the main value is verifying required custom properties exist with correct types.

## Success Criteria

- [x] `@lumenize/structured-clone` bug fixes (prerequisite — done during review):
  - [x] Date, RegExp, and wrapper objects now store in `objects[]` and return `$lmz` references (alias support fixed)
  - [x] Plain objects use `Object.keys()` instead of `for...in` (inherited properties excluded, matches `structuredClone()`)
  - [x] Binary types no longer double-assign IDs (no sparse gaps in `objects[]`)
- [ ] `packages/ts-runtime-validator/` scaffolded (`package.json`, `tsconfig.json`, `vitest.config.js`, `src/index.ts`)
- [ ] `LmzIntermediate` added to `@lumenize/structured-clone`'s `index.ts` type exports (`@internal` tag removed)
- [ ] `toTypeScript(value, typeName)` produces valid TypeScript for all types supported by `@lumenize/structured-clone`
- [ ] Acyclic objects produce single `const __validate: T = literal;`
- [ ] Aliased objects are inlined (duplicated) within the literal — no `__refN` variables
- [ ] Cyclic objects produce an inline literal with `null as any` placeholders + fixup mutations
- [ ] Map/Set cycle fixups use `.set()` / `.add()` respectively
- [ ] Excess property checking works for acyclic, aliased, AND cyclic objects (test with extra properties)
- [ ] Functions in input throw `TypeError('unable to serialize function')`
- [ ] Errors emit custom properties and cause via `Object.assign` (skip stack)
- [ ] Round-trip test: `toTypeScript(value, typeName)` → prepend type definition → tsc compiles without errors for conforming values
- [ ] Round-trip test: `toTypeScript(badValue, typeName)` → prepend type definition → tsc produces expected diagnostic for non-conforming values
- [ ] Echo fidelity: compile + eval round-trip produces deep-equal values (alias identity not required, cycle identity preserved)
- [ ] Type-only tests: ArrayBuffer/DataView verify instanceof and byteLength (content not preserved)
- [ ] `@lumenize/structured-clone` `stringify()`/`parse()` tests unaffected
- [ ] Test coverage: >80% branch, >90% statement
