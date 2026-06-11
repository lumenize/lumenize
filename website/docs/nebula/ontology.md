---
title: Ontology
description: How you define resource types in Nebula — the .d.ts schema, per-type configuration, references, and how the ontology becomes a runtime parser-validator.
draft: true
---

# Ontology

:::warning Outline only
This page is a stub outlining planned content. Sections list what they'll cover but bodies are not yet written. Drafting begins after the `coding-your-ui.md` manual review pass and a separate review of `resources.md` and `api-reference.md`.
:::

The **ontology** is the single declaration of what resource types exist in your Nebula app, what shape each one has, how it references other types, and how it behaves under conflict. It's the first conversation Studio has with a user-developer — before any UI work happens, you and Studio agree on the data model. From the LLM's point of view, the ontology is the cornerstone context for everything else.

## What an ontology is

- A `.d.ts`-style TypeScript file (one file per app, or one per type with a barrel — open question, see below).
- Defines resource types via standard TypeScript `interface` / `type` declarations.
- Annotated with JSDoc-style tags (`@title`, `@description`, `@inverse`, etc.) that Studio's LLM and the runtime parser-validator both consume.
- Compiled at deploy time by [typia](https://typia.io) into a runtime parser-validator (see [@lumenize/ts-runtime-parser-validator](../ts-runtime-parser-validator/index.md) for the compilation pipeline).
- The single source of truth: the server validates every transaction against it; the client uses it for typed `store.resources.<type>` access (typed access is a planned addition — currently `Record<string, any>`).

> **Open**: file layout. Single `ontology.d.ts` per app vs. per-type files (`Todo.d.ts`, `TodoList.d.ts`, ...) with a barrel `ontology/index.d.ts`. The single-file form is simpler for small apps and easier for the LLM to consult; per-type files scale better for large apps and co-locate the type with its resolver. Probably let Studio pick based on app size; document both shapes.

## Defining a type

Will show:

- `interface MyType { ... }` shape declarations.
- Primitive fields (`string`, `number`, `boolean`, `Date`, ULID/UUID `string` typedefs).
- Embedded objects and arrays of embedded objects.
- Optional vs required (`field?:` vs `field:`) — per the project's `optional-over-nullable` preference, default to `field?: T`, not `field: T | null`.
- Default values (via TypeScript's default-value tricks or annotations — open: which mechanism to prefer).
- Constraints: numeric ranges, string patterns, enum literal unions, etc. (via typia tags).

> **Open**: how to express constraints. typia supports JSDoc tags like `@minimum 0`, `@pattern "..."`, but also branded types. Both work; need to pick a canonical idiom for Studio's LLM to use consistently.

## References between types

Will show:

- Foreign-key fields: an `id`-of-another-resource pattern with type-level enforcement.
- When to use embedded objects vs separate referenced resources (cardinality, sharing, update frequency).
- The `@inverse` annotation for declaring back-references (e.g., `User.todos` is the inverse of `Todo.ownerId`).
- One-to-one, one-to-many, many-to-many — how each shows up in the ontology and on the store.
- Reference integrity: the server enforces "referenced resource exists" at transaction time; how that surfaces as a `'validation-failed'` resolution.

## Annotations

Two categories of annotation, named consistently within each category:

- **Pure-config annotations** — named after the knob they set. Example: `@debounce(quietMs, maxWaitMs)`.
- **Semantic field-shape annotations** — named after what the field IS. Effects derive from the shape and may span multiple concerns. Example: `@longform`.

The asymmetry is intentional. Config-named annotations are unambiguous about scope ("ah, this sets debounce"). Semantic-named annotations let the framework decide what behaviors that shape implies, so the user-developer declares intent once and gets multiple right defaults across resolver registration, debounce timing, UI rendering, etc.

### Inventory

| Annotation | Category | Effect |
|---|---|---|
| `@title` | metadata | Display name for Studio's UI surfaces (form labels, list headers). |
| `@description` | metadata | Human/LLM explanation; Studio consults when reasoning about the type. |
| `@inverse` | reference | Back-reference declaration for relationships. |
| `@debounce(q?, m?)` | config | Debounce timing for writes to this field. `@debounce(0)` makes the field commit immediately (no debounce) — used for booleans, enums, anything click-to-commit. |
| `@longform` | semantic | This field is long-form text. Effects: slower debounce (default `quietMs: 1000`, `maxWaitMs: 5000`), auto-register a text-merge conflict resolver, Studio renders as `<textarea>` in generated UI. |
| typia validation tags (`@minimum`, `@maximum`, `@pattern`, `@format`, etc.) | validation | Standard typia constraints; see [@lumenize/ts-runtime-parser-validator](../ts-runtime-parser-validator/index.md). |

### Type-derived defaults (no annotation needed)

Most fields get sensible debounce config from their type. Studio's LLM relies on these so the user-developer doesn't have to think about timing for routine fields:

| Field type | Default debounce |
|---|---|
| `boolean` | `{ quietMs: 0 }` (eager — click-to-commit) |
| enum / literal union (e.g., `'open' \| 'done'`) | `{ quietMs: 0 }` (eager) |
| `string` (short) | inherits type default (`500` / `2000`) |
| `string` with `@longform` | inherits the `@longform` config |
| `number` | inherits type default |
| arrays / objects / embedded | inherits type default |

Explicit `@debounce(q, m)` always overrides the type-derived default.

### Example

```typescript @skip-check
interface Todo {
  /** @title("Title") */
  title: string;                  // short string → inherits type default

  /** @longform */
  description: string;            // long-form → slower debounce + text-merge + <textarea>

  done: boolean;                  // boolean → @debounce(0) implied

  status: 'open' | 'done';        // enum → @debounce(0) implied

  /** @debounce(2000, 10000) */
  notes: string;                  // explicit override — used for, e.g., journal entries
}
```

Studio's LLM, when generating the ontology, picks annotations from a small rule table (covered in [tasks/nebula-studio.md § Code Generation](https://github.com/lumenize/lumenize/blob/main/tasks/nebula-studio.md#code-generation)). The user-developer typically only sees explicit annotations during review.

### How annotations reach the runtime

The compiler (typia or our extension) reads the .d.ts at deploy time and emits a config map alongside the validator bundle. The factory loads the bundle at startup and applies the per-field debounce config to its synced-state middleware automatically. For runtime overrides (rare — A/B testing, dynamic config), [`client.resources.transactionDebounce(rt, opts)`](./api-reference.md#resourcestransactiondebounce) is the override surface.

Precedence: runtime override > ontology annotation > type-based default > framework default.

## Per-type conflict resolvers

Conflict-resolver registration is **per resource type** — the right merge strategy for a text-body field is different from the right strategy for a status enum or a set-of-tags. Conceptually the resolver is a property of the type, alongside its shape.

Will cover:

- Where the registration lives in code (see open question below).
- The handler signature and the `TransactionResourceResolution` shape (link to [Resources § Per-resource behavior](./resources.md#per-resource-behavior--the-ontransactionresourceresolution-handler) for the full union; this section just shows per-type recipes).
- Common per-type patterns and when to use each:
  - **Text-body fields** (descriptions, comments, document bodies) — register a 3-way text-merge handler. The default `'use-server'` policy will yank typing mid-keystroke during concurrent edits; text-merge preserves both edits.
  - **Set-of-tags / set-of-IDs** — `'use-this'` with set-union merge so neither client's adds get lost.
  - **Enums / IDs / single-line labels** — `'use-server'` is usually fine (default; no handler needed).
  - **High-stakes user choice** (e.g., scheduled meeting time) — `'use-this'` with async modal; user picks.
  - **Deferred-review conflicts** — `'human-in-the-loop'`; app stashes for later review.
- Resolver-as-property-of-type philosophy: when you change a type's shape, you may also need to change its resolver. Co-locating reduces the chance of drift.

> **Resolved direction (2026-05-18)**: per the [Annotations](#annotations) section above, per-type config (debounce, resolver registration, default UI rendering) flows from the ontology. For resolvers specifically, the cleanest endpoint is **annotation-driven registration** — the same compile-time pass that emits debounce config also emits resolver registration for fields/types that carry semantic annotations (`@longform` auto-registers a text-merge resolver, etc.). Custom resolvers that need code (a domain-specific merge function, a modal flow) get a sibling `resolvers.ts` (or `ontology/resolvers.ts`) that the bootstrap imports. The user-developer rarely sees this file — annotations cover the common cases. Implementation detail to settle during v3; the API surface (`client.resources.onTransactionResourceResolution(rt, handler)`) stays as-is, just with fewer direct callers now that annotations handle the typical patterns.

## Default permissions and DAG attachment

Will cover:

- Every resource has a `nodeId` at create time — which DAG (org/permission) tree node it attaches to. See [Resources § Access control](./resources.md#access-control) for the conceptual model.
- The ontology can declare a **default attachment pattern** per type. Common patterns:
  - **Per-user subtree** — every `Todo` attaches under the creating user's `user-<sub>` node (the consumer SaaS pattern from the todo-list sharing example in resources.md).
  - **Shared workspace** — every `Document` attaches under a `workspace-<id>` node specified at create time (the team-collab pattern).
  - **Tenant-root** — every resource attaches under the tenant's root (the small-app pattern with no internal grouping).
- Open: what's the annotation/declaration syntax for the default pattern. Possibly an `@attachment` tag, or a registered factory function, or just convention in the resolver/code.

## How the ontology becomes a validator

Will cover briefly (link out for depth):

- typia compiles the .d.ts at deploy time into a runtime parser-validator.
- The validator runs on every transaction (server-side, before write).
- Validation failures surface per-resource as `{ kind: 'validation-failed', errors }` in the `TransactionResourceResolution` (see [Resources § Per-resource behavior](./resources.md#per-resource-behavior--the-ontransactionresourceresolution-handler)).
- Detailed pipeline + the typia tag vocabulary live in [@lumenize/ts-runtime-parser-validator](../ts-runtime-parser-validator/index.md).
- The validator bundle ships alongside the deployed app (lock-step with `appVersion`); old clients hitting a new server get `{ kind: 'ontology-stale' }` and reload.

## When to evolve the ontology

Will cover:

- **Backward-compatible changes** — adding optional fields, adding new types, adding non-required references. Old clients keep working; new clients use the new fields.
- **Breaking changes** — removing fields, renaming, making optional fields required, changing field types. These require a coordinated `appVersion` bump.
- The `appVersion` ↔ ontology version lock-step model: server enforces that incoming transactions match its current ontology; mismatch yields `{ kind: 'ontology-stale' }` and the client reloads via `onShouldRefreshUI` (see [API reference § createNebulaClient](./api-reference.md#createnebulaclient)).
- Migrations: link to wherever the migration story ultimately lives (`tasks/nebula-5.5-branch-migrations.md` references this; the user-facing doc TBD).

## Authoring with Studio

Will cover:

- Studio's typical conversation flow: the user-developer describes their app, Studio asks clarifying questions about entities and relationships, Studio drafts the ontology, the user-developer reviews in chat (no file editor — per [nebula-studio.md § Chat-first UI direction](https://github.com/lumenize/lumenize/blob/main/tasks/nebula-studio.md)).
- How the LLM consults this doc when generating ontology files.
- What gets generated alongside: per-type resolvers (per the Q1 decision above), default attachment configuration, Studio's seed data for the dev preview.
- Iteration: when the user-developer asks for a behavior change that requires a schema change, Studio updates the ontology AND the dependent code in lock-step.
