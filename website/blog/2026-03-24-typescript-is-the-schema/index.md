---
title: "TypeScript IS the Schema: Runtime Validation Without JSON Schema or Zod"
slug: typescript-is-the-schema
authors:
  - larry
tags:
  - architecture
description: Cloudflare proved LLMs work better with TypeScript than JSON Schema. We took the next step — use TypeScript interfaces as the runtime validation schema directly. No intermediate format, no DSL, real tsc diagnostics.
---

:::info Update — April 29, 2026
The package described below now ships as [`@lumenize/ts-runtime-parser-validator`](/blog/introducing-parse-validator). Same TypeScript-as-schema idea, but ~50 µs warm parses (down from ~15–25 ms), `parse()` semantics that return the validated value with defaults filled, and hosted as a Cloudflare Durable Object facet. See the [new announcement](/blog/introducing-parse-validator) for what changed. The post below is preserved as written.
:::

Cloudflare's Code Mode team made a striking discovery: when they [converted JSON Schema to TypeScript](https://blog.cloudflare.com/code-mode/) for MCP tool definitions, LLMs performed dramatically better. The follow-up showed [32-81% token reduction](https://blog.cloudflare.com/code-mode-mcp/) with improved accuracy. And today, their [Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/) platform doubles down — TypeScript interfaces are the way agents understand APIs. As they put it: "Agents know TypeScript... with very few tokens, you can give your agent a precise understanding of your API."

That got me thinking. If TypeScript is the best way to *describe* types — for both humans and LLMs — why are we still maintaining parallel schemas in Zod or JSON Schema to *validate* them? You already write TypeScript interfaces. What if those interfaces were the runtime validation schema?

<!-- truncate -->

## The Problem with Schema Languages

Every runtime validation library requires a separate schema language. Zod has `z.infer` to derive types from schemas (avoiding duplication), but you're still writing Zod's DSL instead of plain TypeScript. JSON Schema requires a parallel definition or deriving the JSON-schema from TypeScript. Either way, you're learning and maintaining something beyond the TypeScript interfaces you already have.

```typescript
// Your TypeScript interface
interface Todo {
  title: string;
  done: boolean;
}

// Your Zod schema (must match the interface above)
const TodoSchema = z.object({
  title: z.string(),
  done: z.boolean(),
});
```

Two representations of the same thing. One is the interface you think in, the other is the DSL you validate with. What if you could skip the DSL entirely?

## TypeScript *as* the Schema

`@lumenize/ts-runtime-validator` takes a radically simple approach. Your JavaScript value is serialized to a TypeScript program, then the real TypeScript compiler type-checks it against your interface definitions.

The result: your existing TypeScript interfaces *are* the runtime validation schema. No Zod, no JSON Schema, no DSL. Just the interfaces you already write.

```typescript
import { validate } from '@lumenize/ts-runtime-validator';
import types from './types.ts?raw'; // or .d.ts — both work

const result = validate({ title: 'Ship it', done: false }, 'Todo', types);
// { valid: true }
```

When validation fails, you get real tsc diagnostics — the same error messages your editor shows:

```typescript
const result = validate({ title: 42, done: 'oops' }, 'Todo', types);
// { valid: false, errors: [
//   { message: "Type 'number' is not assignable to type 'string'. → title: 42" },
//   { message: "Type 'string' is not assignable to type 'boolean'. → done: \"oops\"" },
// ] }
```

## How It Works

The trick is `toTypeScript()`. It serializes any JavaScript value — objects, Maps, Sets, Dates, even cyclic structures — into a TypeScript program:

```typescript
import { toTypeScript } from '@lumenize/ts-runtime-validator';

toTypeScript({ title: 'Ship it', done: false }, 'Todo');
// const __validate: Todo = {
//   title: "Ship it",
//   done: false,
// };

toTypeScript(new Map([['key', 'value']]), 'Map<string, string>');
// const __validate: Map<string, string> = new Map([["key", "value"]]);
```

Then `validate()` feeds that program plus your interface definitions to the real TypeScript compiler and returns the diagnostics. The compiler does the hard work — structural assignability checking, excess property detection, union narrowing — all the things that make TypeScript's type system expressive.

## The Tradeoffs

Two real tradeoffs:

- **No value constraints yet** — tsc checks types, not ranges or string formats. There's no `.email()` or `.min(1)` today. We're [adding JSDoc-based value constraints](/blog/write-your-types-once#one-type-multiple-uses) so you can annotate `/** @format email */` directly on your interfaces — standard JSDoc that your editor already understands.
- **\~15-25ms per validation** — this is the real tsc compiler running, not a reimplementation. Fast enough for write paths (transactions, form submissions), not for per-keystroke validation.

The type coverage, on the other hand, is far broader than you might expect. The full tsc type system works: generics, conditional types, template literal types, custom mapped types, all standard utility types (`Partial`, `Pick`, `Record`, `Uppercase`, ...), Maps, Sets, Dates, cyclic references, and more. The [Type Support page](/docs/ts-runtime-parser-validator/type-support) has the receipts — tested examples for every category.

This is not (yet) a universal replacement for Zod. For heavy use of format/range validation today, Zod remains an excellent choice... at least until we implement our planed format/range validation using annotations. But when LLMs are part of your workflow — generating code, calling tools, validating data — TypeScript is the language they know best. Add zero DSL to learn and real tsc diagnostics, and the tradeoff is worth it.<sup>1</sup>

<small><sup>1</sup> Implementation note: the bundled tsc compiler is ~3.4 MB and uses ~40-50 MB of memory. On Cloudflare Workers, we run it in a [dedicated Worker via Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) so the memory stays out of your main Worker. In Node.js or other server environments, memory is not a practical concern.</small>

## Origin Story

This package grew out of building [Nebula](/blog/introducing-lumenize-nebula), an application framework for Cloudflare Durable Objects. Nebula is built for the solopreneur or intrapreneur with a small team — the mid-level manager who needs a tool that works the way they think, not a team of developers to build it. These people are already using AI-assisted coding to build real applications. Nebula makes that safer by making it [harder to build insecure software than secure software](/blog/introducing-lumenize-nebula#agentic-software-engineering-not-vibe-coding).

For that audience, every DSL is friction. We thought TypeBox would be the best tradeoff — it generates JSON Schema from TypeScript-like definitions and we [wrote extensively about healing the MCP type fracture](/blog/from-flirtation-to-vows-healing-the-mcp-type-fracture) with it. But even TypeBox requires learning its API. Zod is closer to TypeScript (and `z.infer` elegantly avoids type duplication), but it's still a DSL to learn — and one that LLMs don't know as well as plain TypeScript. What if the TypeScript they already know was enough?

The Cloudflare findings confirmed the intuition from multiple angles. Code Mode showed that [converting tool definitions to TypeScript](https://blog.cloudflare.com/code-mode/) dramatically improved LLM performance. The MCP integration showed [32-81% fewer tokens](https://blog.cloudflare.com/code-mode-mcp/) with better accuracy. And Dynamic Workers takes the logical next step — TypeScript interfaces are how agents understand entire APIs. LLMs have been trained on billions of lines of TypeScript. They know it far better than any schema DSL. TypeScript is a better type language than any DSL — for humans and LLMs alike. We just needed to run it at runtime.

## Getting Started

```bash
npm install @lumenize/ts-runtime-parser-validator
```

The [package documentation](/docs/ts-runtime-parser-validator/) covers the full API. The [Type Support & Validation Boundaries](/docs/ts-runtime-parser-validator/type-support) page has tested examples for every supported type — spoiler: it's everything except functions.

TypeScript is already the schema. Now it can be the validator too.
