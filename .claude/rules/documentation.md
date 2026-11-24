---
paths:
  - "website/**"
  - "**/*.mdx"
  - "**/for-docs/**"
---

# Documentation Rules

## Philosophy
Documentation quality is ensured by custom Docusaurus tooling that guarantees all code examples are tested and working. The website at https://lumenize.com is the single source of truth for user-facing docs.

## Where documentation lives
- **Website docs**: `/website/docs/[package-name]/*.md` — all user-facing documentation. New files MUST be added to `website/sidebars.ts` (the sidebar is not auto-populated). Frontmatter `title`/`description` MUST be set; link between pages with inline relative links. (`.md` vs `.mdx`: see § *Writing Docs*.)
- **Package `README.md`**: minimal — name, de✨light✨ful tagline, link to website docs, key features, install.

## Style
- **Mermaid diagrams** — you MUST follow the traps + the post-edit render-safety grep in [workflow.md](workflow.md) § Design-first (no `;` in `Note` text), and MUST confirm every block renders before done. Same rule whether the diagram is in a task file or a doc page.
- **Inline links SHOULD be preferred** over "See Also" / "Next Steps" sections at the end of files — sidebar ordering handles navigation, and end-of-file link sections go stale unnoticed.
- **Temporary docs MUST NOT be created** in package directories (`IMPLEMENTATION.md`, `FEATURE_GUIDE.md`, progress reports, compatibility matrices). Focus on user-facing content: overview, basic usage, API, advanced use cases, migration, types, security considerations.

## Documentation workflow
1. **Narrative first** — draft in `.md` with `@skip-check`.
2. **Make examples real** — create `test/for-docs/` mini-apps (see [testing.md](testing.md)).
3. **Validate** — `cd website && npm run check-examples`.
4. **Build** — `cd website && npm run build`.

## Code example validation
Link code blocks to a passing test (or source in the case of type definitions) with `@check-example`:
````markdown
```typescript @check-example('packages/rpc/test/for-docs/basic-usage.test.ts')
const result = await client.echo('Hello');
expect(result).toBe('DO echoed: Hello');
```
````

## Skip-Check Annotations

Three annotation levels for code blocks in `.md` / `.mdx` files:

1. **`@check-example('path/to/test.ts')`** — Verified against a passing test. MUST be present on all executable code examples before publishing.
2. **`@skip-check-approved('reason')`** — Human-reviewed and approved skip. Only humans MAY add this annotation. Valid reasons: `'conceptual'`, `'pseudo-code'`, etc.
3. **`@skip-check`** — Work-in-progress. MAY be used during Phase 1 drafting. MUST be converted to `@check-example` or `@skip-check-approved` before publishing.

**Rules:**
- `@skip-check` MUST NOT be added to final/published examples without asking the user first
- `@skip-check-approved` MUST NOT be added by you — only humans MAY approve skips
- During Phase 1 narrative drafting, `@skip-check` is temporary and MUST be replaced in Phase 2
- `node tooling/check-examples/src/index.js --report` SHOULD be run to audit remaining `@skip-check` annotations
- **`@check-example` guards only fenced code blocks, never prose.** When you remove or rename an exported symbol, you MUST also `grep` the docs for prose mentions (tables, inline text, ASCII diagrams) — a green `check-examples` run proves nothing about them, and a stale class/function name in prose will silently survive.
- **`@check-example` proves the doc MIRRORS the code, never that the code RUNS.** The checker reads the referenced file and text-matches; it executes nothing. This is fine — indeed the intended use — for the two target kinds where "does it run?" is the wrong question or is answered elsewhere:
  - **Type declarations** (`packages/*/src/types.ts`, …) — declarations don't execute, and mirroring one is exactly the point.
  - **Production `src/`** — it has its own test and coverage story, so unexercised code there is caught by other means.

  The gap is specific to a **`test/for-docs/**` implementation fixture** (a mini-app's DO / Worker / client), which exists for no reason *except* to be exercised by its sibling narrative test. There, dead code is invisible by construction: the doc can teach a method no test ever calls, and the green check reads as verification. **Pointing at a *test* is strictly stronger and SHOULD be preferred whenever the example can be phrased as something the test does.** When the example must be the fixture (a class definition, a guard function), the `@check-example` is only half the job: you MUST confirm the sibling test actually drives it. Bit 2026-07-31 — four doc-taught functions in `mesh/test/for-docs/security/team-doc-do.ts` at zero hits behind green blocks, one of them a `TODO` never implemented. See [testing.md](testing.md) § `for-docs/` tests are mini-apps.

## Check-Example Matching Behavior

The checker normalizes both doc code and test/source code before matching. See `tooling/check-examples/README.md` for full details.

- **Comments stripped**: All comments are removed before matching, so use `// ...` between lines to skip over intervening code
- **Imports stripped**: Import statements are removed, so doc blocks don't need to match import lines in the source
- **Type parameters stripped**: Generic type params are removed during normalization
- **Whitespace normalized**: Minor formatting differences are tolerated
- **Substring matching**: Doc code must appear as a substring of the source/test file after normalization
- **Ellipsis wildcards**: `// ...` or `/* ... */` between lines become regex wildcards (`.*?`) to skip over code you don't want to show

**Common mistakes to avoid:**
- `// ...` MUST NOT be added at the very start or end of a code block — it's unnecessary since comments are stripped
- Code MUST NOT be wrapped in extra `// ...` lines just to "anchor" the match — substring matching handles this
- `// ...` MAY be used between meaningful lines to skip boilerplate (e.g., showing first and last properties of an interface)
- **`// ...` MUST NOT be used to absorb source that GREW.** The whole point of `@check-example` is to fail when the code changes and the doc hasn't caught up. If a block stops matching because the source gained a field/line/param, **it MUST be added to the doc** for an exact mirror; a `// ...` MUST NOT be dropped in to skip the new content (that silently switches the check off for that region; future additions drift in unseen). `// ...` is for *deliberately omitting content that exists now*, never a placeholder for what might appear later. A trailing `// ...` on a block meant to be complete (a small interface, a full signature) is the tell you're hiding drift.

## Writing Docs

- `.md` files MUST be written in `/website/docs/[package-name]/`.
- `.mdx` MAY be used only with explicit human approval — reserved for pages that truly need JSX components, imports, or expression interpolation. Most admonitions and HTML work in plain `.md`. Note, existing `.mdx` pages stay `.mdx`; new pages default to `.md`
- API reference pages MUST be written by hand as `api-reference.md` (see `website/docs/ts-runtime-parser-validator/api-reference.md` for the pattern)
- TypeDoc MUST NOT be used to auto-generate API docs — it is deprecated for this project
- `doc-testing` MUST NOT be used to generate docs from test files — it is deprecated for this project
- Some older packages still have files generated by deprecated tooling (marked with `generated_by: doc-testing` frontmatter) — those MUST NOT be hand-edited

## Admonitions

Canonical Docusaurus v3 (3.9.x) form — title in brackets, blank lines around the body, `warning` not the deprecated `caution` (the five v3 types: `note`, `tip`, `info`, `warning`, `danger`):

````markdown
:::warning[Title here]

Body on its own line, with a blank line after the opener and before the closer.

:::
````

The space-form title (`:::warning Title`) is legacy v2 syntax — it still renders, and older files still use it; new/edited blocks MUST follow the canonical form, and legacy ones MUST NOT be mass-rewritten unless asked. When moving an admonition's content under a `##` heading for the same topic, the `:::` wrapper MUST be dropped — the heading already signals attention, and an admonition MUST NOT be nested inside its own section.

## API Reference Pattern

For packages with public APIs, create a dedicated `api-reference.md` page — canonical example: [ts-runtime-parser-validator/api-reference.md](../../website/docs/ts-runtime-parser-validator/api-reference.md) — with:
- **A summary table** with anchor links to the sections below MAY be added — most useful when the page has several surfaces
- **Environment variables table** if applicable
- **Function signatures** with options and defaults
- **Detailed sections** for each endpoint/function with request/response examples

This hand-written `api-reference.md` is the canonical home for documented signatures and examples — JSDoc SHOULD stay thin and `@see`-link here rather than duplicating detail (or long examples) in source comments. For JSDoc style itself (what to write vs. omit), see [coding-style.md](coding-style.md).

## Sidebars

`website/sidebars.ts` MUST be updated when adding or removing doc files. Docusaurus is configured to NOT auto-populate the sidebar.

## Validation

```bash
# Fast validation during development
cd website && npm run check-examples

# Human checking/reading
cd website && npm run start

# Full website build
cd website && npm run build
```
