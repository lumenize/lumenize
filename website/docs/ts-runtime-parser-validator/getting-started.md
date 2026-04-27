---
title: Getting Started
description: Wire up @lumenize/ts-runtime-parser-validator in a Cloudflare Worker — generate the parse module, load as a DO facet, call parse().
---
# Getting Started

**tl;dr** — `generateParseModule(types: string)` returns a JS module source string. A Worker Loader mounts that source as a module; a DO facet loads the module's `ParserValidator` class; your supervisor DO calls `facet.parse(value, typeName)` per request. Generate once per schema version and reuse on each request.

---

## Install

```bash
npm install @lumenize/ts-runtime-parser-validator
```

Set up `wrangler.jsonc` with a Worker Loader binding and a Durable Object for your supervisor:

```jsonc @check-example('packages/ts-runtime-parser-validator/test/for-docs/getting-started/wrangler.jsonc')
{
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "worker_loaders": [
    { "binding": "LOADER" }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "SUPERVISOR", "class_name": "SupervisorDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SupervisorDO"] }
  ]
}
```

## The three-step flow

### 1. Generate the parse module

Write your schema once, in a regular `.d.ts` file (full editor support, real type-checking, zero DSL):

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/getting-started/schema.d.ts')
// schema.d.ts
interface Address {
  street: string;
  city: string;
  /** @default "US" */
  country?: string;
}

interface User {
  name: string;
  home: Address;
}
```

Call `generateParseModule()` once per schema version with the raw source. Store the returned string keyed by a bundle ID (a content hash, a version number, or a tenant ID — whatever fits your lifecycle).

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/getting-started/index.test.ts')
import { generateParseModule } from '@lumenize/ts-runtime-parser-validator';
import schemaTypes from './schema.d.ts?raw';

const moduleSource = generateParseModule(schemaTypes);
// Persist moduleSource by bundleId (KV, DO storage, etc.).
```

The emitted module has zero runtime dependency on typia — everything needed was inlined during generation.

### 2. Load the module as a DO facet

Inside your supervisor DO, use `getParserValidatorFacet()` to mount the generated module as a DO facet. The helper wraps the Worker Loader + facet setup. Your per-request code only supplies `bundleId` and a callback that returns the `moduleSource` — the callback only runs on a cold Worker build, so per-request calls skip it entirely, avoiding the associated ["created daily" charges](https://developers.cloudflare.com/dynamic-workers/pricing/#dynamic-workers-created-daily).

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

  registerModuleSource(bundleId: string, moduleSource: string) {
    this.ctx.storage.kv.put(`parser:${bundleId}`, moduleSource);
  }
}
```

Two things worth knowing:

- **`bundleId`** identifies this particular generated module. Re-use the same ID to re-use the same cached Worker and facet; change it to swap in a new validator.
- **Where ****`moduleSource`**** lives is your choice.** The callback returns it from wherever fits your lifecycle — DO storage (above), a KV namespace binding, R2, an RPC to a coordinator service. The callback can be sync (as above, where `ctx.storage.kv.get` is sync) or `async` — the helper awaits whatever you return. It only runs when Cloudflare needs to (re)build the Worker for this `bundleId`.

### 3. Call `parse()` and handle the result

Valid input comes back with `@default` values filled in — including nested defaults (`country` on the embedded `Address`):

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/getting-started/index.test.ts')
const ok = await supervisor.parse(bundleId, {
  name: 'Alice',
  home: { street: '1 Main', city: 'Springfield' },
}, 'User');
expect(ok).toEqual({
  valid: true,
  data: {
    name: 'Alice',
    home: { street: '1 Main', city: 'Springfield', country: 'US' },
  },
});
```

Invalid input returns typia's structured error list:

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/getting-started/index.test.ts')
const bad = await supervisor.parse(bundleId, {
  name: 42,
  home: { street: '1 Main', city: 'Springfield' },
}, 'User');
expect(bad).toMatchObject({
  valid: false,
  errors: [
    { path: '$input.name', expected: 'string', value: 42 },
  ],
});
```

Values cross via Workers RPC (structured-clone semantics), so `Date`, `Map`, `Set`, `RegExp`, `TypedArray`, and cyclic references all survive the boundary.

On success, `data` is the input with any `@default` values filled in. On failure, `errors` is one entry per failing field, with JSON-pointer-like paths (`$input.home.city`). See [API Reference](./api-reference#parservalidatorparse) for the full `ParseResult` and `ValidationError` shapes.

#### Validating many values at once

When you have several values to check, prefer `parseBatch` — it makes one facet RPC call instead of one per value, which matters in DO contexts where every hop opens an input gate. Items can target different `typeName`s in the same call:

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/getting-started/index.test.ts')
const items = new Map<string, ParseRequest>([
  ['user-a', { value: { name: 'Alice', home: { street: '1 Main', city: 'SF' } }, typeName: 'User' }],
  ['user-b', { value: { name: 'Bob', home: { street: '2 Elm', city: 'NY' } }, typeName: 'User' }],
]);
const out = await supervisor.parseBatch(bundleId, items);
```

The result `Map` shares the input keys, so you correlate per-item results back via `out.get(key)`. See [`parseBatch()`](./api-reference#parservalidatorparsebatch) for the full surface.

## Next steps

- [API Reference](./api-reference) — full signatures and options
- [Type Support](./type-support) — what TypeScript constructs work at runtime
- [Additional Constraints](./additional-constraints) — JSDoc annotations for format, range, length, pattern, etc.
- [`@default`](./default) — fill semantics and recursion rules
