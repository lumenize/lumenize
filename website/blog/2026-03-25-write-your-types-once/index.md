---
title: "Write Your Types Once"
slug: write-your-types-once
authors: [larry]
tags: [architecture]
description: "You've been writing the same types four times — as TypeScript interfaces, Zod schemas, Prisma models, and SQL DDL. What if you just wrote them once?"
draft: false
---

You've been writing the same types four times.

Once as a TypeScript interface. Once as a Zod schema for validation. Once as a Prisma model for your ORM. Once as SQL for your database. Four representations of the same thing, maintained separately, drifting silently.

Here's what that looks like for a simple `Todo` with an `assignedTo` relationship:

<!-- truncate -->

## The Validation Tax

### TypeScript — 10 lines, 105 characters

```typescript
interface Person {
  name: string;
  email: string;
}

interface Todo {
  title: string;
  done: boolean;
  assignedTo: Person[];
}
```

### Zod — 12 lines, 236 characters

```typescript
const PersonSchema = z.object({
  name: z.string(),
  email: z.string(),
});

const TodoSchema = z.object({
  title: z.string(),
  done: z.boolean(),
  assignedTo: z.array(PersonSchema),
});

type Person = z.infer<typeof PersonSchema>;
type Todo = z.infer<typeof TodoSchema>;
```

### JSON Schema — 24 lines, 530 characters

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "definitions": {
    "Person": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "email": { "type": "string" }
      },
      "required": ["name", "email"]
    }
  },
  "properties": {
    "title": { "type": "string" },
    "done": { "type": "boolean" },
    "assignedTo": {
      "type": "array",
      "items": { "$ref": "#/definitions/Person" }
    }
  },
  "required": ["title", "done", "assignedTo"],
  "additionalProperties": false
}
```

That's 105 characters, then 236, then 530 — all to say "title is a string, done is a boolean, assignedTo is an array of Person." Zod is 2x the characters and still needs `z.infer` to get the TypeScript types back out. JSON Schema is 5x, with `$ref`, `definitions`, and `items` just to express an array of another type.

With [`@lumenize/ts-runtime-validator`](/docs/ts-runtime-validator/), the TypeScript interface *is* the validation schema. No Zod. No JSON Schema. Just the interface you already wrote.

## The ORM Tax

Now add persistence. The TypeScript is identical — the same 10 lines, 105 characters from above. But look at what Prisma and SQL need for a many-to-many relationship:

### Prisma — 25 lines, 490 characters

```prisma
model Person {
  id    String @id @default(uuid())
  name  String
  email String
  todos TodoPerson[]
}

model Todo {
  id         String  @id @default(uuid())
  title      String
  done       Boolean @default(false)
  assignedTo TodoPerson[]
}

model TodoPerson {
  id       String @id @default(uuid())
  todo     Todo   @relation(
    fields: [todoId],
    references: [id])
  todoId   String
  person   Person @relation(
    fields: [personId],
    references: [id])
  personId String
}
```

### SQL — 17 lines, 345 characters

```sql
CREATE TABLE Persons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE Todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE TodoPersons (
  id TEXT PRIMARY KEY,
  todoId TEXT NOT NULL REFERENCES Todos(id),
  personId TEXT NOT NULL REFERENCES Persons(id)
);
```

The TypeScript is still 10 lines, 105 characters — two interfaces, one relationship, done. Prisma needs 25 lines and 490 characters: an explicit join model with `@relation` directives, foreign key fields, and duplicate ID declarations. SQL needs 17 lines and 345 characters across three `CREATE TABLE` statements. The many-to-many relationship that's just `assignedTo: Person[]` in TypeScript becomes an entire join table you maintain by hand.

With [Nebula](/blog/introducing-lumenize-nebula), the TypeScript interface drives the storage layer. Your interfaces define the tables, the columns, and the relationships. No `.prisma` files. No SQL DDL. The framework reads your types and handles the rest.

## The Real Cost

The problem isn't just verbosity. It's **drift**.

When you change the TypeScript interface, do you remember to update the Zod schema? The Prisma model? The SQL migration? In practice, they diverge. A field gets added to the interface but not the schema. A column gets renamed in Prisma but not in the type. The bugs are silent until they're not.

Every additional representation is a place where your system's understanding of its own data can fracture. The fix isn't better tooling to keep them in sync. The fix is to stop duplicating them.

## One Type, Multiple Uses

The vision behind Nebula is simple: **write your TypeScript interfaces once, and derive everything else from them.**

- **Validation** — [`@lumenize/ts-runtime-validator`](/docs/ts-runtime-validator/) runs the real tsc compiler against your interfaces. [No DSL, real diagnostics](/blog/typescript-is-the-schema).
- **Storage** — Nebula reads your type definitions to create tables, manage columns, and enforce constraints on Cloudflare Durable Objects.
- **Relationships** — `extractTypeMetadata()` finds references between your interfaces and models them as foreign keys automatically.
- **Write shapes** — When an interface references another type, write operations accept IDs instead of nested objects. The "write shape" is derived from your types, not maintained separately.

You write this:

```typescript
interface Person {
  name: string;
  /** @format email */
  email: string;
}

interface Todo {
  title: string;
  /** @default false */
  done: boolean;
  /**
   * @min 0
   * @max 5
   * @default 0
   */
  priority: number;
  assignedTo: Person[];
}
```

Nebula sees: `done` defaults to `false`. `priority` is between 0 and 5 with a default of 0. `email` must be a valid email. `assignedTo` is a one-to-many relationship with `Person`. Type-checking, defaults, value constraints, relationships, and storage — all from one interface with standard JSDoc annotations. No Zod `.min()`, no Prisma `@default()`, no SQL `CHECK` constraints.

:::note
JSDoc value constraints are on the roadmap. Type validation and defaults work today. The annotations shown here reflect our planned approach — standard JSDoc that your editor already understands.
:::

## Why Now

Three things made this possible:

1. **Cloudflare's tsc findings** — Code Mode [proved](https://blog.cloudflare.com/code-mode/) LLMs work better with TypeScript than JSON Schema. [32-81% fewer tokens](https://blog.cloudflare.com/code-mode-mcp/) with better accuracy. If TypeScript is the best schema language for LLMs, why translate it into something else?

2. **Bundled tsc in Workers** — The TypeScript compiler runs in Cloudflare Workers. A [1ms spike](https://blog.cloudflare.com/dynamic-workers/) proved it's fast enough for runtime validation.

3. **Durable Objects with SQL storage** — Cloudflare's DO platform gives each object its own SQLite database. The storage layer is simple enough that TypeScript interfaces can drive it directly — no need for the abstraction layers that traditional ORMs provide.

## The Tradeoff

This approach costs ~3.4 MB of bundle size and ~40-50 MB of memory per validation call. That's real. For size-constrained environments or heavy format/range validation, Zod remains excellent.

But for the solopreneur or intrapreneur building with AI-assisted coding — the person who needs their tool to work the way they think, not a team of developers to maintain four representations of every type — writing your types once is worth it.

---

*This post is the second in a series. The first, [TypeScript IS the Schema](/blog/typescript-is-the-schema), covers the runtime validation package in detail.*
