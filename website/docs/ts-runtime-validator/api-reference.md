---
title: API Reference
description: Function signatures, types, and error message guidance for @lumenize/ts-runtime-validator.
---
# API Reference

## `validate()`

Validates a JavaScript value against TypeScript type definitions at runtime by running the real TypeScript compiler.

```typescript
@check-example('packages/ts-runtime-validator/src/validate.ts')
export function validate(
  value: unknown,  // Any JavaScript value to validate
  typeName: string,  // Name of the interface/type to validate against
  typeDefinitions: string,  // TypeScript interface/type definitions as a string
): ValidationResult {
```

```typescript
@check-example('packages/ts-runtime-validator/src/validate.ts')
export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationError[] };
```

```typescript
@check-example('packages/ts-runtime-validator/src/validate.ts')
export interface ValidationError {
  message: string;
  code: number;
  source: 'type-definitions' | 'value';
  line?: number;
  property?: string;
}
```

**Throws:**
- `TypeError` if `typeDefinitions` is empty or whitespace-only, or if a function type is specified
- `RangeError` if combined program size exceeds 256 KB

Internally, `validate()` calls [`toTypeScript()`](#totypescript-to-debug-failures) to generate a program, strips `export`/`import` keywords from the type definitions, then runs both through the tsc compiler:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/todo.ts')
export interface Todo {
  title: string;
  done: boolean;
}
```

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/api-reference.test.ts')
import todoTypes from './todo.ts?raw';
```

:::tip
You can import from either `.ts` or `.d.ts` files — `validate()` strips `export` and `import` keywords automatically, so your existing source files work directly.
:::

**Valid:**
```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/api-reference.test.ts')
const result: ValidationResult = validate(
  { title: 'Ship it', done: false },
  'Todo',
  todoTypes,
);
expect(result).toEqual({ valid: true });
```

**Wrong type:**
```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/api-reference.test.ts')
const result = validate({ title: 42, done: false }, 'Todo', todoTypes);
expect(result.valid).toBe(false);
expect(result.errors[0].message)
  .toBe("Type 'number' is not assignable to type 'string'. → title: 42");
```

**Missing property:**
```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/api-reference.test.ts')
const result = validate({ title: 'Ship it' }, 'Todo', todoTypes);
expect(result.valid).toBe(false);
expect(result.errors[0].message)
  .toBe("Property 'done' is missing in type '{ title: string; }' but required in type 'Todo'. → const __validate: Todo = {");
```

**Excess property:**
```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/api-reference.test.ts')
const result = validate({ title: 'Ship it', done: false, extra: true }, 'Todo', todoTypes);
expect(result.valid).toBe(false);
expect(result.errors[0].message)
  .toBe("Object literal may only specify known properties, and 'extra' does not exist in type 'Todo'. → extra: true");
```

**Bad type definitions** — the `source` field distinguishes between errors in your value (`'value'`) and errors in the type definitions themselves (`'type-definitions'`):

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/api-reference.test.ts')
const badTypes = `interfce Todo { title: string; }`;
const result = validate({ title: 'hi' }, 'Todo', badTypes);

expect(result.valid).toBe(false);
expect(result.errors[0].source).toBe('type-definitions');
```

The `code` field on each error is a standard [TypeScript diagnostic code](https://github.com/microsoft/TypeScript/blob/main/src/compiler/diagnosticMessages.json) — search for any code (e.g., "TS2322") in the TypeScript documentation for details.

## `toTypeScript()` (to debug failures)

You typically don't need to call this directly — `validate()` calls it internally. It's useful for debugging what the tsc compiler sees when validation fails.

It converts a JavaScript value to a TypeScript program string suitable for type-checking with tsc.

```typescript
@check-example('packages/ts-runtime-validator/src/to-typescript.ts')
export function toTypeScript(
  value: unknown,  // The value to serialize
  typeName: string,  // The TypeScript type name to assign to
  // ...
): string {
```

**Returns:** A valid TypeScript program string with one property per line for clear error context.

**Throws:** `TypeError` if the value contains functions, cyclic Map keys, or object-keyed Map value cycles.

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/api-reference.test.ts')
const program = toTypeScript({ title: 'Ship it', done: false }, 'Todo');
expect(program).toBe(`const __validate: Todo = {
  title: "Ship it",
  done: false,
};`);
```

Rich types like Maps and Dates are emitted as constructor calls:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/api-reference.test.ts')
const program = toTypeScript(
  new Map([['key', 'value']]),
  'Map<string, string>',
);
expect(program).toContain('new Map(');
```

## `extractTypeMetadata()` (to use TypeScript as ORM DSL)

Extracts relationship metadata from TypeScript interfaces — used internally by [Nebula](/blog/introducing-lumenize-nebula)'s data layer. You may find it useful if you're building your own ORM or data-modeling layer on top of type definitions. This is a fast, compile-free operation (~0ms) — it parses the AST but does not run tsc type-checking.

```typescript
@check-example('packages/ts-runtime-validator/src/extract-type-metadata.ts')
export function extractTypeMetadata(
  // TypeScript interface definitions as a string
  typeDefinitions: string,
): TypeMetadata {
```

**Returns:** `TypeMetadata` — contains `relationships` and `writeShapeTypeDefinitions`:

```typescript
@check-example('packages/ts-runtime-validator/src/extract-type-metadata.ts')
export interface TypeMetadata {
  // ...
  relationships: Record<string, Record<string, Relationship>>;
  // ...
  writeShapeTypeDefinitions: string;
}
```

- `relationships` — nested map: `relationships[InterfaceName][propertyName]` gives a `Relationship`
- `writeShapeTypeDefinitions` — modified type definitions where relationship references are replaced with `string` or `string[]`

```typescript
@check-example('packages/ts-runtime-validator/src/extract-type-metadata.ts')
export interface Relationship {
  target: string;
  cardinality: 'one' | 'many';
  optional: boolean;
}
```

**Throws:** `SyntaxError` if the type definitions cannot be parsed.

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/api-reference.test.ts')
// ...
const meta = extractTypeMetadata(types);

// Author has a "many" relationship to Book
expect(meta.relationships['Author']['books']).toEqual({
  target: 'Book',
  cardinality: 'many',
  optional: false,
});

// Book has a "one" relationship to Author
expect(meta.relationships['Book']['author']).toEqual({
  target: 'Author',
  cardinality: 'one',
  optional: false,
});
```

Write-shape type definitions replace relationship references with string IDs, useful for validating write payloads where related entities are referenced by ID:

```typescript
@check-example('packages/ts-runtime-validator/test/for-docs/api-reference.test.ts')
// ...
const meta = extractTypeMetadata(types);

// Write shapes replace relationship refs with string IDs
expect(meta.writeShapeTypeDefinitions).toContain('books: string[]');
expect(meta.writeShapeTypeDefinitions).toContain('author: string');
```

