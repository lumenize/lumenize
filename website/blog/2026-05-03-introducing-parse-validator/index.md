---
title: "Introducing @lumenize/ts-runtime-parser-validator: parse, don't just validate"
slug: introducing-parse-validator
authors:
  - larry
tags:
  - architecture
  - announcement
description: Your TypeScript interfaces are the runtime validation schema. Powered by typia, with parse-not-just-validate semantics, recursive @default filling, and hosted as a Cloudflare Durable Object facet for same-isolate-RPC speed.
---
[`@lumenize/ts-runtime-parser-validator`](/docs/ts-runtime-parser-validator/) is shipping. Your TypeScript interfaces *are* the runtime validation schema — no Zod, no JSON Schema, no DSL. Powered by [typia](https://typia.io) and hosted as a Cloudflare Durable Object facet: **\~16 ms warm end-to-end through a DO + facet SQL transaction** (storage-write output gate latency included) and **\~400 transactions per second in a single DO instance** under heavy concurrent load, with `@default` filling, cycle and alias support, and per-tenant hot-swap of the schema at runtime. This post is the announcement; for the performance breakdowns, see [Cloudflare DO Facets in practice](/blog/cloudflare-do-facets-in-practice) (cold-wake, boundary cost, when-to-use) and [What I got wrong about DO throughput](/blog/what-i-got-wrong-about-do-throughput) (the gate-semantics surprise).

<!-- truncate -->

If you're new to the idea: start with [TypeScript IS the Schema](/blog/typescript-is-the-schema) for why you'd want to skip the schema DSL entirely, then [Write Your Types Once](/blog/write-your-types-once) for what it looks like when one TypeScript `.d.ts` file drives validation, storage, and relationships.

## What's in the box

Four things to know:

**1. typia under the hood.** [typia](https://typia.io) generates an ahead-of-time-compiled validator function for each of your types at schema-registration time. The bundle is ~119 KB for a 30-type ontology — small enough to hot-load per tenant.

**2. Parse, don't just validate.** The API returns `{valid: true, data: ...}` on success — the validated value, with `@default` annotations applied. Mirrors Zod's parse semantics. You stop writing "validate, then merge defaults manually" boilerplate.

```typescript
interface Todo {
  title: string;
  done: boolean;
  /** @default 0 */
  priority?: number;
}

const result = await parse({ title: 'Ship it', done: false }, 'Todo');
// {
//   valid: true,
//   data: { title: 'Ship it', done: false, priority: 0 },
// }
```

Recursion walks the full value graph — plain object nesting, named interface refs, `Array<T>` / `T[]`, `Set<T>`, `Map<K, T>` (plus `Readonly` variants), and discriminated unions (string-, number-, or boolean-literal discriminators all route to the matching variant). Defaults fire on every element, in every container, at every depth. See [the `@default` docs](/docs/ts-runtime-parser-validator/default) for the full rules around required vs optional fields and the one limitation (non-discriminated multi-shape unions).

**3. Cycles and aliases work end-to-end.** Stock typia stack-overflows on cyclic objects and re-evaluates each type alias from scratch — fine for most workloads, painful when the rest of your stack (native Workers RPC, structured-clone, plus higher-level layers like Lumenize Mesh, Nebula, and RPC) all support cycles and aliases natively. We added cycle and alias support so your types travel cleanly across every wire boundary in the system.

**4. Hosted as a Cloudflare Durable Object facet.** This is the part that makes it interesting on Cloudflare. More on it below.

## Why a DO facet

The validator is generated per schema. In a system like [Lumenize Nebula](/blog/introducing-lumenize-nebula), where each developer-user tenant provides their own type schema, possibly multiple versions of it, we need a way to load these dynamically, isolate them from each other, and call them with minimal overhead.

Four hosting options were on the table:

- **Inline in the parent Worker** — fastest call, but you can't hot-swap. Every schema change becomes a redeploy. Doesn't work for user-provided, per-tenant schema.
- **Plain Worker via Service Binding** — hot-swappable per deploy, but every call crosses a network hop (cheap, but measurable: ~5–20 ms typical), and you need to manage one Worker per schema.
- **Plain [Dynamic Worker](https://blog.cloudflare.com/dynamic-workers/)** — no per-schema deploy (load by `bundleId` on demand), but the call still crosses a network hop with roughly the same ~5–20 ms cost. Note, this package could easily be adapted to deploy this way, however...
- **Durable Object facet** — same Dynamic Worker hot-swap, but the facet shares its parent DO's V8 isolate. Calls into the validator are same-isolate RPC: a structured-clone hop and a scheduler tick, ~1.4 ms warm.

We picked facets. Same-isolate RPC is fast enough that the validator boundary disappears into the noise of the surrounding transaction. The `moduleSource` lives in DO storage keyed by `bundleId`, written once when a schema is registered — and the same DO storage is where the validated transaction's results land. Validate and commit, same isolate, same DO storage. (Cloudflare's [DO Facets launch post](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/) covers what facets are and how the pattern works generally; [our docs](/docs/ts-runtime-parser-validator/getting-started) cover wiring this specific package as one.)

## The performance story

**\~16 ms warm end-to-end through a DO + facet SQL transaction** (storage-write output gate included), **\~400 transactions per second per DO instance** under realistic concurrent load. (For the curious: the typia parse itself runs in ~50 µs and same-isolate facet RPC adds ~1.4 ms — the rest is DO mesh shape and storage commit.) Two companion posts cover the breakdowns: [Cloudflare DO Facets in practice](/blog/cloudflare-do-facets-in-practice) for cold-wake, boundary cost, and when-to-use; [What I got wrong about DO throughput](/blog/what-i-got-wrong-about-do-throughput) for the gate-semantics insight that explains the throughput number. If you're sizing a system on top of this, read both.

## What you get from TypeScript IS the Schema

You write the same `.d.ts` files you'd write anyway. [LLM familiarity/efficiency](https://blog.cloudflare.com/code-mode-mcp/), editor autocomplete, refactoring tools, generic types, mapped types, conditional types — every part of TypeScript that makes it expressive applies directly to validation. typia covers nearly the whole language and we added what wasn't supported (the [type support page](/docs/ts-runtime-parser-validator/type-support) has the receipts).

Runtime errors come back as a structured list — the same diagnostics your editor's red squiggles ultimately surface. No second schema language to learn, no codegen step in your build, no drift between the type and the validator.

```bash
npm install @lumenize/ts-runtime-parser-validator
```

Three-step wiring in the [Getting Started guide](/docs/ts-runtime-parser-validator/getting-started).
