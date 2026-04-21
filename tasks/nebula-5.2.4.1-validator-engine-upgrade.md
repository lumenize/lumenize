# Phase 5.2.4.1: Parse-Validate Package

**Status**: Phases 1, 3, 4, 5, 6 complete (2026-04-21). Phase 2 skipped (Spike A succeeded). **Next: Phase 7 (docs)**, then Phase -1 triage, then 5.2.4.2.
**Depends on**: 5.2.4 (docs shipped — see `tasks/archive/nebula-5.2.4-docs.md`)
**Precedes**: 5.2.4.2 (Galaxy integration)
**Package**: `packages/ts-runtime-parser-validator/` (new)

## Phase 1 Outcome (2026-04-20)

**Spike A succeeded, Phase 2 skipped.** `@typia/transform` + `typescript` bundle cleanly at `platform: 'neutral'` with the full Node-builtin shim set. Transformer runs under `strict: true` inside a Workers isolate, loads into a DO facet, round-trips parse results end-to-end.

**Non-obvious findings that cost time to discover and matter for future maintainers:**
- **TS lib files must ship.** Without the full `lib.*.d.ts` reference chain, typia's `checker.isArrayType()` returns `false` and `T[]` gets classified as bare `{}`. Bundle 100 lib files via `scripts/bundle-dependencies.mjs` → `dist/ts-lib-files.mjs`.
- **Typia identifies its own calls by source-file path substring.** The typia stub for `import typia from "typia"` must live at `typia/lib/module.d.ts` and be routed via `compilerOptions.paths`. Any other location leaves `typia.createValidate<T>()` unrewritten.
- **Typia doesn't dedupe nested type-refs across top-level validators.** `User` referencing `Address` produces Address's check logic in both validators' IIFEs. Phase 6 verified this doesn't hurt (119 KB for 30 types, well under the 200 KB gate — dedup-pass dropped).

**Sizes** (authoritative numbers in Phase 6):
- `dist/deps.bundle.mjs` 3.91 MB + `dist/ts-lib-files.mjs` 3.22 MB = ~7.1 MB distributable, well under the 10 MB Worker script ceiling.
- Generated-module sizing formula: `total ≈ 4.6 KB + Σ (1.8–4.3 KB per resource type)`.

**Versions pinned**: `@typia/transform@12.0.2` + peers (`@typia/core`, `@typia/interface`, `@typia/utils` all `12.0.2`), `typescript@^5.9.2`, `@cloudflare/vitest-pool-workers@^0.14.7`, `wrangler@^4.84.0` (via npx-pin), `vitest@4.1.4`. `compatibility_date: "2026-04-01"`.

Package structure (`packages/ts-runtime-parser-validator/`): `src/compile-types-to-parse-module.ts`, `src/extract-type-metadata.ts` (internal), `src/typia-runtime-helpers.ts`, `src/index.ts` (re-exports `compileTypesToParseModule` only), `scripts/bundle-dependencies.mjs` + shim set, `test/` (see Phase 5 Outcome), `wrangler.jsonc`, `dist/*.mjs` (gitignored, regenerated via `npm run bundle`).

---


## Objective

Create `@lumenize/ts-runtime-parser-validator` — a new package built around typia and the "parse, don't validate" paradigm. `compileTypesToParseModule()` generates a pre-compiled JS module (once per ontology version, cached) whose exported `parse()` fills `@default` values and validates in one call, returning typed data or errors.

**API shape:**
- `compileTypesToParseModule(typeDefinitions: string): string` — one call at ontology-registration time produces a self-contained JS module source string. The module bakes in typia-generated validators, `typeMetadata` (defaults + relationships), inlined runtime helpers, and a `ParserValidator` class extending `DurableObject` that exports `parse(value, typeName)` as an RPC method.
- Runtime hot path: load the module once as a DO facet, then `facet.parse(value, typeName)`. Two args per call, no metadata threaded through.

**Why parse-don't-validate:** typia's generated validators check without filling. Our `parse()` wrapper adds the filler + dispatcher; typia supplies the validator. Mirrors Zod's `parse`/`safeParse` API. Makes `@default` a first-class package-level concern.

**Latency reality (measured, Phase 6):** typia core ~50 µs; deployed end-to-end ~1.4 ms per call due to facet RPC (structured-clone + scheduler hop, unavoidable while ontologies hot-swap). Sub-ms local, near-sub-ms deployed. Star cold-wake is ~1.7 s, 85 % DO-infrastructure, 15 % our code — UX mitigations (optimistic UI etc.) are a Nebula-side concern.

**Relationship to the old `@lumenize/ts-runtime-validator`:** old stays published, gets deprecated via 5.2.4.2. `extractTypeMetadata()` ports (extended with `@default` pass and Set/Map container recognition — internal only). `toTypeScript()` and `validate()` don't port; typia works on JS values directly, not TS-source strings. New package has zero dependency on `@lumenize/structured-clone`.

## Design Decisions (from design conversation 2026-04-17)

1. **New package, clean slate.** `@lumenize/ts-runtime-parser-validator` in `packages/ts-runtime-parser-validator/`. Old tsc-based package deprecates via 5.2.4.2.

2. **Parse, don't validate.** One runtime entry — `parse()` fills then validates. No standalone validate. Mirrors Zod.

3. **`parse()` is exported by the generated module, not the package.** Callers load the module once as a DO facet, then `facet.parse(value, typeName)`. Two args at the hot path; no `typeMetadata` threaded through. DO facet is the only supported loader. Plain DW without a facet parent is a future enhancement. *Facet shape (class vs plain functions) resolved in Phase 1: class extending `DurableObject`.*

4. **Shared `typescript` via single bundled instance.** Both the typia transformer and `extractTypeMetadata()` import `ts` from the same `dist/deps.bundle.mjs`. Typia does `instanceof ts.Node` checks; two `typescript` instances silently break it.

5. **Tag vocabulary = public API, aligned to typia.** See Phase 3.

6. **Inlined helpers for generated validators.** ~300 LOC of typia's `lib/internal/` helpers (format validators, type guards, `TypeGuardError`) inline into each emitted module so it's self-contained. Separate from `@typia/transform`'s own runtime, which Phase 1 spiked as a bundled dep.

7. **Trust Workers RPC for cross-isolate value passing.** Its type support covers everything a resource author would reasonably store. *Alternative "always wrap in `@lumenize/structured-clone`" rejected because it pays overhead on every call for risk that hasn't materialised.* **Risk watch**: Kenton Varda has floated removing cycle/alias support from Workers RPC; if that ships, fix is localised (wrap the RPC payload at the Star↔facet boundary).

Earlier drafts also had a "`@default` semantics" design decision and a version of #3 that described the facet-shape as an open sub-question. Both are superseded by Phase 3 / Phase 4 / Phase 1 Outcome respectively.

## Phase 1: Spike A — Bundling Feasibility

**Status**: Complete. Succeeded. See Phase 1 Outcome at the top of this file for results and locked decisions.

The spike question: can `@typia/transform` be bundled alongside `typescript` and run inside a Workers isolate? Biggest technical risk; run first. *Answered yes.* Skip Phase 2.

## Phase 2: Spike B — Inline Feasibility

**Status**: Skipped. Spike A succeeded, so inlining typia's transformer source was never attempted. If we ever need to fork (typia stops supporting a future TS version, or similar), this phase's plan becomes the jumping-off point: strip typia to the assert/validate path, swap `import ts from 'typescript'` for the bundled instance, verify Worker compatibility. The plan from the earlier draft is archived in git history.

## Phase 3: Tag Vocabulary Alignment

**Status**: Complete (2026-04-20).

**Goal**: Decide the JSDoc tag contract for the new package. **Decision-only** — the user-facing documentation is written in Phase 7.

### Inventory: old package

`@lumenize/ts-runtime-validator`'s `extractTypeMetadata()` inspects **zero** JSDoc tags (confirmed by reading `packages/ts-runtime-validator/src/extract-type-metadata.ts` on 2026-04-20). Nebula source also uses no typia-style branded types (`grep -r 'ExclusiveMinimum\|MinLength\|Format<\|Pattern<' apps/nebula/src` returns empty). Constraints in the tsc engine came entirely from native TypeScript types (string-literal unions for enums, `number | undefined` for nullables, etc.). **Result: empty baseline — zero backward-compat tags to preserve, zero migration burden for Nebula today.**

### Inventory: typia 12.0.2

Typia recognises two parallel paths to the same metadata:

1. **Branded types**: `number & Minimum<13>` — type-system path, walked by typia's metadata factory.
2. **JSDoc tags**: `/** @minimum 13 */` — read by `MetadataCommentTagFactory.PARSER` (`node_modules/@typia/core/lib/factories/MetadataCommentTagFactory.js`).

The JSDoc `PARSER` dictionary (authoritative source) accepts these tag names:

| Tag | Applies to | Value grammar | Emits |
| --- | --- | --- | --- |
| `@type` | number, bigint | `int32` \| `uint32` \| `int64` \| `uint64` \| `float` \| `double` (shortcut: `int`→`int32`, `uint`→`uint32`) | `Type<"...">` constraint + range check |
| `@minimum` | number, bigint | bare number | `Minimum<N>` |
| `@maximum` | number, bigint | bare number | `Maximum<N>` |
| `@exclusiveMinimum` | number, bigint | bare number | `ExclusiveMinimum<N>` |
| `@exclusiveMaximum` | number, bigint | bare number | `ExclusiveMaximum<N>` |
| `@multipleOf` | number, bigint | bare number | `MultipleOf<N>` |
| `@format` | string | one of the 25 format IDs below | `Format<"...">` |
| `@pattern` | string | literal regex source (no flags) | `Pattern<"...">` |
| `@length` | string | bare integer | `MinLength<N>` + `MaxLength<N>` (same N) |
| `@minLength` | string | bare integer | `MinLength<N>` |
| `@maxLength` | string | bare integer | `MaxLength<N>` |
| `@items` | array | bare integer | `MinItems<N>` + `MaxItems<N>` (same N) |
| `@minItems` | array | bare integer | `MinItems<N>` |
| `@maxItems` | array | bare integer | `MaxItems<N>` |
| `@uniqueItems` | array | no value (presence-only) | `UniqueItems` |

`@format` values accepted (from `FormatCheatSheet.js`): `byte`, `password`, `regex`, `uuid`, `email`, `hostname`, `idn-email`, `idn-hostname`, `iri`, `iri-reference`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uri-template`, `url`, `date-time` (aliases: `datetime`, `dateTime`), `date`, `time`, `duration`, `json-pointer`, `relative-json-pointer`.

**Key finding — typia has no `@default` JSDoc handler.** Typia's `MetadataCommentTagFactory.PARSER` has no `default` entry; `Default<T>` (a branded type, primitives only) is metadata-only for JSON Schema / random generators. *Earlier draft assumed mirroring typia's grammar; rejected because there was no typia grammar to mirror.* We own `@default` as a Lumenize-custom tag with richer grammar (full JSON literals incl. arrays/objects) — Nebula needs it for nested-default cases that `Default<T>` can't express.

### Decisions

**D1. Adopt typia's validator JSDoc vocabulary verbatim** — the 15-row table above. All 25 `@format` values flow through to typia as-is. No renames. Benefits: zero surface-area invention on the validation side, users writing interfaces rely on typia's docs, and the transformer handles parsing and emission for us.

**D2. Add `@default` as a Lumenize-custom JSDoc tag** — not part of typia's PARSER. Owned by our extended `extractTypeMetadata()`, collected into `typeMetadata.defaults` and baked into the generated module for the `parse()` wrapper to fill pre-validation.

**D3. `@default` grammar = JSON literals only** (the task's earlier "fallback" path, now promoted to the chosen path since the "preferred" path doesn't exist):
- Accepted: `number` (including `-1.5e3`), `string` (double-quoted JSON), `boolean`, `null`, JSON array of these, JSON object of these. Nested JSON permitted to any depth.
- Parsing: `JSON.parse(tagText.trim())`. No `eval`, no `Function`, no template strings, no trailing commas.
- Rejected at extract time with a clear error: anything that doesn't round-trip through `JSON.parse` — including `undefined`, `NaN`, `Infinity`, bigint syntax (`10n`), single-quoted strings, unquoted object keys, function expressions.
- This deliberately does *not* try to match typia's `Default<T>` (primitives only) — our grammar is a superset, richer where Nebula needs it (arrays, objects), safer where it counts (no eval). If users also put a typia `Default<T>` branded type on the same field, both metadata paths run independently: our `@default` JSDoc drives input-filling, typia's `Default<T>` ends up in the emitted JSON Schema. Not conflicting, just complementary.

**D4. `@default` on a required field → hard error at `extractTypeMetadata()` time.** Formalising Phase 4's option (a) now so Phase 5 has one behaviour to test. Caught at ontology registration, surfaced as a compile-time error via Galaxy's submit-time rejection.

**D5. Unknown JSDoc tags are tolerated, not errored.** If a user writes `@author Alice` on a field, the extractor leaves it alone. This lets users keep documentation tags on their interfaces without triggering validator errors.

**D6. Tag values are case-sensitive except where typia's `FORMATS` map explicitly aliases** (e.g., `datetime` / `dateTime` → `date-time`). Users writing `@format EMAIL` get a validation error at compile time, not a surprise non-match.

**D7. Document JSDoc tags only; do not disallow branded types.** All docs, tests, and `@check-example` blocks use the JSDoc form exclusively. If a user writes `number & Minimum<13>`, typia's transformer still processes it correctly (both paths produce identical metadata) — we just don't teach it. Reasons: Galaxy stores interfaces as strings where `import { tags } from "typia"` would require special handling; JSDoc is the lower-friction surface for vibe coders; mixing JSDoc `@default` with branded validator tags would split the surface area arbitrarily; hiding typia as an implementation detail is easier when user code has no `typia` import. Zero enforcement cost — typia handles both paths identically without our involvement.

### Divergences from typia (to be called out in Phase 7 docs)

- **`@default` exists in Lumenize, doesn't exist as a JSDoc tag in typia.** Anchor in docs: link to typia's `Default<T>` branded type and explain Lumenize's is a richer JSDoc-based parallel path specifically for input-filling.
- No other renames, additions, or omissions.

**Success Criteria**:
- [x] Complete tag table recorded in this file (`D1` above, 15 rows + 25 `@format` values)
- [x] Any divergences from typia's tag names decided and recorded with reasons (`@default` — `D2`/`D3`; no other divergences)
- [x] `@default` grammar pinned (`D3`: JSON literals only)
- [x] `@default` on required field behaviour pinned (`D4`: hard error)

## Phase 4: `@default` and `parse()` Semantics

**Status**: Complete (2026-04-20) — specification-only phase; most decisions pre-pinned from Phase 3.

### Decisions (formalised)

**P4.1. Fill semantics.** The generated `parse()` wrapper fills missing optional fields from `typeMetadata.defaults` **before** invoking the typia-generated validator. The validator sees already-filled objects. Defaults are applied non-destructively: if the caller supplied a value for a field, their value wins — a missing property triggers the default, an explicit `undefined` also triggers the default, any other value (including `null`) is left alone. Rationale: `null` is a meaningful distinct value in most resource schemas; treating it as "absent" would surprise users who intentionally write `null`.

**P4.2. Required vs optional.** Fields with `@default` **must** be declared optional. `@default` on a required field → **hard error at `extractTypeMetadata()` time** (Phase 3 `D4`, Phase 4 formalisation). Error surfaced through Galaxy's submit-time ontology rejection in 5.2.4.2. The error message must name the type and field (e.g., `@lumenize/ts-runtime-parser-validator: @default on required field 'User.email' — declare the field optional (email?: ...) or remove the @default tag`).

**P4.3. Return shape.** `parse(value, typeName): { valid: true, data } | { valid: false, errors }`, exported from the generated module. On success `data` is the filled-and-validated object. On failure `errors` is the structured error list and no `data` is returned. The `valid` discriminant gives callers a clean TypeScript narrowing check. The outer name `valid` (vs typia's `success`) was pinned in Phase 1 Outcome — our wrapper translates typia's `success` into `valid`.

**P4.4. Error shape.** Adopt typia's error *element* shape verbatim: `{ path: string; expected: string; value: unknown; description?: string }`. No translation, no wrapping. Callers (only Nebula's `Resources.transaction()` today) consume this shape directly starting in 5.2.4.2 — a breaking change for Nebula, but the new package ships under a new name so existing `@lumenize/ts-runtime-validator` users are unaffected until they opt in.

**P4.5. Depth.** `@default` recurses fully into nested objects and array elements. Any optional field at any depth with a `@default` tag is filled pre-validation. Practical guidance (docs, not enforced): don't stack deep nested defaults — if an interface has `@default` five levels deep, lift the nested structure into its own named interface so the defaults attach to that interface's own optional fields. Same recursion, more readable. For array elements, `@default` on the array field itself (e.g., `tags?: string[] /** @default [] */`) fills a missing array; `@default` on a nested interface used as array element fills individual element fields when the element is present but incomplete — not auto-populating missing array slots.

**P4.6. Field-value interaction with validators.** After filling, the typia validator sees the filled value as if the user supplied it. If the `@default` literal itself doesn't satisfy the type (e.g., `@default "hello"` on a `number` field, or `@default 5` on a `string & Minimum<10>` — though minimum on strings is nonsensical, illustrative), the validator fails with typia's normal error shape pointing at the filled path. We do not pre-check `@default` literals against the field type at extract time — letting the validator catch it gives a consistent error pipeline and avoids duplicating typia's type matcher in the extractor. Users see the failure immediately on first `parse()` call against a default-supplied field.

### Test specifications (draft; become executable in Phase 5)

All tests land in `packages/ts-runtime-parser-validator/test/default-*.test.ts`, using the existing `SELF.fetch('/parse', ...)` harness from Phase 1. Pseudo-code sketches:

1. **Flat fill** — interface `Todo { title: string; /** @default 0 */ priority?: number }`. `parse(Todo, { title: 'x' })` returns `valid: true, data: { title: 'x', priority: 0 }`.
2. **Explicit undefined triggers default** — same interface, `parse(Todo, { title: 'x', priority: undefined })` → same result as missing.
3. **Explicit null preserved** — interface `Note { /** @default 0 */ count?: number | null }`. `parse(Note, { count: null })` → `valid: true, data: { count: null }`. Default NOT applied.
4. **Array default** — `tags?: string[] /** @default [] */`. Missing `tags` → filled with `[]`.
5. **Nested object default** — `config?: Config /** @default {"timeout": 30} */`. Missing `config` → filled with `{ timeout: 30 }`.
6. **Nested recursion** — `User` has optional `address?: Address`, and `Address` has `/** @default "US" */ country?: string`. `parse(User, { address: { street: 'x' } })` → the default fills inside the nested object.
7. **Array-element recursion** — `users?: User[]` where each `User` has a `@default` field. A value like `{ users: [{ id: 'a' }] }` gets each element's defaults filled.
8. **`@default` on required field → extract-time error** — `extractTypeMetadata('interface X { /** @default 0 */ x: number }')` throws an error naming `X.x` and including the corrective guidance from P4.2.
9. **Default value fails validation** — `/** @default "hello" */ count?: number`. First `parse()` call on a value missing `count` fills with `"hello"`, validator emits `expected: "number", value: "hello"` at path `$input.count`. Single consistent error pipeline.
10. **JSON-literal grammar rejection** — `@default 10n`, `@default NaN`, `@default undefined`, `@default {foo:1}` (unquoted key), `@default 'x'` (single quotes) all throw at extract time naming the type, field, and the offending literal text.

**Success Criteria**:
- [x] Design decisions documented in this file (`P4.1` through `P4.6`)
- [x] Test specifications drafted (10 scenarios, pseudo-code above)
- [x] API signature finalised — matches Phase 1's `{ valid: true, data } | { valid: false, errors }`

## Phase 5: Package Implementation

**Status**: Complete (2026-04-20). Spike A dependency approach. All tests green (90/90). Type-check clean.

### Phase 5 Outcome

**Files added / modified in `packages/ts-runtime-parser-validator/`:**
- `src/extract-type-metadata.ts` — ported from old package, extended with `@default` JSDoc pass. Returns `{ interfaceNames, relationships, writeShapeTypeDefinitions, defaults }`. Internal (not exported from `src/index.ts`).
- `src/typia-runtime-helpers.ts` — inlined helpers now cover three typia internals: `_validateReport`, `_createStandardSchema`, and `_accessExpressionAsString` (discovered during parity tests — typia emits this for `Record<string, T>` and index-signature validation).
- `src/compile-types-to-parse-module.ts` — now consumes `extractTypeMetadata()`, feeds typia the **write-shape** (relationship refs narrowed to string/string[]), bakes `typeMetadata` (defaults + relationships) into the emitted module, and emits a `__fillDefaults()` runtime function that applies defaults non-destructively per Phase 4 P4.1/P4.5 before `parse()` delegates to the typia validator.
- `test/default-fill.test.ts` — 8 tests covering P4.1 (flat, undefined-triggers-default, null-preserved, array default, object-literal default, multi-literal, default-that-fails-validation, caller-value-wins)
- `test/default-extract.test.ts` — 11 tests covering Phase 3 D2/D3 (extraction + grammar rejection + empty-value + unknown-tag tolerance + multi-interface)
- `test/relationships.test.ts` — 8 tests covering write-shape rewriting (one, many, Array&lt;T&gt;, `T | null`, non-ontology refs) + facet-level validation of string-ID relationship fields + nested-object recursion
- `test/typia-tags.test.ts` — 10 tests covering `@minimum`, `@maximum`, `@exclusiveMinimum`, `@multipleOf`, `@minLength`/`@maxLength`, `@pattern`, `@format email`, `@format uuid`, `@minItems`, `@uniqueItems` (spot-check that typia JSDoc vocabulary flows through)
- `test/edge-cases.test.ts` — 12 tests covering SyntaxError on bad types, empty-input, `type` aliases skipped, methods ignored, Array<non-ontology>, unions of 2 ontology types, whitespace-tolerant `@default`, multi-`@default` (last wins), self-contained emit, relationship+default bake-in
- `test/container-relationships.test.ts` — 10 tests covering the `Set<Interface>` / `Map<K, Interface>` / `ReadonlySet` / `ReadonlyMap` relationship detection, write-shape rewriting (including preservation of Map key source text), and facet-level validation of transaction-time ID payloads.
- `test/parity/types.test.ts` — 18 tests covering the TypeScript type-system layer of the delta suite
- `test/parity/values.test.ts` — 13 tests covering the JS-values-over-RPC layer
- `test/facet-roundtrip.test.ts` — 5 existing tests (fixture adjusted after write-shape change)

### Type-support delta matrix (pass/fail under the current implementation)

The values-layer tests call the DO via **Workers RPC** (`stub.rpcParse(typeDefinitions, typeName, value, bundleId)`), which uses structured-clone semantics. This matches the production Star → facet serialization path. JSON-boundary artefacts are excluded — earlier pass/fail labels in this matrix that said "DROP through JSON boundary" were harness noise and have been replaced with real RPC-path results.

| Category | Status | Notes |
| --- | --- | --- |
| Primitives (string, number, boolean, null, optional) | ✓ SUPPORTED | |
| bigint (with `@type "int64"`) | ✓ SUPPORTED | verified via RPC path. |
| Object & Array (nested inline, typed arrays) | ✓ SUPPORTED | |
| Union & Optional | ✓ SUPPORTED | string-literal unions fully supported. |
| Map — homogeneous `Map<K, V>` with primitive V | ✓ SUPPORTED | verified via RPC path. Example: `data: Map<string, number>`. |
| Map — heterogeneous `Map<string, string \| number>` | ✓ SUPPORTED | absorbs the stand-alone gate that was previously its own success criterion. |
| Set of primitives | ✓ SUPPORTED | verified via RPC path. Example: `tags: Set<string>`. |
| `Set<Interface>` / `Map<K, Interface>` of ontology types | ✓ SUPPORTED as to-many relationships | treated identically to `T[]`. Write-shape rewrites `members: Set<User>` → `members: Set<string>` and `roleMap: Map<string, User>` → `roleMap: Map<string, string>`. Also covers `ReadonlySet<T>` and `ReadonlyMap<K, T>`. The Map's key type is preserved as source text (e.g., `Map<"admin" \| "editor", User>` → `Map<"admin" \| "editor", string>`). Example for a `Team` resource: `interface Team { members: Set<User>; roleMap: Map<string, User>; }` — at transaction time, pass `new Set(['u-1', 'u-2'])` and `new Map([['admin', 'u-1']])`. |
| Date | ✓ SUPPORTED | Date instances validate against `Date` type over RPC. `@format date-time` also available for date strings. |
| RegExp (as value) | ✓ SUPPORTED | typia has built-in `RegExp` recognition. `new RegExp('x')` / `/x/` validate against `pattern: RegExp`; strings get rejected with `expected: "RegExp"`. Unusual in Nebula resource payloads but works cleanly if a user stores one. `@pattern` remains the preferred tool for string-pattern validation. |
| URL | DROP as a value type | `@format url` supported as string-level alternative. Users don't typically store URL instances. |
| Headers | DROP | recommend `Record<string, string>`; not a Nebula-blocking gap. |
| TypedArrays (`Uint8Array`, `BigInt64Array`, `ArrayBuffer`, and all sibling variants) | ✓ SUPPORTED | typia recognises TypedArray constructors natively. `new Uint8Array([1,2,3])` validates against `data: Uint8Array`; plain arrays get rejected with `expected: "Uint8Array"`. Same holds for `BigInt64Array`, `ArrayBuffer`, and structurally all 11 TypedArray variants. |
| Cyclic values | ✓ SUPPORTED (transport) | Workers RPC preserves cycles via structured-clone. Our `__fillDefaults` has cycle-safe recursion via a WeakMap. Relationship-rewritten fields rejected with a type error (expected string), which is the correct Nebula behaviour. |
| `any` fields | ✓ SUPPORTED | accepts structural values including Maps, Sets, Dates, cycles, nested arrays. |
| Utility types (Partial, Pick, Omit, Record) | ✓ SUPPORTED when embedded in a named interface | top-level `type Partial<User>` not reachable (only `interface` names become validators); user materialises as named type. Documented delta for Phase 7. |
| Conditional, template-literal, custom mapped types | ✓ SUPPORTED | resolved by tsc before typia sees them. |
| Generic instantiations as `typeName` | DROP | old pkg supported `'List<Todo>'`; new pkg requires a named interface. Documented. |
| Custom error shapes | ✓ SUPPORTED | as interfaces; becomes a relationship ref under write-shape. |

**Dropped categories are intentional.** Most stem from Nebula's write-shape model (relationships become string IDs) or from cases where typia's vocabulary offers a strictly better alternative (`@format`/`@pattern` for URL/RegExp). No silent drops; Phase 7's type-support page will write up each drop with the rationale.

### Coverage

Ran `npm run coverage`:
- Statements: **88.44 %** (target: >90 %) — 2 percentage points short, attributable to defensive error branches (`LIB_DTS_FALLBACK`, `no JS was emitted`, the surviving-typia-import guard) that by design don't trigger in normal operation. Closing would require mocking the bundle imports, which adds test complexity without catching real bugs.
- Branches: **76.22 %** (target: >80 %) — ~4 branches short, same root cause.
- Lines: **91.47 %**
- Functions: **77.77 %**

**Decision**: Accept the sub-target coverage on defensive-only branches; document here and in Phase 7. Adding mock-based tests for the `LIB_DTS_FALLBACK` fork and the two error-only throws would move the numbers but not the risk profile.

### Decisions locked in Phase 5

- **`compileTypesToParseModule()` always applies the write-shape.** Callers who want nested-object validation (non-Nebula use cases) use inline shapes (`{ street: string }`) instead of named interfaces as nested types. Not a flag, not configurable. Aligns the library behaviour with Nebula's production path.
- **Defaults are filled non-destructively and per type.** Missing property OR explicit `undefined` → default; any other value (including `null`) is preserved. Recurses into relationship-referenced types when the field carries a nested object (dev-mode passthrough); stops naturally when the field is a string ID.
- **Inlined helpers grow lazily.** The set of typia runtime helpers inlined in `typia-runtime-helpers.ts` expands when new helpers surface in emitted JS. The surviving-typia-import guard in `compileTypesToParseModule()` refuses to emit until a new helper is inlined — turns typia upgrades into a loud rather than silent failure mode. Current set: `_validateReport`, `_createStandardSchema`, `_accessExpressionAsString`.
- **Container-of-ontology-type relationships.** `Set<Interface>`, `Map<K, Interface>`, and their `Readonly` variants are first-class to-many relationships — identical to `T[]` / `Array<T>`. Write-shape rewrites the ontology type-arg to `string`, preserves container shape and Map key type. One schema drives Nebula transactions (IDs in, IDs out) and any other consumer — no validator-vs-ORM mode switch. *Alternative "only `T[]` is a relationship container" rejected because it made `Set<User>` a silent footgun (valid data rejected, invalid data accepted).*

## Phase 6: Benchmark

**Status**: Complete (2026-04-21).

### Goal

Measure three things and drive one decision:
- **Generated-module size** (affects memory and cold-load parse)
- **Warm `parse()` latency** (hot path, per transaction)
- **Cold facet-load latency** (one-time per Star per ontology version, gated)
- **Decision: do we need a post-emit dedup pass** to factor duplicate validator bodies? Triggered if size > 200 KB or cold-load > 500 ms.

### Methodology

**30-type synthetic ontology** (`test/fixtures/benchmark-ontology-30.ts`) — project-management domain (User / Team / Project / Task / File / Comment / …). 30 interfaces, 56 relationships across 25 types, cardinality mix of 39 one-to-one and 17 to-many, containers exercised: direct refs, `T[]`, `Set<T>`, `Map<K, T>`. 19 `@default` tags. Hand-authored for reproducibility. Pinned in `test/benchmark-size.test.ts`.

**Two suites:**
- **Suite 1 (`vitest-pool-workers`)** — size measurements only. The in-Worker clock is frozen during synchronous turns, so no latency.
- **Suite 2 (`experiments/ts-runtime-parser-validator-spike/`)** — two DO classes (`GalaxyDO` compiles, `StarDO` parses), hit by a Node.js client. Bench posts the ontology to `/galaxy/compile` once, then exercises `/star/ping-cold` (baseline DO wake, no facet), `/star/parse-cold` (DO wake + facet spawn + parse), `/star/parse-warm` (same DO, 1 warmup + 50 iterations). Client-side `performance.now()` for wall-clock timing.

### Results

**Size (Suite 1, 2026-04-20):**

| Component | Value |
| --- | --- |
| Total generated-module | **119.4 KB** (122,226 bytes) |
| Fixed overhead (3 inlined typia helpers + `ParserValidator` class) | 13.2 KB, constant across ontologies |
| Per-validator IIFE (30 of them) | min 2.1 / mean 3.6 / max 5.6 KB |

Matches Phase 1's sizing formula: `total ≈ 4.6 KB + Σ (1.8–4.3 KB per resource)`. 30-type projection is 80–180 KB; measured 119 KB sits in range.

**Latency (Suite 2, deployed to Cloudflare 2026-04-21):**

| Metric | Mean | p50 | Notes |
| --- | --- | --- | --- |
| `/ping` (network floor) | 463 ms | **26 ms** | high p99 from one outlier |
| Galaxy `/compile` | 1,333 ms | **817 ms** | one-time per ontology version |
| Star `/ping-cold` — **DO-cold baseline, no facet** | 1,494 ms | 1,301 ms | infrastructure + Worker-parse |
| Star `/parse-cold` — DO + facet + 1 parse | 1,755 ms | 1,836 ms | |
| Star `/parse-warm` iterations 2–5 | — | — | 66–78 ms for 51 parses → **~1.4 ms per call** |

**Decomposition of the 1,755 ms cold-wake:**
- DO-cold infrastructure baseline: **1,494 ms (85%)** — isolate creation + Worker-parse + handler
- Facet spawn + 119 KB module parse + first parse(): **262 ms (15%)**

**Local `wrangler dev` reference** (2026-04-21): ping 2 ms, compile 62 ms p50, cold parse 15 ms, warm parse ~0.25 ms, ping-cold 2.7 ms. The ~100× local-to-deployed gap on cold paths is Cloudflare infrastructure overhead, not our code.

### Decisions

**D6.1 — Dedup-pass: DROPPED (definitively).** Both gate halves passed with margin:
- Size 119 KB vs 200 KB threshold — passes by 40%
- Cold-facet-load contribution ~262 ms vs 500 ms threshold — passes by 48%

The larger 1,755 ms cold-wake is dominated by DO infrastructure (85%), not our module. Halving the 119 KB module via a dedup pass would save ~50 ms out of 1,755 ms. Not worth building. *Alternative rejected because the cost is elsewhere.*

**D6.2 — Warm parse is fine.** ~1.4 ms deployed, ~0.25 ms local. Typia core is ~50 µs; the remaining ~1.35 ms deployed is facet-boundary RPC (structured-clone + scheduler hop), which is unavoidable while ontologies update dynamically (Worker Loader is the only sanctioned dynamic-code path in Workers and it inherently crosses isolates). *Alternative "bake validators into Star's Worker at build time" rejected for performance because it saves only the 262 ms facet contribution, not the 1,494 ms DO-infra dominator — leaves the architectural option on the table for other reasons (see Phase -1).*

**D6.3 — Star cold-wake UX mitigation is out of scope for this task.** The 800 ms – 1.7 s cold-wake is an infrastructure cost of Cloudflare DOs, not a validator cost. UX mitigation (Nebula already planning optimistic UI) belongs in 5.2.4.2+ or the Nebula UI layer, not here.

### Open items

- **tsc baseline comparison** for the "did we regress vs `@lumenize/ts-runtime-validator`?" question the task originally posed. Needs a parallel spike Worker that wraps the old `validate()`. Not blocking 5.2.4.2; worth doing before the announcement blog post so numbers can be cited side-by-side.
- **Set/Map latency over Workers RPC.** Correctness parity for rich types is covered in `test/parity/values.test.ts`; a deployed latency number through pure RPC is a nice-to-have, not on the critical path.

### How to re-run

```bash
cd experiments/ts-runtime-parser-validator-spike
npm run dev           # shell 1: wrangler dev (npx-pinned 4.84.0 — see package.json)
npm run bench:local   # shell 2: hits http://127.0.0.1:8787
# Or: npm run deploy; node scripts/bench.mjs https://experiment-....workers.dev
```

Claude can run the local path end-to-end (wrangler dev in background, poll log, run bench, kill). Deploy requires developer auth. Spike is named with `experiment-` prefix for easy cleanup in the Cloudflare dashboard.

## Phase 7: Documentation

Write all docs before the package is published to npm. This is the consolidated "docs before publish" phase for this task. The old `@lumenize/ts-runtime-validator` was experimental and has no known external users, so the new package is framed as a fresh package rather than a successor — no migration guide.

### Positioning

Frame the package as **typia packaged for Cloudflare Dynamic Workers / DO facets**. What we add on top of typia:

- Compile-once-and-cache lifecycle for the generated validator module
- DO-facet loading as the runtime entry point
- Parse-don't-validate semantics with first-class `@default` filling
- Write-shape rewriting for ontology-style relationship references

Main body of the overview uses generic language (e.g., "user-supplied schemas", "per-tenant schemas in a SaaS app") with no Nebula-specific vocabulary. A `:::info` admonition near the end introduces the Lumenize Nebula use case concretely (and earns the right to use the word "ontology" by defining it in context). One sentence credits typia and links to typia.io. Explicitly tell Node.js readers to use typia directly — this package earns its keep when the schema must be dynamic inside a Worker.

### Work

- **Overview (`index.md`)** — the "why" story per Positioning above. Includes a **comparison table** with columns for this package, `@lumenize/ts-runtime-validator` (old), typia (raw), Zod, and Ajv — framed as "when to reach for which", not advocacy. The typia column's "reach for it when" row should say: "You're on Node.js, or you don't need dynamic schema hot-swap inside a Worker."
- **Getting Started (`getting-started.md`)** — the three-step flow: call `compileTypesToParseModule()` once at schema-registration time → load the emitted module as a DO facet → `facet.parse(value, typeName)` per call. Short, concrete, runnable.
- **API Reference (`api-reference.md`)** — `compileTypesToParseModule()` signature and options, the exported `parse()` from the generated module, the `{ valid: true, data } | { valid: false, errors }` return shape, and typia's error-element shape `{ path, expected, value, description? }` that flows through unchanged.
- **Additional Constraints (`additional-constraints.md`)** — the 15 JSDoc annotations from Phase 3 D1 (plus the 25 `@format` values) written up as user-facing docs. Page-title framing: "types are the primary constraint; these annotations add to what the type system provides". Use the word "annotations" in prose. Organise by what the annotation applies to (number / string / array). Each annotation gets a one-sentence description, a one-line interface example, and a two-line `facet.parse()` example showing acceptance + rejection.
- **`@default` (`default.md`)** — fill semantics (P4.1), required/optional rule (P4.2/D4), full recursion (P4.5), and the "lift deep nested defaults into their own interface" guidance. Linked from the corresponding row in the Additional Constraints page.
- **Type Support (`type-support.md`)** — mirrors the section-heading skeleton of `website/docs/ts-runtime-validator/type-support.md` so readers can category-by-category see what changed. Drop the old page's "TypeScript Emit" column (no equivalent concept here — typia validates JS values directly). Add a brief "Tag-based constraints" section that links to Additional Constraints. Each section documents what's supported (with a tested example) or carries a short "not supported because X" note drawn from the Phase 5 delta matrix. tl;dr paragraph at the top. No hidden omissions.
- **Sidebar and package-table updates** — add a new `TS Runtime Parser-Validator` section to `website/sidebars.ts` with the pages above; update `website/docs/introduction.mdx` to add a row for the new package marked **experimental**, and update the existing `@lumenize/ts-runtime-validator` row to **deprecated** with a pointer to the new package.

Nebula integration (updating `Resources.transaction()`, wiring Galaxy/Star) belongs to 5.2.4.2, not this task. The `npm deprecate` of `@lumenize/ts-runtime-validator` also moves to 5.2.4.2 — keeping it paired with Nebula's removal of the old dependency provides a hedge: if integration hits problems we can postpone the deprecation without having to un-deprecate. The **blog post also moves to the end of 5.2.4.2**: writing the announcement after Nebula integration lets us describe the full working system (parse-validate + Galaxy/Star wiring) in one post, and avoids announcing something that might still hit integration snags.

### Success Criteria

- [ ] Overview and getting-started pages published, with the typia-for-DO-facets framing and the Node.js "use typia directly" guidance
- [ ] Overview page includes the comparison table (this package, old package, typia, Zod, Ajv) framed as "when to reach for which"
- [ ] API reference page published (`compileTypesToParseModule()`, exported `parse()` from generated module, return and error shapes)
- [ ] Additional Constraints page published, covering every annotation decided in Phase 3 (15 annotations + 25 `@format` values)
- [ ] `@default` page covers fill semantics, required/optional rule, full recursion, and the "lift deep nested defaults into their own interface" guidance
- [ ] Type-support page published with same section skeleton as the old doc (minus "TypeScript Emit" column), each category marked supported-with-example or dropped-with-reason based on the Phase 5 delta matrix
- [ ] `website/sidebars.ts` updated with the new section; `website/docs/introduction.mdx` has a new row for the package marked **experimental**, and the existing `@lumenize/ts-runtime-validator` row updated to **deprecated** with a pointer to the new package
- [ ] Every executable code block in the new docs has an `@check-example('path/to/test')` annotation pointing at a passing `test/for-docs/` test — zero remaining `@skip-check` annotations. `npm run check-examples` passes. Note: `@skip-check-approved` may only be added by a human reviewer, never by Claude.

## Phase -1: Captured Ideas (triage before closing)

Convention borrowed from `Array.at(-1)`: Phase -1 is the trailing phase of a task — a bin for ideas that surface during the work but don't fit the current plan. Before closing the task, each entry gets triaged into exactly one outcome:

- **Do now** — fold into an earlier phase and strike from this list.
- **Later task file** — promote to its own task in `tasks/`.
- **Backlog** — append to `tasks/backlog.md` for a future pass.
- **Drop** — record the rationale inline and strike.

Nothing here is committed to yet.

### Auto-materialize generic instantiations at compile time

**Source**: Phase 5 delta matrix — "Generic instantiations as `typeName` — DROP."

**Idea**: scan `typeDefinitions` for top-level aliases that instantiate a generic (e.g., `type TodoList = List<Todo>;`). Emit a `TodoList: typia.createValidate<TodoList>()` entry. Users recover `List<Todo>`-style validation via a one-line alias.

**Triggering signal**: if real users (Nebula or external) hit the friction, or if doc readers ask "how do I validate `List<Todo>`?" Otherwise punt — Nebula's ORM model doesn't push users toward this pattern, and naming the concrete shape is a trivial workaround.

**Implementation sketch**: extend `extractTypeMetadata()` to collect top-level `type X = Y<...>` aliases where `Y` is a known generic interface. Surface as `interfaceNames` (or `aliasNames`). The typia-call-synthesis step is already name-driven.

**Disposition**: unscheduled.

### Blog post: facet performance in practice

**Source**: Phase 6 deployed bench — surprise finding that the cold-wake is 85 % DO-infrastructure and the facet RPC per-call is ~1.35 ms.

**Idea**: write a Lumenize blog post with real numbers distinguishing "DO facets are essentially free" (true for infrastructure/billing, Cloudflare's framing) from "DO facets add ~1 ms per-call RPC overhead" (true for latency-sensitive code paths, our measurement). Include the decomposition table from Phase 6, the 30-type fixture, and the specific guidance on when facets are right (dynamic code hot-swap, sandboxed user code) vs wrong (sub-ms per-call latency requirements).

**Why it's worth writing**: facets are new (announced 2026-04-13) and community guidance is thin. Our Phase 6 work produced decomposed numbers that answer questions other developers will have. Distinguishes Lumenize as having done the homework; pairs well with the 5.2.4.2 announcement post.

**Triggering signal**: write after 5.2.4.2 ships so the post can reference the deployed Nebula architecture end-to-end (Galaxy + Star + facets) rather than just the validator slice. Needs a separate task file.

**Disposition**: unscheduled; new task file after 5.2.4.2.

## Alternatives Considered and Rejected

Only paths that were actively weighed and dropped, with the reason. Mere "did X work? yes" lookups don't live here — they're implicit in the phase Outcomes.

- **Inline typia's transformer source instead of depending on `@typia/transform`** (Spike B / Phase 2). *Rejected because* Spike A succeeded cleanly; inlining would force us to own TS-version-compat (Samchon patches quickly, we'd lag). Latent option if we ever need to fork.
- **Post-emit AST dedup pass** to factor duplicate validator bodies. *Rejected because* Phase 6 measured cold-wake at 85 % DO infrastructure and 15 % our module; halving the module saves ~50 ms out of ~1,700 ms.
- **Always wrap RPC payload in `@lumenize/structured-clone`** for cross-isolate value passing. *Rejected because* Workers RPC's type support is close enough for resource data; wrapping pays overhead on every call for a risk that hasn't materialised. Localised fallback if Cloudflare removes cycle/alias support.
- **Bake validators into Star's Worker at build time to skip the facet** (performance motivation). *Rejected because* facet contribution is ~262 ms of the ~1,700 ms cold-wake; skipping it leaves the 1,494 ms DO-infra baseline untouched. Remains viable for other reasons (simpler deployment model) — not pursued here.
- **Custom `@default` grammar mirroring typia's** (Phase 3 early framing). *Rejected because* typia has no `@default` JSDoc handler; `Default<T>` branded type is primitives-only and Nebula needs richer shapes. We own the grammar (JSON literals).
- **Only recognise `T[]` / `Array<T>` as relationship containers** (Phase 5 original scope). *Rejected because* `Set<User>` / `Map<K, User>` silently validated nested objects instead of IDs — valid data rejected, invalid data accepted. Extended recognition to all four container shapes.
- **Document both JSDoc tags and typia branded types as equal surface** (Phase 3 D7 alternative). *Rejected because* Galaxy stores interfaces as strings — branded types require `import { tags } from "typia"` which is awkward to thread through. JSDoc-only docs; branded types still work silently for users who find them.
- **Single combined Galaxy+Star DO in the Suite 2 bench** (Phase 6 first iteration). *Rejected because* it forced every cold call to pay the compile cost that production Star never pays, giving a 3-second number that was ~95 % artifact. Split into separate `GalaxyDO` + `StarDO` classes; real Star cold-wake is ~1.7 s.
