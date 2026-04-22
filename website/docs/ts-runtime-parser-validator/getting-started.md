---
title: Getting Started
description: Wire up @lumenize/ts-runtime-parser-validator in a Cloudflare Worker — generate the parse module, load as a DO facet, call parse().
---
# Getting Started

**tl;dr** — `generateParseModule(types)` returns a JS module source string. A Worker Loader mounts that source as a module; a DO facet loads the module's `ParserValidator` class; your supervisor DO calls `facet.parse(value, typeName)` per request. Generate once per schema version and cache the result.

---

## Install

```bash
npm install @lumenize/ts-runtime-parser-validator
```

Set up `wrangler.jsonc` with a Worker Loader binding and a Durable Object for your supervisor:

```jsonc @skip-check
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

Call `generateParseModule()` once per schema version. Cache the returned string keyed by a bundle ID (a content hash, a version number, or a tenant ID — whatever fits your lifecycle).

```typescript @skip-check
import { generateParseModule } from '@lumenize/ts-runtime-parser-validator';

const types = `
  interface Todo {
    title: string;
    done: boolean;
    /** @default 0 */
    priority?: number;
  }
`;

const moduleSource = generateParseModule(types);
// Persist moduleSource by bundleId (KV, DO storage, etc.).
```

The emitted module has zero runtime dependency on typia — typia's transformer inlined the validator bodies during generation, and helper functions were inlined too.

### 2. Load the module as a DO facet

Inside your supervisor DO, use the Worker Loader binding to mount the generated source, then register a facet that extends the `ParserValidator` class the module exports.

```typescript @skip-check
import { DurableObject } from 'cloudflare:workers';

type FacetStub = {
  parse: (value: unknown, typeName: string) => Promise<ParseResult>;
};

export class SupervisorDO extends DurableObject<Env> {
  #getFacet(moduleSource: string, bundleId: string): FacetStub {
    // ctx.facets and worker.getDurableObjectClass are beta APIs.
    const ctx = this.ctx as unknown as {
      facets: {
        get: (name: string, factory: () => Promise<{ class: unknown }>) => FacetStub;
      };
    };
    return ctx.facets.get(bundleId, async () => {
      const worker = this.env.LOADER.get(bundleId, async () => ({
        compatibilityDate: '2026-04-01',
        mainModule: 'parser.js',
        modules: { 'parser.js': moduleSource },
        globalOutbound: null,
      }));
      const w = worker as unknown as {
        getDurableObjectClass: (name: string) => unknown;
      };
      return { class: w.getDurableObjectClass('ParserValidator') };
    });
  }
  // ...
}
```

Two things worth knowing:

- **`bundleId`** identifies this particular generated module. Re-use the same ID to re-use the same facet instance; a new ID spins up a fresh one. The facet stays warm as long as the supervisor DO does.
- **`mainModule: 'parser.js'`** is the filename inside the loader's virtual module graph. It doesn't have to match anything on disk — the source is the `moduleSource` string you pass.

### 3. Call `parse()`

With the facet stub in hand, call `parse(value, typeName)`. Values cross via Workers RPC (structured-clone semantics), so `Date`, `Map`, `Set`, `RegExp`, `TypedArray`, and cyclic references all survive the boundary.

```typescript @skip-check
export class SupervisorDO extends DurableObject<Env> {
  // #getFacet() as above.

  async validate(
    moduleSource: string,
    bundleId: string,
    value: unknown,
    typeName: string,
  ) {
    const facet = this.#getFacet(moduleSource, bundleId);
    return await facet.parse(value, typeName);
  }
}
```

The result is a discriminated union:

```typescript @skip-check
type ParseResult =
  | { valid: true;  data: unknown }
  | { valid: false; errors: Array<{
      path: string;
      expected: string;
      value: unknown;
      description?: string;
    }> };
```

On success, `data` is the input with any `@default` values filled in. On failure, `errors` is typia's structured error list — one entry per failing field, with JSON-pointer-like paths (`$input.address.city`).

## When to regenerate

Regenerate only when the type definitions change. Typical triggers:

- A new schema version is published.
- A new tenant comes online with their own type set.
- Local development: whenever you hot-reload.

Typia's transformer runs real `tsc` under the hood — measure ~1.7 s cold, ~120 ms warm for a 30-type ontology on deployed Cloudflare. This is why you cache.

## Next steps

- [API Reference](./api-reference) — full signatures and options
- [Type Support](./type-support) — what TypeScript constructs work at runtime
- [Additional Constraints](./additional-constraints) — JSDoc annotations for format, range, length, pattern, etc.
- [`@default`](./default) — fill semantics and recursion rules
