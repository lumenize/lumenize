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
- **Website docs**: `/website/docs/[package-name]/*.md` — all user-facing documentation. Add new files to `website/sidebars.ts` (the sidebar is not auto-populated). Use frontmatter `title`/`description`; link between pages with inline relative links. (`.md` vs `.mdx`: see § *Writing Docs*.)
- **Package `README.md`**: minimal — name, de✨light✨ful tagline, link to website docs, key features, install.

## Style
- **Prefer inline links** over "See Also" / "Next Steps" sections at the end of files — sidebar ordering handles navigation, and end-of-file link sections go stale unnoticed.
- **Never create temporary docs** in package directories (`IMPLEMENTATION.md`, `FEATURE_GUIDE.md`, progress reports, compatibility matrices). Focus on user-facing content: overview, basic usage, API, advanced use cases, migration, types, security considerations.

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

1. **`@check-example('path/to/test.ts')`** — Verified against a passing test. Required for all executable code examples before publishing.
2. **`@skip-check-approved('reason')`** — Human-reviewed and approved skip. Only humans may add this annotation. Valid reasons: `'conceptual'`, `'pseudo-code'`, etc.
3. **`@skip-check`** — Work-in-progress. Acceptable during Phase 1 drafting. Must be converted to `@check-example` or `@skip-check-approved` before publishing.

**Rules:**
- Never add `@skip-check` to final/published examples without asking the user first
- Never add `@skip-check-approved` — only humans may approve skips
- During Phase 1 narrative drafting, `@skip-check` is temporary and must be replaced in Phase 2
- Run `node tooling/check-examples/src/index.js --report` to audit remaining `@skip-check` annotations

## Check-Example Matching Behavior

The checker normalizes both doc code and test/source code before matching. See `tooling/check-examples/README.md` for full details.

- **Comments stripped**: All comments are removed before matching, so use `// ...` between lines to skip over intervening code
- **Imports stripped**: Import statements are removed, so doc blocks don't need to match import lines in the source
- **Type parameters stripped**: Generic type params are removed during normalization
- **Whitespace normalized**: Minor formatting differences are tolerated
- **Substring matching**: Doc code must appear as a substring of the source/test file after normalization
- **Ellipsis wildcards**: `// ...` or `/* ... */` between lines become regex wildcards (`.*?`) to skip over code you don't want to show

**Common mistakes to avoid:**
- Don't add `// ...` at the very start or end of a code block — it's unnecessary since comments are stripped
- Don't wrap code in extra `// ...` lines just to "anchor" the match — substring matching handles this
- Do use `// ...` between meaningful lines to skip boilerplate (e.g., showing first and last properties of an interface)
- **Never use `// ...` to absorb source that GREW.** The whole point of `@check-example` is to fail when the code changes and the doc hasn't caught up. If a block stops matching because the source gained a field/line/param, **add it to the doc** for an exact mirror — do NOT drop in a `// ...` to skip the new content (that silently switches the check off for that region; future additions drift in unseen). `// ...` is for *deliberately omitting content that exists now*, never a placeholder for what might appear later. A trailing `// ...` on a block meant to be complete (a small interface, a full signature) is the tell you're hiding drift.

## Writing Docs

- Write `.md` files in `/website/docs/[package-name]/`. 
- Use `.mdx` only with explicit human approval — reserved for pages that truly need JSX components, imports, or expression interpolation. Most admonitions and HTML work in plain `.md`. Note, existing `.mdx` pages stay `.mdx`; new pages default to `.md`
- Write API reference pages by hand as `api-reference.md` (see `website/docs/ts-runtime-parser-validator/api-reference.md` for the pattern)
- Never use TypeDoc to auto-generate API docs — it is deprecated for this project
- Never use `doc-testing` to generate docs from test files — it is deprecated for this project
- Some older packages still have files generated by deprecated tooling (marked with `generated_by: doc-testing` frontmatter) — do not hand-edit those

## Admonitions

Canonical Docusaurus v3 (3.9.x) form — title in brackets, blank lines around the body, `warning` not the deprecated `caution` (the five v3 types: `note`, `tip`, `info`, `warning`, `danger`):

````markdown
:::warning[Title here]

Body on its own line, with a blank line after the opener and before the closer.

:::
````

The space-form title (`:::warning Title`) is legacy v2 syntax — it still renders, and older files still use it; follow the canonical form for new/edited blocks but don't mass-rewrite legacy ones unless asked. When moving an admonition's content under a `##` heading for the same topic, drop the `:::` wrapper — the heading already signals attention; don't nest an admonition inside its own section.

## API Reference Pattern

For packages with public APIs, create a dedicated `api-reference.md` page — canonical example: [ts-runtime-parser-validator/api-reference.md](../../website/docs/ts-runtime-parser-validator/api-reference.md) — with:
- **Consider a summary table** with anchor links to the sections below — most useful when the page has several surfaces
- **Environment variables table** if applicable
- **Function signatures** with options and defaults
- **Detailed sections** for each endpoint/function with request/response examples

This hand-written `api-reference.md` is the canonical home for documented signatures and examples — keep JSDoc thin and let it `@see`-link here rather than duplicating detail (or long examples) in source comments. For JSDoc style itself (what to write vs. omit), see [coding-style.md](coding-style.md).

## Sidebars

Update `website/sidebars.ts` when adding or removing doc files. Docusaurus is configured to NOT auto-populate the sidebar.

## Validation

```bash
# Fast validation during development
cd website && npm run check-examples

# Human checking/reading
cd website && npm run start

# Full website build
cd website && npm run build
```
