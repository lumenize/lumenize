---
title: "@default"
description: The @default JSDoc annotation fills missing optional fields before validation runs — semantics, rules, and guidance on nested recursion.
---
# `@default`

**tl;dr** — `@default` is a Lumenize-custom JSDoc annotation (not part of typia's vocabulary) that fills missing optional fields with a JSON literal value before the validator runs. It must be on an optional field. Explicit `null` is preserved; missing or explicit `undefined` triggers the default.

---

## Fill semantics

Given this interface:

```typescript @skip-check
interface Todo {
  title: string;
  /** @default 0 */
  priority?: number;
}
```

The generated `parse()` wrapper fills `priority` before handing the value to the validator:

```typescript @skip-check
const result = await facet.parse({ title: 'Ship it' }, 'Todo');
// { valid: true, data: { title: 'Ship it', priority: 0 } }
//                                           ^^^^^^^^^^^ filled
```

### What counts as "missing"?

The filler applies the default if the property is either **absent** or **explicitly `undefined`**. Any other value — including `null`, `0`, `''`, and `false` — is preserved.

```typescript @skip-check
// Missing → default applied
await facet.parse({ title: 'x' }, 'Todo');
// data.priority === 0

// Explicit undefined → default applied
await facet.parse({ title: 'x', priority: undefined }, 'Todo');
// data.priority === 0

// Caller-supplied value wins (even 0, '', false)
await facet.parse({ title: 'x', priority: 99 }, 'Todo');
// data.priority === 99
```

This keeps `null` meaningful:

```typescript @skip-check
interface Note {
  /** @default 0 */
  count?: number | null;
}
await facet.parse({ count: null }, 'Note');
// data.count === null  (default NOT applied)
```

## Grammar — JSON literals only

`@default` accepts any JSON literal. The annotation text is `JSON.parse`d as-is:

| Accepted | Example |
| --- | --- |
| number | `@default 42`, `@default -1.5e3` |
| string | `@default "hello"` (double-quoted) |
| boolean | `@default true`, `@default false` |
| null | `@default null` |
| array | `@default []`, `@default [1, 2, 3]`, `@default ["a", "b"]` |
| object | `@default {"timeout": 30}`, nested arbitrarily |

Anything that doesn't round-trip through `JSON.parse` is rejected at compile time:

| Rejected | Reason |
| --- | --- |
| `@default undefined` | not JSON |
| `@default NaN` | not JSON |
| `@default Infinity` | not JSON |
| `@default 10n` | bigint syntax |
| `@default 'x'` | single quotes |
| `@default {foo: 1}` | unquoted keys |
| `@default [1, 2,]` | trailing comma |

The error message names the type, field, and offending literal text.

## Required vs optional

`@default` on a **required** field is a hard error at compile time:

```typescript @skip-check
// This throws from generateParseModule():
interface X {
  /** @default 0 */
  x: number;  // required — no `?`
}
// Error: @default on required field 'X.x' — declare the field optional
//        (x?: ...) or remove the @default tag.
```

Rationale: a default on a required field is ambiguous — does the caller have to supply it or not? Making the field optional with a default answers clearly: the caller may omit it, and the system fills it.

## Nested recursion

`@default` recurses through the full value graph. Defaults on nested interfaces fire when the nested value is present but incomplete; defaults on array-valued fields fire when the array is missing entirely (per-element defaults fire when individual elements are present but incomplete).

```typescript @skip-check
interface Address {
  street: string;
  /** @default "US" */
  country?: string;
}

interface User {
  name: string;
  address?: Address;
}

// Nested object: default fires inside the nested shape
await facet.parse({ name: 'Alice', address: { street: '1 Main' } }, 'User');
// data.address === { street: '1 Main', country: 'US' }
```

```typescript @skip-check
interface Tagged {
  /** @default [] */
  tags?: string[];
}

// Missing array → empty array
await facet.parse({}, 'Tagged');
// data.tags === []
```

### Guidance — don't stack deep nested defaults

If an interface has `@default` five levels deep inside one monolithic shape, readers will struggle. Lift the nested structure into its own named interface so the defaults attach to that interface's own optional fields:

```typescript @skip-check
// Harder to read — defaults buried inside an inline object
interface Config {
  server?: {
    retries?: {
      /** @default 3 */
      max?: number;
      /** @default 100 */
      backoffMs?: number;
    };
  };
}

// Easier to read — defaults attached to a named interface
interface RetryConfig {
  /** @default 3 */
  max?: number;
  /** @default 100 */
  backoffMs?: number;
}

interface ServerConfig {
  retries?: RetryConfig;
}

interface Config {
  server?: ServerConfig;
}
```

The recursion is identical; the readability is not.

## When defaults fail validation

The filler runs before the validator, and the validator then sees the filled value. If the default literal doesn't satisfy the field type, the validator fails at the filled path:

```typescript @skip-check
interface Bad {
  /** @default "hello" */
  count?: number;
}

await facet.parse({}, 'Bad');
// valid: false
// errors: [{ path: '$input.count', expected: '(number | undefined)', value: 'hello' }]
```

Nothing pre-checks the default against the field type at compile time — typia catches it on the first call through the filled path. Consistent error pipeline; no second error shape to learn.

## Typia's `Default<T>` vs Lumenize's `@default`

Typia has a branded type `Default<T>` for primitives. It's metadata-only (surfaces in generated JSON Schema / random-value generators); it doesn't fill missing values at parse time. `@lumenize/ts-runtime-parser-validator` adds `@default` as a JSDoc annotation that **does** fill at parse time and accepts full JSON literals (arrays, objects, nested). The two can coexist on the same field — they don't conflict.
