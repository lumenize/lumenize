---
title: TS Runtime Parser-Validator
description: Parse-don't-validate TypeScript runtime checks, built on typia and packaged for Cloudflare Dynamic Workers / Durable Object facets.
---
# TS Runtime Parser-Validator

:::danger Experimental
APIs are unstable and may change significantly before the 1.0 release.
:::

You already write TypeScript interfaces. Why learn a separate schema DSL for runtime validation? Your interfaces already describe the shape — `@lumenize/ts-runtime-parser-validator` takes them as the runtime validation schema.

Built on [typia](https://typia.io), which does the heavy lifting of turning TypeScript types into optimized validator functions.

## Why this package exists

Typia alone is excellent in Node.js. But Cloudflare's [Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/) paradigm opens up a use case typia doesn't address directly: **schemas that change after deploy, inside a Worker**, per user, per tenant, or per deployed application version. Worker Loader + DO facets are the sanctioned dynamic-code path in Workers, but the generate-and-load lifecycle needs a home.

That's this package. We add four things on top of typia:

- **Generate-once-and-cache lifecycle.** One call at schema-registration time produces a self-contained JS module. Subsequent uses load it from cache.
- **DO facet as the runtime entry.** The generated module exports a `ParserValidator` class extending `DurableObject`. Load it once via Worker Loader; call `facet.parse(value, typeName)` per request.
- **Parse-don't-validate semantics** with first-class `@default` filling. Mirrors Zod's `parse`/`safeParse` API — missing optional fields get filled before validation runs.
- **Write-shape rewriting** for relationship references. If a field refers to another top-level interface (directly, via `T[]`, or via `Set<T>` / `Map<K,T>`), the generated validator expects string IDs instead of nested objects. Optional; useful for ORM-style data models.

If you're on Node.js (or anywhere outside a Worker where the schema is static), use [typia](https://typia.io) directly — it'll be simpler. This package earns its keep when the schema must be dynamic inside a Worker.

## Quick example

You supply TypeScript interface definitions as a string. `generateParseModule()` returns a JS module source string — a Worker Loader then mounts it and hands back a facet stub.

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
// Cache moduleSource by schema version. Load via Worker Loader as a DO facet.
// See the Getting Started page for the full wiring.
```

At request time, call `parse()` on the facet:

```typescript @skip-check
const result = await facet.parse({ title: 'Ship it', done: false }, 'Todo');
// { valid: true, data: { title: 'Ship it', done: false, priority: 0 } }
//                                                      ^^^^^^^^^^^^
//                                                      filled from @default
```

Invalid values come back with typia's structured error list:

```typescript @skip-check
const bad = await facet.parse({ title: 42, done: 'not a boolean' }, 'Todo');
// {
//   valid: false,
//   errors: [
//     { path: '$input.title', expected: 'string', value: 42 },
//     { path: '$input.done',  expected: 'boolean', value: 'not a boolean' }
//   ]
// }
```

See [Getting Started](./getting-started) for the full DO-facet wiring, or jump to:

- [API Reference](./api-reference) — `generateParseModule()`, the emitted `parse()`, return and error shapes
- [Type Support](./type-support) — what's supported and what isn't
- [Additional Constraints](./additional-constraints) — JSDoc annotations for range, format, length, pattern, etc.
- [`@default`](./default) — fill semantics, required/optional rule, nested recursion

## When to reach for which

Three phases matter: **build time** (app bundling), **generate time** (schema → optimized validator), and **validate time** (per-request value checking). Libraries differ mainly in when the generate step happens — ours runs it *after deploy*, inside a running Worker, which is what makes dynamic schemas possible.

|  | ts-runtime-parser-validator | typia (raw) | Zod | Ajv |
| --- | --- | --- | --- | --- |
| **Target runtime** | Cloudflare Workers (DO facet) | Node, Deno, Bun | Any JS runtime | Any JS runtime |
| **Generate time** (schema → validator) | **After deploy, inside the Worker** — from a TypeScript source string at registration time | **Build time** — typia's TS transformer rewrites call sites during `tsc` | **Module load** — schema is JavaScript code (`z.object(...)`), evaluated when the module runs | **Build time** (codegen) or **after deploy** via `ajv.compile(jsonSchema)` |
| **Schema source** | TypeScript string, supplied at request time | TypeScript types hard-coded in your source | `z.object(...)` expressions in your source | JSON Schema object |
| **Error messages** | typia's `{ path, expected, value }` | typia's `{ path, expected, value }` | Library-specific | JSON-path codes |
| **Value constraints** | JSDoc annotations (range, format, length, pattern, uniqueness) | Branded types + JSDoc | Rich (`.email()`, `.min()`, ...) | Rich (`format`, `minimum`, ...) |
| **`@default` filling** | ✓ first-class | `Default<T>` metadata (not filled) | `.default()` | Limited |
| **Reach for it when** | You need per-tenant / per-version schemas hot-swappable inside a Worker | You're on Node.js, or the schema is fixed at build time | You want rich fluent chaining with wide runtime support | You're working with JSON Schema consumers |

:::info How Lumenize Nebula uses this
Nebula applications let developers define resource types as TypeScript interfaces. Each version of that type set (an *ontology*) gets compiled once at registration time and cached on the Galaxy coordinator; Star replicas load the compiled module into a DO facet to run `parse()` per transaction. Write-shape rewriting converts nested-object relationships to string IDs so transactions carry references, not payloads. See [Lumenize Nebula](/blog/introducing-lumenize-nebula) for the full picture.
:::

## Installation

```bash
npm install @lumenize/ts-runtime-parser-validator
```
