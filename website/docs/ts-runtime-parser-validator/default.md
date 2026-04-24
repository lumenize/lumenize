---
title: "@default"
description: The @default JSDoc annotation fills missing optional fields before validation runs — semantics, rules, and guidance on nested recursion.
---
# `@default`

**tl;dr** — `@default` is a Lumenize-custom JSDoc annotation (not part of typia's vocabulary) that fills missing optional fields with a JSON literal value before the validator runs. It must be on an optional field. Explicit `null` is preserved; missing or explicit `undefined` triggers the default.

---

## Fill semantics

Given this interface:

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
interface Todo {
  title: string;
  /** @default 0 */
  priority?: number;
}
```

The generated `parse()` wrapper fills `priority` before handing the value to the validator:

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
const result = await facet.parse({ title: 'Ship it' }, 'Todo');
expect(result).toEqual({
  valid: true,
  data: { title: 'Ship it', priority: 0 },  // priority filled from @default
});
```

### What counts as "missing"?

The filler applies the default if the property is either **absent** or **explicitly ****`undefined`**. Any other value — including `null`, `0`, `''`, and `false` — is preserved.

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
// Missing → default applied
const missing = await facet.parse({ title: 'x' }, 'Todo');
expect(missing.data).toMatchObject({ priority: 0 });

// Explicit undefined → default applied
const undef = await facet.parse({ title: 'x', priority: undefined }, 'Todo');
expect(undef.data).toMatchObject({ priority: 0 });

// Caller-supplied value wins (even 0, '', false)
const supplied = await facet.parse({ title: 'x', priority: 99 }, 'Todo');
expect(supplied.data).toMatchObject({ priority: 99 });
```

This keeps `null` meaningful:

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
interface Note {
  /** @default 0 */
  count?: number | null;
}
// ...
const nullResult = await facet.parse({ count: null }, 'Note');
expect(nullResult.data).toMatchObject({ count: null });  // default NOT applied
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

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
// This throws from generateParseModule():
interface X {
  /** @default 0 */
  x: number;  // required — no `?`
}
// Error: @default on required field 'X.x' — declare the field optional
//        (x?: ...) or remove the @default tag.
```

Rationale: a default on a required field is ambiguous — does the caller have to supply it or not? Making the field optional with a default answers clearly: the caller may omit it, and the system fills it. This may mean additional null checking in any code that consumes a parsed value. We may upgrade to address this in the future.

## Nested recursion

`@default` recurses through the full value graph. Defaults on nested interfaces fire when the nested value is present but incomplete; defaults on array-valued fields fire when the array is missing entirely (per-element defaults fire when individual elements are present but incomplete).

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
interface Address {
  street: string;
  /** @default "US" */
  country?: string;
}

interface User {
  name: string;
  address?: Address;
}
// ...
// Nested object: default fires inside the nested shape
const nested = await facet.parse({ name: 'Alice', address: { street: '1 Main' } }, 'User');
expect(nested.data).toMatchObject({
  name: 'Alice',
  address: { street: '1 Main', country: 'US' },
});
```

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
interface Tagged {
  /** @default [] */
  tags?: string[];
}
// ...
// Missing array → empty array
const tagged = await facet.parse({}, 'Tagged');
expect(tagged.data).toMatchObject({ tags: [] });
```

Containers of inline or named-interface types are walked element-by-element, so per-element defaults fire on every entry. This works for `Array<T>` / `T[]`, `Set<T>`, and `Map<K, T>` (plus the `Readonly` variants). Shown here for `Array<{...}>` only:

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
interface Config {
  servers?: Array<{
    host: string;
    /** @default 8080 */
    port?: number;
  }>;
}
// ...
const ok = await facet.parse(
  { servers: [{ host: 'a' }, { host: 'b', port: 9090 }] },
  'Config',
);
expect(ok.data).toMatchObject({
  servers: [
    { host: 'a', port: 8080 },
    { host: 'b', port: 9090 },
  ],
});
```

### Guidance — don't stack deep nested defaults

If an interface has `@default` five levels deep inside one monolithic shape, readers will struggle. Lift the nested structure into its own named interface so the defaults attach to that interface's own optional fields:

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
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
// ...
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

### Discriminated unions — recursion routes by the discriminator

When a field's declared type is a **discriminated union** (a union of inline shapes sharing a common literal-typed property), `@default` recursion inspects the discriminator at runtime and routes into the matching variant. Defaults on the chosen variant's fields fire normally; defaults on the other variant(s) don't.

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
interface Config {
  payload?:
    | {
        kind: 'retry';
        /** @default 3 */
        max?: number;
      }
    | {
        kind: 'cache';
        /** @default 60 */
        ttlSeconds?: number;
      };
}
// ...
const retry = await facet.parse({ payload: { kind: 'retry' } }, 'Config');
expect(retry.data).toMatchObject({ payload: { kind: 'retry', max: 3 } });
```

Numeric-literal discriminators (`code: 200 | 500`) and boolean-literal discriminators (`ok: true | false`) work the same way as string-literal discriminators.

## Known limitations

### Non-discriminated multi-shape unions don't recurse

When a union of inline shapes has **no common literal-typed discriminator** to disambiguate variants at runtime, `@default` recursion doesn't know which variant's defaults to apply, so nested tags don't fire. You have two fixes: add a discriminator, or split into named interfaces.

```typescript @skip-check-approved('conceptual')
// ❌ No shared discriminator — nested @default on `a.weight` won't fire.
interface Ambiguous {
  payload?:
    | { a: number; /** @default 1 */ weight?: number }
    | { b: string };
}

// ✅ Add a discriminator — see "Discriminated unions" above.
interface Clear {
  payload?:
    | { kind: 'numeric'; a: number; /** @default 1 */ weight?: number }
    | { kind: 'text'; b: string };
}

// ✅ Or split into named interfaces.
interface NumericPayload { a: number; /** @default 1 */ weight?: number; }
interface TextPayload { b: string; }
interface ClearNamed {
  payload?: NumericPayload | TextPayload;
}
```

Single non-null plus null/undefined (`{...} | null`) is handled normally — it's the common "optional inline" pattern, not a multi-shape union.

## When defaults fail validation

The filler runs before the validator, and the validator then sees the filled value. If the default literal doesn't satisfy the field type, the validator fails at the filled path:

```typescript @check-example('packages/ts-runtime-parser-validator/test/for-docs/default.test.ts')
interface Bad {
  /** @default "hello" */
  count?: number;
}
// ...
const result = await facet.parse({}, 'Bad');
expect(result).toMatchObject({
  valid: false,
  errors: [
    { path: '$input.count', expected: '(number | undefined)', value: 'hello' },
  ],
});
```

Nothing pre-checks the default against the field type at compile time — typia catches it on the first call through the filled path. Consistent error pipeline; no second error shape to learn.

## Typia's `Default<T>` vs Lumenize's `@default`

Typia has a branded type `Default<T>` for primitives. It's metadata-only (surfaces in generated JSON Schema / random-value generators); it doesn't fill missing values at parse time. `@lumenize/ts-runtime-parser-validator` adds `@default` as a JSDoc annotation that **does** fill at parse time and accepts full JSON literals (arrays, objects, nested). The two can coexist on the same field — they don't conflict.
