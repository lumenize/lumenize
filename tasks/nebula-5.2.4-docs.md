# Phase 5.2.4: `@lumenize/ts-runtime-validator` Documentation & Blog Post

**Status**: Pending
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
   - **Ontology Integration** (brief paragraph): Explain that `@lumenize/nebula`'s `Ontology` class uses `validate()` for per-transaction type checking and `extractTypeMetadata()` for relationship discovery and write-shape generation. Link to Nebula docs for the full ontology story. This keeps the context without a separate page that would couple nebula-specific concerns into a pure-function library's docs.

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
- **Lumenize-specific types** (`RequestSync`, `ResponseSync`) must be declared in the `typeDefinitions` string — they're not in the built-in lib
- **Rich types (Map, Set, Date) work in `any` fields** — for ontology types like `interface Todo { metadata: any; }`, values containing Maps, Sets, Dates, and cycles all validate and round-trip through storage correctly via structured-clone serialization

### Notes for Docs Author

- **`validate()` and `extractTypeMetadata()` are two separate functions** — `validate()` runs full tsc type-checking (~1ms per call), `extractTypeMetadata()` does AST-only parsing (~0ms, called once at ontology construction). The `Ontology` class in `apps/nebula/` coordinates both.
- **Minimal lib.d.ts** — the engine embeds a ~4 KB custom lib with primitives, Array, Map, Set, Date, Error types, etc. Not the full lib.es5.d.ts. If a type isn't in our lib, tsc won't recognize it. The type-support page should document what's available.

### Reference Links to Include in Docs

- [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) — Cloudflare's original blog post on converting JSON Schema to TypeScript for LLMs
- [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/) — The follow-up with the 32%/81% token reduction numbers

### Code Example Provenance

All code examples must be grounded in real artifacts — no invented snippets. Specifically:

- **Every executable code block** in `.mdx` files uses `@check-example` annotations pointing to tests in `packages/ts-runtime-validator/test/for-docs/`. No `@skip-check` in published docs.
- **Type signatures and interface definitions** shown in docs must be copied from the actual source code in `packages/ts-runtime-validator/src/` (e.g., `validate.ts`, `to-typescript.ts`, `extract-type-metadata.ts`). If the source API changes, the docs must be updated to match.
- **Type mapping tables** must reflect the actual behavior in `to-typescript.ts` — the serialization logic is the source of truth for what types are supported and how they map.
- **Error message examples** must come from actual tsc output captured in tests, not hand-crafted approximations.
- **The `test/for-docs/` tests themselves** should use the package's public API (`import { validate, toTypeScript, ... } from '@lumenize/ts-runtime-validator'`) and real type definitions, not simplified stubs.
- **Never use `tooling/doc-testing`** to generate `.mdx` from test files — that tooling is deprecated. Only use `tooling/check-examples` to validate that code blocks in hand-written `.mdx` files match passing tests.
- **Never use TypeDoc** to auto-generate API docs — write the API reference page by hand following the pattern in `website/docs/auth/configuration.mdx`.

## Sidebar

Add `ts-runtime-validator` section to `website/sidebars.ts`.

## Success Criteria

### Blog Post
- [ ] Blog post drafted in `/website/blog/` (Docusaurus blog format)
- [ ] Narrative arc: code mode insight → "why not skip JSON Schema entirely?" → how it works → quick example → tradeoffs → link to package docs
- [ ] Links to Cloudflare code mode blog posts as prior art
- [ ] Links to package docs for API reference and detailed type support
- [ ] Honest about tradeoffs (bundle size, memory, minimal lib.d.ts)
- [ ] Cross-post to Substack (new channel — set up as part of this task)
- [ ] Cross-post to Medium (explore automating via Medium API or MCP server + Claude co-work)

### Package Documentation
- [ ] All 3 pages created in `/website/docs/ts-runtime-validator/`
- [ ] All code examples validated with `@check-example` annotations pointing to `test/for-docs/` tests
- [ ] All type signatures and interfaces match actual source code in `packages/ts-runtime-validator/src/`
- [ ] All error message examples come from real tsc output captured in tests
- [ ] `test/for-docs/` tests use public API imports, not internal modules
- [ ] No use of deprecated `tooling/doc-testing` or TypeDoc
- [ ] `npm run check-examples` passes
- [ ] `npm run build` (website) passes
- [ ] Sidebar updated in `website/sidebars.ts`
- [ ] Package `README.md` updated with link to website docs
- [ ] Docs overview links to blog post for the "why" rationale
- [ ] Blog post links to docs for API details and type support
