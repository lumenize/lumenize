---
title: API Reference
description: Function signatures, generated-module exports, return and error shapes for @lumenize/ts-runtime-parser-validator.
---
# API Reference

## `generateParseModule()`

Generates a JS module source string from a string of TypeScript interface definitions. The emitted module is self-contained — it bakes in the typia-generated validators, the `@default` values, and a `ParserValidator` class extending `DurableObject`. Zero runtime dependency on typia.


```typescript @check-example('packages/ts-runtime-parser-validator/src/generate-parse-module.ts')
export function generateParseModule(typeDefinitions: string): string {
  // ...
}
```

**Returns:** A JS module source string ready to mount via Worker Loader.

**Throws:**
- `Error` if no top-level interfaces are found in `typeDefinitions`.
- `Error` if the type definitions contain compile errors that prevent emit.
- `Error` if a `@default` annotation appears on a required field (see [`@default` → Required vs optional](./default#required-vs-optional)).
- `SyntaxError` if the type definitions can't be parsed.
- `Error` if a typia helper surfaces that isn't currently inlined (happens on typia upgrades). The message names the offending import line; the fix is to extend `typia-runtime-helpers.ts`.

### Example

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/api-reference.test.ts')
// todo.d.ts
interface Todo {
  title: string;
  done: boolean;
  /** @default 0 */
  priority?: number;
}
```

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/api-reference.test.ts')
import { generateParseModule } from '@lumenize/ts-runtime-parser-validator';
import todoTypes from './todo.d.ts?raw';

const moduleSource = generateParseModule(todoTypes);
// Pass moduleSource to Worker Loader — see Getting Started.
```

### Performance and lifecycle

Typia's transformer runs real `tsc` under the hood — about **1.7 s cold, 120 ms warm** for a 30-type ontology on deployed Cloudflare. This package is designed for a workflow where you generate once per schema version and reuse the result for each request that requires validation.

## Generated module exports

The source returned from `generateParseModule()` has two named exports:

- `ParserValidator` — a class extending `DurableObject`. Load via `worker.getDurableObjectClass('ParserValidator')`, or let [`getParserValidatorFacet()`](#getparservalidatorfacet) handle it for you.
- `validators` — an object keyed by interface name; each value is a typia-generated validator function. You usually call `facet.parse()` rather than touching this directly.

## `getParserValidatorFacet()`

Mount the generated module as a DO facet and get a typed stub back. Wraps the `ctx.facets.get` + `env.LOADER.get` setup so per-request code stays a single call.

```typescript @check-example('packages/ts-runtime-parser-validator/src/facet-helper.ts')
export function getParserValidatorFacet(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  bundleId: string,
  loadModuleSource: () => string | Promise<string>,
): ParserValidator {
  // ...
}
```

**Parameters:**
- `ctx` — the supervisor DO's context (usually `this.ctx` from inside a DO class).
- `loader` — the Worker Loader binding (usually `this.env.LOADER`).
- `bundleId` — stable identifier for the generated module. Re-use to re-use the cached Worker and facet; change to swap in a new validator.
- `loadModuleSource` — callback returning the module source string produced by [`generateParseModule()`](#generateparsemodule). Sync or async — `ctx.storage.kv` is sync; KV-namespace bindings, R2, and cross-Worker RPC are async. Only invoked when Cloudflare needs to (re)build the Worker for this `bundleId`; per-request calls with a matching, already-loaded `bundleId` skip it entirely.

**Returns:** a [`ParserValidator`](#parservalidatorparse) stub with one method — `parse(value, typeName): Promise<ParseResult>`.

The type signatures use the global `DurableObjectState` and `WorkerLoader` types that `wrangler types` generates. No additional type imports are needed on the caller side.

### Example

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/getting-started/index.ts')
import { DurableObject } from 'cloudflare:workers';
import {
  getParserValidatorFacet,
  type ParseResult,
} from '@lumenize/ts-runtime-parser-validator';

export class SupervisorDO extends DurableObject<Env> {
  async parse(bundleId: string, value: unknown, typeName: string): Promise<ParseResult> {
    const facet = getParserValidatorFacet(
      this.ctx,
      this.env.LOADER,
      bundleId,
      () => this.ctx.storage.kv.get(`parser:${bundleId}`) as string,
    );
    return await facet.parse(value, typeName);
  }
  // ...
}
```

See [Getting Started](./getting-started) for the complete wiring pattern including schema registration.

## `ParserValidator#parse()`

The method you'll actually call at request time. `getParserValidatorFacet()` returns a `ParserValidator` stub whose one method — `parse(value, typeName)` — returns `Promise<ParseResult>` because it crosses the facet's RPC boundary. (On the generated class itself the method is synchronous; the RPC proxy wraps it in a Promise.)

```typescript @check-example('packages/ts-runtime-parser-validator/src/facet-helper.ts')
parse(value: unknown, typeName: string): Promise<ParseResult>;
```

**Parameters:**
- `value` — any JavaScript value to validate. Crosses the facet boundary via Workers RPC, so `Date`, `Map`, `Set`, `RegExp`, `TypedArray`, and cyclic references are preserved.
- `typeName` — the name of one of the top-level interfaces in the original `typeDefinitions`.

**Returns:**

```typescript @check-example('packages/ts-runtime-parser-validator/src/facet-helper.ts')
type ParseResult =
  | { valid: true;  data: unknown }
  | { valid: false; errors: ValidationError[] };
// ...
interface ValidationError {
  path: string;        // JSON-pointer-like path: '$input.address.city'
  expected: string;    // The expected type, e.g. 'string', '(number | undefined)'
  value: unknown;      // The offending value
  description?: string; // Optional typia-supplied note
}
```

On success, `data` is the input with any `@default` values filled in (see [`@default`](./default)).

On failure, `errors` is a list — one entry per failing field, in document order. Unknown type names return a single-entry error list:

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/api-reference.test.ts')
const result = await facet.parse({}, 'NotATypeName');
expect(result).toEqual({
  valid: false,
  errors: [{
    path: '$',
    expected: 'NotATypeName',
    value: {},
    description: 'unknown type',
  }],
});
```

### `valid: true` — success

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/api-reference.test.ts')
const result = await facet.parse(
  { title: 'Ship it', done: false },
  'Todo',
);
expect(result).toEqual({
  valid: true,
  data: { title: 'Ship it', done: false, priority: 0 },
});
```

### `valid: false` — type mismatch

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/api-reference.test.ts')
const result = await facet.parse(
  { title: 42, done: 'not a boolean' },
  'Todo',
);
expect(result).toMatchObject({
  valid: false,
  errors: [
    { path: '$input.title', expected: 'string', value: 42 },
    { path: '$input.done', expected: 'boolean', value: 'not a boolean' },
  ],
});
```

### `valid: false` — missing required field

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/api-reference.test.ts')
const result = await facet.parse({ title: 'only title' }, 'Todo');
expect(result).toMatchObject({
  valid: false,
  errors: [
    { path: '$input.done', expected: 'boolean', value: undefined },
  ],
});
```

### `valid: false` — constraint violation

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/api-reference.test.ts')
// interface Person { /** @minimum 13 */ age: number; }
const result = await facet.parse({ age: 12 }, 'Person');
expect(result).toMatchObject({
  valid: false,
  errors: [
    { path: '$input.age', expected: 'number & Minimum<13>', value: 12 },
  ],
});
```

See [Additional Constraints](./additional-constraints) for the full list of JSDoc annotations and the typia types they compile into.

## `extractTypeMetadata()`

**Most users never touch this — it's here for ORM layers and other specialized callers.** Pure utility: parse TypeScript interface definitions and return the derived metadata — interface names, `@default` values, the relationship graph (which fields reference other named interfaces), and a pre-computed write-shape version of the source with those references narrowed to string IDs. Independent from `generateParseModule()`.

```typescript @check-example('packages/ts-runtime-parser-validator/src/extract-type-metadata.ts')
export function extractTypeMetadata(typeDefinitions: string): TypeMetadata {
  // ...
}
```

```typescript @check-example('packages/ts-runtime-parser-validator/src/extract-type-metadata.ts')
export interface TypeMetadata {
  interfaceNames: string[];
  relationships: Record<string, Record<string, Relationship>>;
  writeShapeTypeDefinitions: string;
  defaults: DefaultsMap;
  inlineSubtypes: Record<string, Record<string, InlineSubtype>>;
}
```

```typescript @check-example('packages/ts-runtime-parser-validator/src/extract-type-metadata.ts')
export interface InlineSubtype {
  subTypeName?: string;
  containers?: Array<'array' | 'set' | 'readonlyset' | 'map' | 'readonlymap'>;
  mapKeyTypes?: Array<string | undefined>;
  discriminator?: {
    field: string;
    variants: Record<string, string>;
  };
}
```

```typescript @check-example('packages/ts-runtime-parser-validator/src/extract-type-metadata.ts')
export interface Relationship {
  target: string;
  cardinality: 'one' | 'many';
  optional: boolean;
  container?: 'array' | 'set' | 'readonlyset' | 'map' | 'readonlymap';
  mapKeyType?: string;
}
```

**Returns:** `TypeMetadata`.

- `interfaceNames` — names of top-level interfaces, in source order.
- `relationships` — `typeName → fieldName → Relationship`. A field is a "relationship" when its declared type is another top-level interface in the same source (directly, via `T | null`, `T[]`, `Array<T>`, `Set<T>`, `ReadonlySet<T>`, `Map<K, T>`, or `ReadonlyMap<K, T>`).
- `writeShapeTypeDefinitions` — the input source with every relationship field narrowed to `string` / `string[]` / `Set<string>` / `Map<K, string>` (etc., container preserved). Useful for ORM-style callers that want validators to expect IDs instead of nested objects.
- `defaults` — `typeName → fieldName → JSON-literal value` from `@default` JSDoc tags on optional fields. Keys include synthesized path-based sub-type names for anonymous inline type literals (e.g. `"Config/server/retries"`), which the filler uses to recurse into inline shapes.
- `inlineSubtypes` — `parentTypeName → fieldName → InlineSubtype`. Populated when a field's type contains an anonymous inline type literal, directly or via `Array<{...}>` / `T[]` / `Set<{...}>` / `Map<K, {...}>` (plus the `Readonly` variants) or a nullable union (`{...} | null`). Lets the filler recurse into inline shapes — including container element types — the same way it recurses into named interfaces, so nested `@default` tags apply through both.

**Throws:** `SyntaxError` on unparseable types; `Error` if `@default` appears on a required field or the value isn't a valid JSON literal.

### Composer pattern: validate string-ID references

By default, a field whose declared type is another top-level interface validates as an **embedded object** — the same behavior typia, Zod, and Ajv give you. ORM-style callers (canonical case: Lumenize Nebula) usually want the opposite: relationship fields should validate as **string IDs**, so transactions carry references, not nested payloads. `extractTypeMetadata()`'s `writeShapeTypeDefinitions` does the narrowing for you — you hand the write-shape to `generateParseModule()` and the resulting validator expects IDs instead of objects.

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/api-reference.test.ts')
// Default behavior — named interfaces validate as embedded objects.
interface User { id: string; name: string; }
interface Team {
  lead: User;               // validates as a full User
  members: User[];          // validates as an array of full Users
  roles: Map<string, User>; // validates as a Map of full Users
}
// ...
const ok = await facet.parse(
  {
    lead: { id: 'u-1', name: 'Alice' },
    members: [{ id: 'u-1', name: 'Alice' }, { id: 'u-2', name: 'Bob' }],
    roles: new Map([['admin', { id: 'u-1', name: 'Alice' }]]),
  },
  'Team',
);
expect(ok.valid).toBe(true);
```

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/api-reference.test.ts')
// Composer pattern — pre-extract metadata, feed the write-shape to generate.
import {
  extractTypeMetadata,
  generateParseModule,
} from '@lumenize/ts-runtime-parser-validator';
import types from './schema.d.ts?raw';

const md = extractTypeMetadata(types);
// Persist md.relationships wherever your ORM keeps metadata.
const moduleSource = generateParseModule(md.writeShapeTypeDefinitions);
// Mount moduleSource as a facet. parse() now expects string IDs.
```

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/api-reference.test.ts')
// With the write-shape module, the same Team validates from string IDs.
const ok = await facet.parse(
  {
    lead: 'u-1',
    members: ['u-1', 'u-2'],
    roles: new Map([['admin', 'u-1']]),
  },
  'Team',
);
expect(ok.valid).toBe(true);
```

Container shape and key type are preserved. `Map<'admin' | 'editor', User>` becomes `Map<'admin' | 'editor', string>` — only the named-interface value is narrowed.

### Module-size tradeoff

Validating embedded named-interface objects inlines each target's full check recursively into every validator that references it. Large type graphs (many types × many cross-references) produce noticeably larger modules in the embedded path than in the write-shape path — for a 30-type / 56-edge benchmark ontology, roughly **\~830 KB embedded vs \~115 KB write-shape**. Fine for most schemas; worth knowing if you have dozens of richly cross-linked types and care about module size.
