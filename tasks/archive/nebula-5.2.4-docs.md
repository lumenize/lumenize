# Phase 5.2.4: `@lumenize/ts-runtime-validator` Documentation & Blog Post

**Status**: Complete (2026-04-15) — cross-posting to Substack/Medium dropped; new posts will accompany typia validator engine launch instead
**Package**: `packages/ts-runtime-validator/` (`@lumenize/ts-runtime-validator`)
**Depends on**: Phase 5.2.3 (Ontology integration — real-world usage may surface API changes)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`

## Goal

Two deliverables:

1. **Blog post** — "TypeScript IS the Schema: Runtime Validation Without JSON Schema or Zod." The hook: Cloudflare's code mode proved LLMs perform dramatically better with TypeScript than JSON Schema. We take the next step — use TypeScript interfaces as the runtime validation schema directly. No intermediate format, no DSL, real tsc diagnostics. This is the awareness driver.

2. **Package documentation** in `/website/docs/ts-runtime-validator/` — the reference material people land on after the blog post. API docs, type support tables, known limitations, examples.

## Planned Content

### Pages

1. **Overview** (`index.mdx`) — "TypeScript IS the schema" vision, when to use this package, quick example. Include:
   - **How It Works**: Your JS value is serialized to a TypeScript program via `toTypeScript()`, then the real TypeScript compiler type-checks it against your interface definitions, and you get back actual tsc diagnostics. This explains why error messages are high quality and sets expectations about what's supported (real tsc, not a reimplementation).
   - **Why TypeScript as Schema**: A short teaser — you already write TypeScript interfaces, why maintain parallel Zod/TypeBox/JSON Schema definitions? Mention that Cloudflare's code mode proved LLMs work better with TypeScript than JSON Schema, just enough to intrigue, then link to the blog post for the full story. Make them want to read it, don't summarize it.
   - **Tradeoffs**: Be honest. This runs the real tsc compiler at runtime — that means a 3.4 MB bundle (vs ~50 KB for Zod/TypeBox), ~40-50 MB memory per call in a 128 MB Workers isolate, and a minimal lib.d.ts that doesn't cover every TypeScript feature. The tradeoff is worth it when you value zero-DSL DX and tsc-quality diagnostics over minimal bundle size. For size-constrained environments, Zod/TypeBox remain good choices.
   - **No Nebula/framework references in package docs.** The package is standalone — pure functions, no framework imports. Mentioning Nebula in the docs signals "extracted from a monolith" rather than "standalone tool you can adopt." Nebula is great origin-story material for the blog post, but the docs should present `ts-runtime-validator` as a general-purpose library that anyone can use with their own TypeScript interfaces.

2. **Type Support & Validation Boundaries** (`type-support.mdx`) — Comprehensive table of supported types and how each maps from JS values to TypeScript programs, merged with what's checked, what's not, and known limitations. These belong together because a user reading about Map support immediately needs to know the heterogeneous Map limitation. Consolidates:
   - Type mapping tables from Phase 5.2.1
   - Phase 5.2.1 Non-Goals (no `instanceof`, no generics inference, no conditional/mapped types)
   - Phase 5.2.2 Error Type Behavior (structural-only for errors, `Object.assign` excess property limitation)
   - Cycle back-edge placeholder limitation
   - Heterogeneous Map limitation: `Map<string, string | number>` with mixed value types fails because tsc infers V from the first constructor entry. Workaround: use `Map<string, any>`. Homogeneous maps validate correctly. See scratchpad "Heterogeneous Map Validation" for the planned fix — when that lands, update the docs to remove this limitation.

3. **API Reference** (`api-reference.mdx`) — Function signatures, types, and error message guidance in one place. Includes:
   - Summary table at top with links to detailed sections (per project API reference pattern)
   - `validate()`, `toTypeScript()`, `extractTypeMetadata()`, `stripExportsAndImports()` signatures with parameter descriptions and examples
   - `ValidationResult`, `ValidationError`, `TypeMetadata`, `Relationship` type definitions
   - **Reading Error Messages** section: how to interpret `ValidationError` objects, property path extraction, common tsc error codes and what they mean. This fits naturally here — when you look up what `validate()` returns, you want to know how to use the result.

### Key User Guidance to Document

- **Define error shapes as interfaces**, not classes — tsc checks structural assignability, and `toTypeScript()` emits structural shape
- **Use primitive keys for Maps** — object-keyed Maps work for acyclic data but cannot have cycle fixups. `@lumenize/structured-clone` only supports string/number/boolean keys well.
- **Homogeneous Maps validate correctly** — `Map<string, number>` works including wrong-type rejection. Heterogeneous Maps (`Map<string, string | number>`) are a known limitation (see type-support page).
- **Generics must be fully resolved** in type definitions — `interface TodoList { items: Todo[] }` not `interface TodoList<T> { items: T[] }`
- **Custom types must be declared in `typeDefinitions`** — only types in the built-in minimal lib.d.ts are available by default. Any application-specific types (e.g., `RequestSync`, `ResponseSync`) must be included in the `typeDefinitions` string you pass to `validate()`.
- **Rich types (Map, Set, Date) work in `any` fields** — for interfaces like `interface Todo { metadata: any; }`, values containing Maps, Sets, Dates, and cycles all validate correctly via structured-clone serialization

### Notes for Docs Author

- **`validate()` and `extractTypeMetadata()` are two separate functions** — `validate()` runs full tsc type-checking (~15-25ms per call on Cloudflare Workers, measured via external wall-clock; internal `performance.now()` is unreliable in Workers), `extractTypeMetadata()` does AST-only parsing (~0ms, typically called once at startup). They serve different purposes and can be used independently.
- **Minimal lib.d.ts** — the engine embeds a ~4 KB custom lib with primitives, Array, Map, Set, Date, Error types, etc. Not the full lib.es5.d.ts. If a type isn't in our lib, this package won't recognize it. The type-support page should document what's available.

### Reference Links to Include in Docs

- [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) — Cloudflare's original blog post on converting JSON Schema to TypeScript for LLMs
- [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/) — The follow-up with the 32%/81% token reduction numbers

### Code Example Provenance

All code examples must be grounded in real artifacts — no invented snippets. Specifically:

- **Every executable code block** in `.mdx` files uses `@check-example` annotations pointing to tests in `packages/ts-runtime-validator/test/for-docs/`. No `@skip-check` in published docs.
- **Write pedagogical tests** if needed to make the narrative clean. There may not be an existing test that is clear. We often use a test/for-docs sub-folder to write tests that run and pass but whose goal is pedagogical.
- **Type signatures and interface definitions** shown in docs must be copied from the actual source code in `packages/ts-runtime-validator/src/` (e.g., `validate.ts`, `to-typescript.ts`, `extract-type-metadata.ts`). If the source API changes, the docs must be updated to match.
- **Type mapping tables** must reflect the actual behavior in `to-typescript.ts` — the serialization logic is the source of truth for what types are supported and how they map.
- **Error message examples** must come from actual tsc output captured in tests, not hand-crafted approximations.
- **The `test/for-docs/` tests themselves** should use the package's public API (`import { validate, toTypeScript, ... } from '@lumenize/ts-runtime-validator'`) and real type definitions, not simplified stubs.
- **Never use `tooling/doc-testing`** to generate `.mdx` from test files — that tooling is deprecated. Only use `tooling/check-examples` to validate that code blocks in hand-written `.mdx` files match passing tests.
- **Never use TypeDoc** to auto-generate API docs — write the API reference page by hand following the pattern in `website/docs/auth/configuration.mdx`.

## Sidebar

Add `ts-runtime-validator` section to `website/sidebars.ts`.

## Current State (2026-03-25)

All 5 files drafted. Blog posts updated with corrected latency numbers (spike proved ~15-25ms, not ~1ms) and Service Binding approach (not Dynamic Workers).

### Files ready for hand review

1. `website/blog/2026-03-24-typescript-is-the-schema/index.md` — "TypeScript IS the Schema" blog post
2. `website/blog/2026-03-25-write-your-types-once/index.md` — "Write Your Types Once" blog post
3. `website/docs/ts-runtime-validator/index.mdx` — Overview page
4. `website/docs/ts-runtime-validator/type-support.mdx` — Type support & validation boundaries
5. `website/docs/ts-runtime-validator/api-reference.mdx` — API reference

### What changed from spike findings
- **~1ms → ~15-25ms** per validation call (Cloudflare clocks don't advance during sync execution; internal timings were wrong)
- **Dynamic Workers → Service Binding** — plain Worker via Service Binding is simpler, faster for sequential calls, better cold start story
- Both blog posts already updated with these corrections

## Remaining Work

### After hand review
- [x] All `@skip-check` converted to `@check-example` — zero remaining
- [ ] `npm run check-examples` passes (verify after any review edits)
- [ ] `npm run build` (website) passes
- ~~Cross-post to Substack (new channel — set up as part of this task)~~ — dropped 2026-04-15; new posts will cover the typia engine launch
- ~~Cross-post to Medium (explore automating via Medium API or MCP server + Claude co-work)~~ — dropped 2026-04-15; new posts will cover the typia engine launch

## Success Criteria

### Blog Posts
- [x] Blog posts drafted in `/website/blog/` (Docusaurus blog format)
- [x] Narrative arc: code mode insight → "why not skip JSON Schema entirely?" → how it works → quick example → tradeoffs → link to package docs
- [x] Links to Cloudflare code mode blog posts as prior art
- [x] Links to package docs for API reference and detailed type support
- [x] Honest about tradeoffs (bundle size, memory, minimal lib.d.ts)
- [x] Latency numbers corrected per spike findings (~15-25ms, not ~1ms)
- [x] Service Binding framing (not Dynamic Workers)
- [ ] Hand review by Larry
- ~~Cross-post to Substack~~ — dropped; superseded by typia engine launch posts
- ~~Cross-post to Medium~~ — dropped; superseded by typia engine launch posts

### Package Documentation
- [x] All 3 pages created in `/website/docs/ts-runtime-validator/`
- [x] All code examples validated with `@check-example` annotations pointing to `test/for-docs/` tests
- [ ] All type signatures and interfaces match actual source code in `packages/ts-runtime-validator/src/`
- [ ] All error message examples come from real tsc output captured in tests
- [ ] `test/for-docs/` tests use public API imports, not internal modules
- [x] No use of deprecated `tooling/doc-testing` or TypeDoc
- [ ] `npm run check-examples` passes
- [ ] `npm run build` (website) passes
- [x] Sidebar updated in `website/sidebars.ts`
- [ ] Package `README.md` updated with link to website docs
- [x] Docs overview links to blog post for the "why" rationale
- [x] Blog post links to docs for API details and type support
- [ ] Hand review by Larry
