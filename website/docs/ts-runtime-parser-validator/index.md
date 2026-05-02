---
title: TS Runtime Parser-Validator
description: Parse-don't-validate TypeScript runtime checks, built on typia and packaged for Cloudflare Dynamic Workers / Durable Object facets.
---
# TS Runtime Parser-Validator

:::danger Experimental
APIs may change and the code is not yet battle tested by production use
:::

You already write TypeScript interfaces. Why learn a separate schema DSL for runtime validation? Your interfaces already describe the shape — `@lumenize/ts-runtime-parser-validator` takes them as the runtime validation schema. Add JSDoc annotations for value constraints (range, format, length, pattern) and `@default` so you get back the validated, default-filled value rather than just a boolean.

Built on [typia](https://typia.io), which does the heavy lifting of turning TypeScript types into optimized validator functions.

## Why this package exists

Typia alone is excellent. But Cloudflare's [Dynamic Workers (DW)](https://blog.cloudflare.com/dynamic-workers/) paradigm opens up a use case typia doesn't address directly: **building runtime validation into your application as a user-facing capability** — your app ships the ability to define and enforce schemas, and your users (not your developers) are the ones authoring them. DW is Cloudflare's feature that opens up this use case.

This package provides a few things beyond typia:

- **Generate-once-and-reuse lifecycle.** One call at schema-registration time generates a self-contained JS module source string. Store it (KV, DO storage, R2, etc.) for repeat use whenever you need it.
- **DO facet as the runtime entry.** The generated module exports a `ParserValidator` class extending `DurableObject`. Mount it once as a [DO facet](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/) — a Dynamic Worker that shares its parent DO's isolate, so `facet.parse()` is a same-isolate RPC with no network hop. Call `facet.parse(value, typeName)` per request, or `facet.parseBatch(items)` to validate many values in a single facet hop.
- **Parse-don't-validate semantics** with first-class `@default` filling. Mirrors Zod's approach. Missing fields get filled before validation runs — recursively through plain objects, named-interface refs, `Array<T>`, `Set<T>`, `Map<K, T>` (and `Readonly` variants), and discriminated unions, so nested defaults apply at every depth.
- **Cycle and alias support.** Unmodified Typia will stack overflow when evaluating objects with cycles (the big problem) and reevaluate each alias (a sub-optimization). The rest of the Lumenize ecosystem (structured-clone, Mesh, Nebula, RPC, testing, etc.) not to mention native Workers RPC all support cycles and aliases over the wire. This upgrade means you have consistent type support across the entire ecosystem.

## Quick example

Write your schema once, in a regular `.d.ts` file with full editor support:

```typescript
@check-example('packages/ts-runtime-parser-validator/test/for-docs/index.test.ts')
// todo.d.ts
interface Todo {
  title: string;
  done: boolean;
  /** @default 0 */
  priority?: number;
}
```

Valid input comes back with defaults filled in:

```typescript
@check-example('packages/ts-runtime-parser-validator/test/for-docs/index.test.ts')
const ok = await parse({ title: 'Ship it', done: false }, 'Todo');
expect(ok).toEqual({
  valid: true,
  data: { title: 'Ship it', done: false, priority: 0 },
});
```

Invalid input returns typia's structured error list:

```typescript
@check-example('packages/ts-runtime-parser-validator/test/for-docs/index.test.ts')
const bad = await parse({ title: 42, done: 'not a boolean' }, 'Todo');
expect(bad).toMatchObject({
  valid: false,
  errors: [
    { path: '$input.title', expected: 'string', value: 42 },
    { path: '$input.done', expected: 'boolean', value: 'not a boolean' },
  ],
});
```

Wiring `parse()` into your Worker takes three steps — see [Getting Started](./getting-started). Or jump to:

- [API Reference](./api-reference) — `generateParseModule()`, the emitted `parse()`, return and error shapes
- [Type Support](./type-support) — what's supported and what isn't
- [Additional Constraints](./additional-constraints) — JSDoc annotations for range, format, length, pattern, etc.
- [`@default`](./default) — fill semantics, required/optional rule, nested recursion

## Performance

~16 ms warm end-to-end through a DO + facet SQL transaction (storage-write output gate included), ~400 transactions per second per DO instance under realistic concurrent load. See [Cloudflare DO Facets in practice](/blog/cloudflare-do-facets-in-practice) for the cold-wake and boundary-cost breakdown, and [What I got wrong about DO throughput](/blog/what-i-got-wrong-about-do-throughput) for the gate-semantics insight behind the throughput number.

## When to reach for this package

This package exists for one scenario: **you need schemas that change inside a running Cloudflare Worker Project, without redeploying.** Per-tenant schemas. User-authored types. Hot-swappable ontologies. That's the niche [typia](https://typia.io) doesn't cover and [Zod](https://zod.dev) / [Ajv](https://ajv.js.org) weren't built for.

If that's not you, pick by whether you want your types to *be* your schema:

- **TypeScript as schema, no DSL** — use [typia](https://typia.io) via a build step. Same ergonomics as this package (your interfaces are the validator), works anywhere JS runs.
- **Separate schema DSL** — use [Zod](https://zod.dev) for JS-expression schemas with a rich fluent API, or [Ajv](https://ajv.js.org) if you need JSON Schema interop.

If the first scenario *is* you — keep reading.

:::info How [Lumenize Nebula](/blog/introducing-lumenize-nebula) uses this
Nebula uses it for two jobs: (1) [parse and validate](/blog/typescript-is-the-schema) incoming resource values, and (2) let TypeScript interfaces (with JSDoc annotations) serve as [the ORM schema DSL](/blog/write-your-types-once) — the type system *is* the schema language.
:::

## Installation

```bash
npm install @lumenize/ts-runtime-parser-validator
```
