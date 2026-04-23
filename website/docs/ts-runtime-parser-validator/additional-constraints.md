---
title: Additional Constraints
description: JSDoc annotations for format, range, length, pattern, and uniqueness constraints — on top of what the TypeScript type system already enforces.
---
# Additional Constraints

**tl;dr** — TypeScript types are the primary constraint (`string`, `number`, `'admin' | 'viewer'`, `User[]`). These JSDoc annotations add to what the type system provides — range bounds on numbers, format on strings, length on arrays, and so on. They pass through verbatim to typia, so the full [typia JSDoc vocabulary](https://typia.io/docs/validators/tags/) is available.

For filling default values, see the separate [`@default`](./default) page.

---

## How to write an annotation

Put the annotation in a JSDoc block immediately above the field:

```typescript
@skip-check
interface Person {
  /** @minimum 13 */
  age: number;
}
```

To apply multiple annotations to one field, put them in the same JSDoc block — one per line:

```typescript
@skip-check
interface Name {
  /**
   * @minLength 3
   * @maxLength 20
   */
  value: string;
}
```

Unknown annotations (e.g., `@author Alice`, `@deprecated`) are tolerated — they're left alone. Typia only reacts to the annotations listed below; everything else is documentation for humans.

:::warning Two silent footguns
Both of these drop the annotation without any error, which makes them hard to debug:

- **Inline JSDoc doesn't attach.** `interface R { /** @minimum 13 */ age: number; }` puts the comment on the same line as the field; tsc won't attach it. The block must be on its own line(s) above the field.
- **Stacked blocks — only the last one counts.** Two separate `/** ... */` blocks above a field will silently drop the earlier one. Always put multiple tags in a single block.

```typescript
@skip-check
// ❌ Stacked blocks — @minimum silently dropped
/** @minimum 1 */
/** @maximum 5 */
stars: number;

// ✅ Single block with multiple tags — both apply
/**
 * @minimum 1
 * @maximum 5
 */
stars: number;
```
:::

:::note Case sensitivity
Annotation names and values are case-sensitive except where explicitly aliased (e.g., `datetime` and `dateTime` both mean `date-time`). `@format EMAIL` is a compile-time error; write `@format email`.
:::

## Number annotations

Apply to fields typed `number` or `bigint`.

| Annotation | Value | Meaning |
| --- | --- | --- |
| `@type` | `int32`, `uint32`, `int64`, `uint64`, `float`, `double` (shortcuts: `int` → `int32`, `uint` → `uint32`) | `int*`/`uint*` reject non-integers (e.g. `2.5`); `uint*` reject negatives; bounded variants also enforce the type's value range. `float`/`double` accept any JS number |
| `@minimum N` | number | Value must be ≥ N |
| `@maximum N` | number | Value must be ≤ N |
| `@exclusiveMinimum N` | number | Value must be > N |
| `@exclusiveMaximum N` | number | Value must be < N |
| `@multipleOf N` | number | Value must be an exact multiple of N |

```typescript
@skip-check
interface Rating {
  /**
   * @minimum 1
   * @maximum 5
   * @type int32
   */
  stars: number;
}
```

```typescript
@skip-check
const bad = await facet.parse({ stars: 6 }, 'Rating');
expect(bad.valid).toBe(false);  // stars exceeds @maximum

const ok = await facet.parse({ stars: 5 }, 'Rating');
expect(ok).toEqual({ valid: true, data: { stars: 5 } });
```

## String annotations

Apply to fields typed `string`.

| Annotation | Value | Meaning |
| --- | --- | --- |
| `@format F` | one of the format IDs below | Value must match the named format |
| `@pattern REGEX` | regex source (no flags) | Value must match the regex |
| `@length N` | integer | Length must equal N exactly (sets `@minLength` and `@maxLength` together) |
| `@minLength N` | integer | String length must be ≥ N |
| `@maxLength N` | integer | String length must be ≤ N |

```typescript
@skip-check
interface Contact {
  /** @format email */
  email: string;

  /** @pattern ^[a-z0-9-]+$ */
  slug: string;
}
```

```typescript
@skip-check
const bad = await facet.parse(
  { email: 'not-an-email', slug: 'Has Spaces' },
  'Contact',
);
expect(bad.valid).toBe(false);  // both fields fail

const ok = await facet.parse(
  { email: 'alice@example.com', slug: 'hello-world' },
  'Contact',
);
expect(ok).toEqual({
  valid: true,
  data: { email: 'alice@example.com', slug: 'hello-world' },
});
```

### Accepted `@format` values

25 format IDs, drawn from typia's vocabulary:

- **Identifiers**: `uuid`
- **Email**: `email`, `idn-email`
- **Host / URL**: `hostname`, `idn-hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uri-template`, `url`, `iri`, `iri-reference`
- **Date / time**: `date-time` (aliases: `datetime`, `dateTime`), `date`, `time`, `duration`
- **JSON Pointer**: `json-pointer`, `relative-json-pointer`
- **Miscellaneous**: `byte`, `password`, `regex`

## Array annotations

Apply to fields typed as an array (`T[]`, `Array<T>`) or a set (`Set<T>`).

| Annotation | Value | Meaning |
| --- | --- | --- |
| `@items N` | integer | Length must equal N exactly (sets `@minItems` and `@maxItems` together) |
| `@minItems N` | integer | Length must be ≥ N |
| `@maxItems N` | integer | Length must be ≤ N |
| `@uniqueItems` | (no value) | No duplicate elements |

```typescript
@skip-check
interface Bag {
  /**
   * @minItems 1
   * @maxItems 10
   * @uniqueItems
   */
  tags: string[];
}
```

```typescript
@skip-check
const empty = await facet.parse({ tags: [] }, 'Bag');
expect(empty.valid).toBe(false);  // @minItems violated

const dup = await facet.parse({ tags: ['a', 'a'] }, 'Bag');
expect(dup.valid).toBe(false);  // @uniqueItems violated

const ok = await facet.parse({ tags: ['a', 'b', 'c'] }, 'Bag');
expect(ok).toEqual({ valid: true, data: { tags: ['a', 'b', 'c'] } });
```

## Fill-in annotation

One more annotation, with its own semantics: [`@default`](./default). It fills missing optional fields before the validator runs. Covered in depth on its own page because it's about input-filling rather than constraint-checking.

## Note on typia branded types

Typia also supports expressing these constraints as type-system branded types (`number & Minimum<13>`, `string & Format<"email">`). Both paths produce identical validators. This package's documentation uses the JSDoc form exclusively because:

- Interface definitions are passed as strings at runtime, so a typia `import` isn't practical.
- JSDoc is lower-friction for everyday use.
- Mixing JSDoc `@default` with branded validator tags splits the annotation surface arbitrarily.

Branded types still work — typia's transformer processes them identically — but they're not documented or tested here. If you reach for them, consult the [typia docs](https://typia.io/docs/validators/tags/) directly.
