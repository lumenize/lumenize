---
title: TypeScript Runtime Validator
description: TypeScript IS the schema — validate JavaScript values against TypeScript interfaces at runtime using the real tsc compiler.
---
# TypeScript Runtime Validator

You already write TypeScript interfaces. Why learn a separate schema DSL for runtime validation?

Cloudflare discovered that LLMs [perform dramatically better](https://blog.cloudflare.com/code-mode/) with TypeScript than with JSON Schema — converting MCP tool definitions to TypeScript reduced token usage by [32-81%](https://blog.cloudflare.com/code-mode-mcp/) while improving accuracy. Their [Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/) platform doubles down on this: "Agents know TypeScript... with very few tokens, you can give your agent a precise understanding of your API." This isn't surprising: LLMs have been trained on billions of lines of TypeScript, far more than any schema DSL. TypeScript is simply a more natural language for describing types — for humans and LLMs alike.

The pattern keeps showing up: the [MCP specification](https://github.com/modelcontextprotocol/typescript-sdk) defines its protocol types as TypeScript interfaces, and generates JSON Schema for wire validation. Cloudflare's new [cf CLI](https://blog.cloudflare.com/cf-cli-local-explorer/) replaces hand-maintained OpenAPI specs with a TypeScript schema that generates OpenAPI, CLI commands, and Workers bindings from a single source. As they put it: "it just works better to express APIs in TypeScript." The industry is converging on TypeScript as the canonical way to describe types.

`@lumenize/ts-runtime-validator` takes the next step: your TypeScript interfaces *are* the runtime validation schema. Your JavaScript value is serialized to a TypeScript program, the real TypeScript compiler type-checks it against your interface definitions, and you get back actual tsc diagnostics — the same error messages you see in your editor. No intermediate format, no DSL, just the interfaces you already write.

## Quick Example

Your type definitions live in a regular `.d.ts` or `.ts` file — `validate()` automatically strips `export` and `import` keywords, so you can use your existing source files directly:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/todo.d.ts')
interface Todo {
  title: string;
  done: boolean;
}
```

Import it as a raw string and validate against it:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/overview.test.ts')
import todoTypes from './todo.d.ts?raw';
// ...
const todo = { title: 'Ship it', done: false };
const result = validate(todo, 'Todo', todoTypes);
expect(result.valid).toBe(true);
```

When validation fails, you get real tsc diagnostics with a pointer to the failing input location:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/overview.test.ts')
// ...
const bad = { title: 42, done: 'not a boolean' };
const result = validate(bad, 'Todo', todoTypes);
// ...
expect(result.errors[0].message)
  .toBe("Type 'number' is not assignable to type 'string'. → title: 42");
expect(result.errors[1].message)
  .toBe("Type 'string' is not assignable to type 'boolean'. → done: \"not a boolean\"");
```

## How It Works

`toTypeScript()` serializes your JavaScript value into a TypeScript program, and `validate()` runs that program through the real TypeScript compiler against your interface definitions.

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/overview.test.ts')
const todo = { title: 'Ship it', done: false };
const program = toTypeScript(todo, 'Todo');
expect(program).toBe(`const __validate: Todo = {
  title: "Ship it",
  done: false,
};`);
```

The tsc compiler sees this program alongside your `interface Todo` — the same check your editor performs, but at runtime.

## Rich Type Support

All TypeScript type definitions are supported — Maps, Sets, Dates, cycles, aliases, utility types, etc. work out of the box:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/overview.test.ts')
// ...
const profile = {
  name: 'Alice',
  tags: new Set(['admin', 'active']),
  preferences: new Map([['theme', 'dark'], ['lang', 'en']]),
  createdAt: new Date('2025-01-01'),
};

const result = validate(profile, 'UserProfile', types);
expect(result.valid).toBe(true);
```

See the [Type Support & Validation Boundaries](./type-support) page for the full list of supported types and known limitations.

## Comparison

|  | ts-runtime-validator | Zod | Ajv (JSON Schema) |
| --- | --- | --- | --- |
| **Schema format** | Your existing TypeScript interfaces | Dedicated DSL | JSON Schema |
| **Drift risk** | None — interfaces are the schema | Low with `z.infer`, but schema is still a separate DSL | Low with codegen, but requires a build step |
| **Error messages** | Real tsc diagnostics | Library-specific messages | Cryptic nested paths |
| **Type coverage** | [Full tsc type system](./type-support) — generics, conditional types, template literals, mapped types | Wide, via Zod API | JSON-representable types only |
| **Value constraints** | Types only (no range/format checks) | Rich (`.email()`, `.min()`, `.regex()`, ...) | Rich (`format`, `minimum`, `pattern`, ...) |
| **Bundle size** | ~3.4 MB (bundled tsc) | ~50 KB | ~100 KB |
| **Memory** | ~40-50 MB per call (see below) | Minimal | Minimal |

The bundle size is the real TypeScript compiler — large relative to validation-only libraries, but a one-time download that caches well. The memory cost is easily mitigated in Cloudflare Workers by running tsc in a dedicated Worker via [Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) — each Worker gets its own 128 MB, so the tsc memory stays out of your main Worker or DO. This is what [Nebula](/docs/nebula/nebula-client) does. In Node.js or other server environments, memory is typically not a constraint.

The tradeoff is worth it when you value zero-DSL developer experience and tsc-quality diagnostics over minimal bundle size and built-in value constraints. Zod is excellent — especially with `z.infer` eliminating type duplication — but it's still a DSL to learn, and LLMs know plain TypeScript better. For heavy use of format/range validation, Zod and Ajv remain good choices.

## Installation

```bash
npm install @lumenize/ts-runtime-validator
```
