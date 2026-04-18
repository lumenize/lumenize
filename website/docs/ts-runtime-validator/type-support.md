---
title: Type Support & Validation Boundaries
description: Comprehensive table of supported types, how they map from JS values to TypeScript programs, and known limitations.
---
# Type Support & Validation Boundaries

**tl;dr** — `validate()` supports everything that [`@lumenize/structured-clone`](/docs/structured-clone) supports (except `RequestSync`/`ResponseSync`), plus the full TypeScript type system: generics, conditional types, template literal types, mapped types, utility types, cyclic references, and more. The only thing that throws `TypeError` is **functions**. Everything else just works.

The rest of this page is the receipts — tested examples for every category we could think of.

---

All examples on this page validate against types defined in a single `.ts` file:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
import types from './type-support-types.ts?raw';
```

## Primitive Types

| JS Value | TypeScript Emit | Notes |
| --- | --- | --- |
| `string` | `"hello"` | JSON-encoded string literal |
| `number` | `42` | Includes `NaN`, `Infinity`, `-Infinity` |
| `boolean` | `true` / `false` |  |
| `null` | `null` |  |
| `undefined` | `undefined` |  |
| `bigint` | `BigInt("9007199254740993")` | String argument preserves precision |

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface Config {
  name: string;
  count: number;
  enabled: boolean;
  label: string | null;
  extra?: string;
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const value = { name: 'test', count: 42, enabled: true, label: null };
expect(validate(value, 'Config', types).valid).toBe(true);
```

## Object and Array Types

| JS Value | TypeScript Emit | Notes |
| --- | --- | --- |
| Plain object | `{ key: value, ... }` | One property per line for clear error context |
| Nested object | `{ address: { ... } }` | Type references resolved from your definitions |
| Array | `[elem, ...]` | Element types checked individually |

Nested objects validate against referenced types:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface Address {
  street: string;
  city: string;
}

export interface Person {
  name: string;
  address: Address;
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const person = { name: 'Alice', address: { street: '123 Main', city: 'Springfield' } };
expect(validate(person, 'Person', types).valid).toBe(true);
```

Typed arrays catch wrong element types:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface NumberList {
  items: number[];
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const result = validate({ items: [1, 'two', 3] }, 'NumberList', types);
expect(result.valid).toBe(false);
```

## Union and Optional Types

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface Result {
  value: string | number;
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
expect(validate({ value: 'hello' }, 'Result', types).valid).toBe(true);
expect(validate({ value: 42 }, 'Result', types).valid).toBe(true);
```

String literal unions reject invalid values:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface Item {
  category: 'internal' | 'external';
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
expect(validate({ category: 'internal' }, 'Item', types).valid).toBe(true);
expect(validate({ category: 'external' }, 'Item', types).valid).toBe(true);
expect(validate({ category: 'other' }, 'Item', types).valid).toBe(false);
```

Optional properties accept both present and absent values:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface User {
  name: string;
  nickname?: string;
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
expect(validate({ name: 'Alice' }, 'User', types).valid).toBe(true);
expect(validate({ name: 'Alice', nickname: 'Al' }, 'User', types).valid).toBe(true);
```

## Map and Set

| JS Value | TypeScript Emit | Notes |
| --- | --- | --- |
| `Map` | `new Map([...entries])` | Constructor with entry tuples |
| `Set` | `new Set([...values])` | Constructor with value array |

Homogeneous Maps validate correctly, including wrong-type rejection:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface Scores {
  data: Map<string, number>;
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const value = { data: new Map([['alice', 95], ['bob', 87]]) };
expect(validate(value, 'Scores', types).valid).toBe(true);
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const invalid = { data: new Map<string, any>([['alice', 'not-a-number']]) };
const result = validate(invalid, 'Scores', types);
expect(result.valid).toBe(false);
```

Heterogeneous Maps with union value types work correctly — generic type parameters are extracted from your type definitions automatically:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface Mixed {
  data: Map<string, string | number>;
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const value = { data: new Map<string, string | number>([['a', 'hello'], ['b', 42]]) };
const result = validate(value, 'Mixed', types);
expect(result.valid).toBe(true);
```

## Built-in Object Types

| JS Value | TypeScript Emit | Notes |
| --- | --- | --- |
| `Date` | `new Date("2025-01-01T00:00:00.000Z")` | ISO string in constructor |
| `RegExp` | `new RegExp("pattern", "flags")` | Source and flags preserved |
| `URL` | `new URL("https://...")` | Uses `.href` |
| `Headers` | `new Headers([["key", "value"], ...])` | Entry tuples |

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface Appointment {
  when: Date;
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
expect(validate({ when: new Date() }, 'Appointment', types).valid).toBe(true);
```

## Error Types

Standard error types (`Error`, `TypeError`, `RangeError`, etc.) have built-in constructors in the minimal lib.d.ts. Custom errors are emitted structurally via `Object.assign()`.

**Define error shapes as interfaces, not classes** — tsc checks structural assignability, and `toTypeScript()` emits structural shape:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface AppError {
  name: string;
  message: string;
  statusCode: number;
}

export interface ErrorResult {
  error: AppError;
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const err = Object.assign(new Error('Not found'), { statusCode: 404 });
expect(validate({ error: err }, 'ErrorResult', types).valid).toBe(true);
```

## Binary Types

| JS Value | TypeScript Emit | Notes |
| --- | --- | --- |
| `ArrayBuffer` | `new ArrayBuffer(size)` | Size only, data not preserved |
| `DataView` | `new DataView(new ArrayBuffer(size))` | Wraps ArrayBuffer |
| `Uint8Array` | `new Uint8Array([1, 2, 3])` | All TypedArray variants supported |
| `BigInt64Array` | `new BigInt64Array([BigInt("1")])` | BigInt elements use `BigInt()` |

All eleven TypedArray variants are supported: `Int8Array`, `Uint8Array`, `Uint8ClampedArray`, `Int16Array`, `Uint16Array`, `Int32Array`, `Uint32Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array`.

## Dynamic Fields with `any`

When an interface has `any` fields, values containing Maps, Sets, Dates, and cycles all validate correctly:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support-types.ts')
export interface Flexible {
  metadata: any;
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const value = {
  metadata: {
    tags: new Set(['important']),
    scores: new Map([['test', 100]]),
    created: new Date(),
  },
};
expect(validate(value, 'Flexible', types).valid).toBe(true);
```

## Generic Types

Generic type definitions work — pass a parameterized type name like `'List<Todo>'` and tsc resolves it:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const genericTypes = `
  interface List<T> { items: T[]; }
  interface Todo { title: string; done: boolean; }
`;
const list = { items: [{ title: 'Ship it', done: false }] };
expect(validate(list, 'List<Todo>', genericTypes).valid).toBe(true);
expect(validate({ items: [42] }, 'List<Todo>', genericTypes).valid).toBe(false);
```

Generic Maps and Sets also resolve correctly:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const genericTypes = `
  interface Cache<V> { data: Map<string, V>; }
  interface Todo { title: string; done: boolean; }
`;
const cache = { data: new Map([['todo-1', { title: 'Ship it', done: false }]]) };
expect(validate(cache, 'Cache<Todo>', genericTypes).valid).toBe(true);
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const genericTypes = `
  interface UniqueCollection<T> { items: Set<T>; }
`;
const collection = { items: new Set(['a', 'b', 'c']) };
expect(validate(collection, 'UniqueCollection<string>', genericTypes).valid).toBe(true);
```

## Utility Types

The built-in lib.d.ts includes standard TypeScript utility types. They work with both your custom types and the generic `typeName` parameter:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const utilityTypes = `
  interface User { name: string; email: string; age: number; }
`;
```

**`Partial`** — makes all properties optional:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
expect(validate({ name: 'Alice' }, 'Partial<User>', utilityTypes).valid).toBe(true);
expect(validate({}, 'Partial<User>', utilityTypes).valid).toBe(true);
```

**`Pick`** — selects specific properties (rejects extras):

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
expect(validate({ name: 'Alice' }, "Pick<User, 'name'>", utilityTypes).valid).toBe(true);
expect(validate({ name: 'Alice', email: 'a@b.com' }, "Pick<User, 'name'>", utilityTypes).valid).toBe(false);
```

**`Omit`** — excludes specific properties:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
expect(validate({ name: 'Alice', email: 'a@b.com' }, "Omit<User, 'age'>", utilityTypes).valid).toBe(true);
```

**`Record`** — creates a typed dictionary:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const recordTypes = `type Roles = Record<string, boolean>;`;
expect(validate({ admin: true, user: false }, 'Roles', recordTypes).valid).toBe(true);
```

Also supported: `Required`, `Readonly`, `NonNullable`, `Exclude`, `Extract`, `Uppercase`, `Lowercase`, `Capitalize`, `Uncapitalize`.


## Advanced Types

Custom conditional types, template literal types, and custom mapped types all work — the full tsc type system is available:

**Conditional types:**

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const conditionalTypes = `
  interface Cat { meow: string; }
  interface Dog { bark: string; }
  type Pet<T> = T extends 'cat' ? Cat : Dog;
  interface Home { pet: Pet<'cat'>; }
`;
const result = validate({ pet: { meow: 'loud' } }, 'Home', conditionalTypes);
expect(result.valid).toBe(true);
```

**Template literal types:**

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const templateTypes = `
  type EventName = \`on\${'Click' | 'Hover'}\`;
  interface Handler { event: EventName; }
`;
const result = validate({ event: 'onClick' }, 'Handler', templateTypes);
expect(result.valid).toBe(true);
```

**Custom mapped types:**

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const mappedTypes = `
  interface Config { host: string; port: number; }
  type Nullable<T> = { [K in keyof T]: T[K] | null; };
  interface Settings { config: Nullable<Config>; }
`;
const result = validate({ config: { host: null, port: 8080 } }, 'Settings', mappedTypes);
expect(result.valid).toBe(true);
```

## Cyclic References

Cyclic objects are handled automatically — the serializer detects cycles and emits fixup statements:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const cyclicTypes = `
  interface TreeNode { id: number; parent: TreeNode; }
`;
const node: any = { id: 1 };
node.parent = node; // cycle

const result = validate(node, 'TreeNode', cyclicTypes);
expect(result.valid).toBe(true);
```

Object Map keys with cyclic back-references also work — the key is extracted to a variable and patched after construction:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
const cyclicMapTypes = `
  interface Parent { children: Map<Child, string>; }
  interface Child { name: string; parent: Parent; }
`;
const parent: any = { children: new Map() };
const child: any = { name: 'Alice', parent };
parent.children.set(child, 'first');
const result = validate(parent, 'Parent', cyclicMapTypes);
expect(result.valid).toBe(true);
```

## Known Limitations

### **Functions**

Functions throw `TypeError`:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/type-support.test.ts')
expect(() => validate({ fn: () => {} }, 'X', 'interface X { fn: any; }')).toThrow(TypeError);
```
