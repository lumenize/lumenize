---
title: API Reference
description: Function signatures, generated-module exports, return and error shapes for @lumenize/ts-runtime-parser-validator.
---
# API Reference

## `generateParseModule()`

Generates a JS module source string from a string of TypeScript interface definitions. The emitted module is self-contained: it bakes in typia-generated validators, baked-in `@default` values and relationship metadata, and a `ParserValidator` class extending `DurableObject`. It has zero runtime dependency on typia.

Call once per schema version at registration time. Cache the returned string keyed by a bundle ID.

```typescript @skip-check
export function generateParseModule(
  // TypeScript interface definitions as a string.
  typeDefinitions: string,
): string;
```

**Returns:** A JS module source string ready to mount via Worker Loader.

**Throws:**
- `Error` if no top-level interfaces are found in `typeDefinitions`.
- `Error` if the type definitions contain compile errors that prevent emit.
- `Error` if a `@default` annotation appears on a required field (see [`@default` → Required vs optional](./default#required-vs-optional)).
- `SyntaxError` if the type definitions can't be parsed.
- `Error` if a typia helper surfaces that isn't currently inlined (happens on typia upgrades). The message names the offending import line; the fix is to extend `typia-runtime-helpers.ts`.

### Example

```typescript @skip-check
import { generateParseModule } from '@lumenize/ts-runtime-parser-validator';

const moduleSource = generateParseModule(`
  interface Todo {
    title: string;
    done: boolean;
    /** @default 0 */
    priority?: number;
  }
`);
// Pass moduleSource to Worker Loader — see Getting Started.
```

## Generated module exports

The source returned from `generateParseModule()` has two exports and one default export:

- `ParserValidator` (named export) — a class extending `DurableObject`. Load via `worker.getDurableObjectClass('ParserValidator')`.
- `validators` (named export) — an object keyed by interface name; each value is a typia-generated validator function. You usually call `facet.parse()` rather than touching this directly.
- default export — a minimal `fetch` handler that returns `"ok"`. Required by Worker Loader to satisfy the Worker module contract.

## `ParserValidator#parse()`

The method you'll actually call at request time.

```typescript @skip-check
parse(value: unknown, typeName: string): ParseResult;
```

**Parameters:**
- `value` — any JavaScript value to validate. Crosses the facet boundary via Workers RPC, so `Date`, `Map`, `Set`, `RegExp`, `TypedArray`, and cyclic references are preserved.
- `typeName` — the name of one of the top-level interfaces in the original `typeDefinitions`.

**Returns:**

```typescript @skip-check
type ParseResult =
  | { valid: true;  data: unknown }
  | { valid: false; errors: ValidationError[] };

interface ValidationError {
  path: string;        // JSON-pointer-like path: '$input.address.city'
  expected: string;    // The expected type, e.g. 'string', '(number | undefined)'
  value: unknown;      // The offending value
  description?: string; // Optional typia-supplied note
}
```

On success, `data` is the input with any `@default` values filled in (see [`@default`](./default)).

On failure, `errors` is a list — one entry per failing field, in document order. Unknown type names return a single-entry error list:

```typescript @skip-check
const result = await facet.parse({}, 'NotATypeName');
// {
//   valid: false,
//   errors: [{
//     path: '$',
//     expected: 'NotATypeName',
//     value: {},
//     description: 'unknown type'
//   }]
// }
```

### `valid: true` — success

```typescript @skip-check
const result = await facet.parse(
  { title: 'Ship it', done: false },
  'Todo',
);
// { valid: true, data: { title: 'Ship it', done: false, priority: 0 } }
```

### `valid: false` — type mismatch

```typescript @skip-check
const result = await facet.parse(
  { title: 42, done: 'not a boolean' },
  'Todo',
);
// {
//   valid: false,
//   errors: [
//     { path: '$input.title', expected: 'string',  value: 42 },
//     { path: '$input.done',  expected: 'boolean', value: 'not a boolean' }
//   ]
// }
```

### `valid: false` — missing required field

```typescript @skip-check
const result = await facet.parse({ title: 'only title' }, 'Todo');
// {
//   valid: false,
//   errors: [
//     { path: '$input.done', expected: 'boolean', value: undefined }
//   ]
// }
```

### `valid: false` — constraint violation

```typescript @skip-check
// interface Person { /** @minimum 13 */ age: number; }
const result = await facet.parse({ age: 12 }, 'Person');
// {
//   valid: false,
//   errors: [
//     { path: '$input.age', expected: 'number & Minimum<13>', value: 12 }
//   ]
// }
```

See [Additional Constraints](./additional-constraints) for the full list of JSDoc annotations and the typia types they compile into.

## `ParserValidator#getTypeMetadata()`

Returns the defaults map and relationship graph the generated module has baked in. Used by Lumenize Nebula for transaction-time relationship resolution; most callers don't need this.

```typescript @skip-check
getTypeMetadata(): {
  defaults: Record<string, Record<string, unknown>>;
  relationships: Record<string, Record<string, {
    target: string;
    cardinality: 'one' | 'many';
    optional: boolean;
  }>>;
};
```
