# Nebula Resource Metadata for AI Consumption

**Status**: Active — demo critical path
**Depends on**: 5.2.4.1 (`@lumenize/ts-runtime-parser-validator` — `extractTypeMetadata` already collects `@default` and typia-aligned constraint tags), 5.2.4.2 (Galaxy per-version ontology registry — already stores the source we need to expose)
**Companion**: `tasks/nebula-studio.md` (this is the metadata Studio's AI consumes), `tasks/on-hold/nebula-orm-and-queries.md` (the `@inverse` annotation defined here is what the post-demo query engine will use)

## Goal

Pin the JSDoc annotation conventions vibe coders use to describe their resource types to the platform AND to the AI generating their UIs, and make sure the platform exposes that information to the AI in the right shape.

**Headline decisions:**

1. **The AI gets the raw `.d.ts` source.** Not a bespoke JSON shape. LLMs read TypeScript natively; a custom shape is strictly worse. Galaxy exposes a method that returns the source string for the current (or any historical) ontology version.
2. **Three new JSDoc annotations** beyond what 5.2.4.1 already collects: `@title` (required), `@description` (optional), `@inverse` (required on relationship fields).
3. **PascalCase interface names ARE the URL slugs.** No translation to kebab-case. The interface name is the canonical identifier; translating creates a second mapping that has to stay in sync.

## Annotation set

| Annotation | Where | Required? | Notes |
|---|---|---|---|
| **`@title`** | Type and field | **Required** | Human-readable label. PascalCase interface names and camelCase field names are programmer shorthand; explicit `@title` is what the AI uses for UI labels, breadcrumbs, dropdown options, etc. |
| **`@description`** | Type and field | Optional | Free-form prose describing intent. Used by the AI for tooltips, help text, and to reason about how a resource is used. |
| **`@inverse <fieldName>`** | Relationship field | Required (when the field is a relationship) | Names the inverse field on the target type. Disambiguates 1:M from M:N. The runtime uses this for the future query engine; the AI uses it to know "if I want to display this from the other side, here's the field name." |

JSDoc body comments (text not preceded by an `@tag`) are NOT used for descriptions in this convention. `@description` is the explicit channel. Cleaner contract for AI authoring; cleaner parse for tooling.

### What's NOT in the annotation set (and why)

- **`@id`** (à la Prisma) — every Nebula resource has `id: string` by convention; storage enforces this without per-type annotation.
- **`@unique`, `@index`** — indexes are a Star storage concern, not an ontology concern. Uniqueness inside Snodgrass-style temporal storage is at the eTag level.
- **`@onDelete cascade|setNull|restrict`** — flagged for post-demo when server-side relationship enforcement lands. For the demo, cascade behavior is the AI-generated UI's responsibility (don't orphan related resources by leaving them un-deleted in the UI flow).
- **Cardinality annotations** (`@one`, `@many`) — inferable from TypeScript types: `T` is one, `T[]` is many. Don't annotate what the type already says.
- **Foreign-key location annotations** — inferable from the inverse pattern: if `Todo.assignee: Person` and `Person.todos: Todo[]`, FK lives on Todo (the side with the singular reference). Both sides arrays → junction table (M:N). No need to annotate.

## Example

A resource type that has natural fields like `startedAt` and `durationMinutes` rather than `title` and `description` fields, so type-level metadata doesn't visually collide with instance fields:

```typescript
/**
 * @title Workout Session
 * @description A single training session, capturing the exercises performed
 *   and the athlete who did them.
 */
interface WorkoutSession {
  id: string;

  /**
   * @title Started At
   * @description Timestamp when the session began.
   */
  startedAt: Date;

  /**
   * @title Duration (minutes)
   * @description Total session duration including warmup and cooldown.
   */
  durationMinutes: number;

  /**
   * @title Athlete
   * @description Whose session this is.
   * @inverse sessions
   */
  athlete: Athlete;

  /**
   * @title Exercises
   * @description Each exercise performed during the session, in order.
   * @inverse session
   */
  exercises: ExerciseSet[];

  /**
   * @title Tags
   * @description Free-form categorization — "leg day", "rehab", "PR attempt", etc.
   * @inverse sessions
   */
  tags: Tag[];
}
```

This example shows all three relationship shapes the AI needs to recognize:

- **1:1** — `athlete: Athlete` (singular reference; FK lives on `WorkoutSession`)
- **1:M** — `exercises: ExerciseSet[]` with `ExerciseSet.session: WorkoutSession` on the other side (FK lives on `ExerciseSet`)
- **M:N** — `tags: Tag[]` with `Tag.sessions: WorkoutSession[]` on the other side (junction table)

The AI distinguishes the cases by following `@inverse` to the target type and inspecting that field's shape — no annotation needed beyond `@inverse` itself.

## URL slug = PascalCase interface name

The URI template stays `{baseUrl}/{u}.{g}.{s}/resources/{TypeName}/{resourceId}`. `TypeName` is the literal interface name. So:

- `/{u}.{g}.{s}/resources/WorkoutSession/session-42`
- `/{u}.{g}.{s}/resources/ExerciseSet/set-17`

Rationale (worth pinning because someone will fight us on it):

- The interface name IS the canonical identifier. Translating creates a second mapping the AI has to learn — and get wrong sometimes.
- Multi-word names translate ambiguously. `WorkoutSession` could be `workout-session`, `workoutsession`, or `workout_session`. PascalCase has zero ambiguity.
- URL aesthetics is a small price. Readers see `/WorkoutSession/session-42` — not pretty but unambiguous.
- GraphQL convention: PascalCase types in URLs is normal in GraphQL playgrounds and tooling.

## What the AI sees

The AI consumes the raw `.d.ts` source string. Galaxy exposes a method (probably extending an existing one rather than adding new — the source is already stored as part of `OntologyVersionRow`):

```typescript
// On Galaxy
@mesh()
getOntologySource(version?: string): string {
  // Returns the .d.ts source for the named version, or the current version if omitted.
  // Already stored alongside validatorBundle in OntologyVersionRow.
}
```

Studio's tool surface (`get_current_ontology` per `nebula-studio.md`) calls this. No JSON metadata bundle is constructed for the AI; the source IS the spec.

## What the runtime sees

The runtime DOES extract the new annotations into a parsed metadata shape — for its own use, not for the AI:

- `@title` and `@description` flow into the validation error messages (better human-readable errors when validation fails).
- `@inverse` is what the post-demo query engine in `tasks/on-hold/nebula-orm-and-queries.md` uses for `getRelationship()` traversals.
- All three are stored alongside the existing `extractTypeMetadata()` output (default values, optional flags, type info).

This is invisible to the AI and to vibe coders. It's just the runtime's parse of what's already in the `.d.ts`.

## Implementation

### 1. Extend `extractTypeMetadata()` in `@lumenize/ts-runtime-parser-validator`

Already walks property signatures and calls `ts.getJSDocTags(member)` for `@default`. Extend the same pass to collect `@title`, `@description`, and `@inverse`. Pure additive change — existing consumers (parse-validate, migrations) ignore the new fields if they don't need them.

### 2. Surface ontology source on Galaxy

If `OntologyVersionRow` already stores the source string (likely — the validator bundle was generated *from* it, so the source is the input), expose `getOntologySource(version?)` as a `@mesh()` method. If not, add a `source: string` field to `OntologyVersionRow` and persist it during `compileOntologyVersion()`.

### 3. Document the conventions

User-facing docs at `website/docs/nebula/resource-types.md` (or similar) covering:

- The three annotations with examples
- The PascalCase URL slug rule
- That descriptions and titles flow into both AI generation and validation error messages
- Cross-link to `tasks/on-hold/nebula-orm-and-queries.md` so future readers know `@inverse` is forward-looking infrastructure for the query engine

### 4. Studio integration

When Studio's `get_current_ontology` tool fires, return the `.d.ts` source verbatim. The AI's system prompt references the annotation conventions so it knows what `@title`/`@description`/`@inverse` mean when reading the source. Same prompt applies to pre-Studio Claude Code generation.

## Success Criteria

- [ ] `@title`, `@description`, `@inverse` defined in user-facing docs; conventions stable
- [ ] `extractTypeMetadata()` collects all three; existing consumers unaffected
- [ ] Galaxy exposes `getOntologySource(version?)` returning the raw `.d.ts` source
- [ ] PascalCase URL slug pinned in resources URI scheme docs
- [ ] Studio's system prompt references the annotation conventions and consumes raw source
- [ ] Pre-Studio Claude Code spike uses the same source-as-spec pattern (validates the convention before Studio bakes it in)

## Open considerations

- **`@title` on every field is verbose.** Could default to humanized field name (`durationMinutes` → "Duration Minutes") and treat `@title` as override-only. Demo can ship with required-everywhere and we soften based on real-world friction. Note for the first review pass after a real ontology exists.
- **Are all interfaces in the ontology resources, or are some embedded value types?** A `Money { currency, amount }` could be either a separately-addressable resource or an inlined record shape. For the demo, assume all interfaces are resources (have stable `id`, can be subscribed to). Embedded value types are a post-demo distinction worth raising if it bites.
- **Cascade behavior** without server-side enforcement: the AI generates UI that handles the cascade in its flow (e.g., "delete this session and its sets"). When server enforcement lands, the AI can stop generating the cascade-handling UI. Worth a system-prompt hint: "for now, treat cascade behavior as the UI's responsibility."
