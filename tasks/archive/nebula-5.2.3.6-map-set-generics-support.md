# Phase 5.2.3.6: Map/Set Generic Type Parameters in `toTypeScript()`

**Status**: Pending
**Package**: `packages/ts-runtime-validator/`
**Depends on**: Phase 5.2.2 (validate is implemented and tested)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`

## Problem

`Map<string, string | number>` with mixed value types fails validation because `toTypeScript()` emits `new Map([["a", "hello"], ["b", 42]])` without type parameters. tsc infers `V` from the first entry — if it's `["a", "hello"]`, tsc infers `Map<string, string>` and rejects the `number` entry. This is a real tsc limitation (fails with `lib.es5.d.ts` too), not specific to our minimal lib.

## Solution

Have `validate()` extract Map/Set generic parameters from the target type's AST and pass them to `toTypeScript()`, which emits explicit type params:

```typescript
// Before (tsc infers V from first entry):
new Map([["a", "hello"], ["b", 42]])

// After (explicit type params, tsc uses declared V):
new Map<string, string | number>([["a", "hello"], ["b", 42]])
```

### Implementation Steps

### 1. Add a type-param extraction helper

Create a function that walks the type definition AST to extract generic parameters for Map/Set properties at a given path. Reuse `ts.createSourceFile()` for AST parsing (same as `extractTypeMetadata()`).

Input: type definitions string + type name + property path
Output: map of property paths → generic param strings (e.g., `{ "data": "<string, string | number>" }`)

This can be simpler than `extractTypeMetadata()` — we only need to find `Map<K, V>` and `Set<V>` type references and extract the raw text of their type arguments.

### 2. Thread type params through `toTypeScript()`

Add an optional parameter to `toTypeScript()` for generic type overrides:

```typescript
export function toTypeScript(
  value: unknown,
  typeName: string,
  typeParams?: Map<string, string>,  // property path → generic params string
): string
```

When emitting a Map/Set, check if there are type params for the current `path` and emit them.

### 3. Wire it up in `validate()`

In `validate()`, extract type params from the type definitions before calling `toTypeScript()`:

```typescript
const genericParams = extractGenericParams(strippedDefs, typeName);
const generatedProgram = toTypeScript(value, typeName, genericParams);
```

### 4. Unskip the heterogeneous Map test

`packages/ts-runtime-validator/test/map-heterogeneous.test.ts` line 86 has a skipped test waiting for this.

## Testing

- Unskip existing heterogeneous Map test
- Add: heterogeneous Set (if applicable)
- Add: nested Map inside object
- Add: Map inside array
- Add: Map with no type params in definition (should still work as before)
- Verify all existing Map/Set tests still pass

## When Complete

Update `website/docs/ts-runtime-validator/type-support.mdx` to remove the heterogeneous Map limitation warning.
