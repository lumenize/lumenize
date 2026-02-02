---
name: doc-example-audit
description: Audit @skip-check annotations in .mdx files — categorize each block and produce a prioritized conversion plan. Use before starting Phase 2 doc work.
context: fork
agent: Explore
model: haiku
argument-hint: [mdx-file-path or package-name]
---

# Doc Example Audit

Audit `@skip-check` annotations in `.mdx` files and produce a categorized report for interactive conversion.

## Input

`$ARGUMENTS` is an optional `.mdx` file path or package name.

- If a **file path** is provided (e.g., `website/docs/auth/api-reference.mdx`), audit only that file.
- If a **package name** is provided (e.g., `auth`), audit all `.mdx` files under `website/docs/{package-name}/`.
- If **no argument** is provided, audit all `@skip-check` annotations across `website/docs/`.

## Audit Procedure

For each code block annotated with `@skip-check`:

1. **Record its location**: file path, line number, language tag, and a 2-3 line preview of the code block content.

2. **Check for an approximate match in existing tests**: Look in `packages/{package-name}/test/for-docs/` for a test file whose name mirrors the doc file (e.g., `api-reference.mdx` → `api-reference.test.ts`). Also check for test files that contain code approximately matching the block's content.

3. **Categorize** into one of four buckets:

   - **Mechanical**: A matching test file exists in `test/for-docs/` and the code block is clearly a subset of the test code or would be with a change that still satisfies the pedagogical purpose of the example. Ready for direct conversion to `@check-example('path/to/test.ts')`.

   - **Needs new test**: No matching test file found. Converting this block requires creating a new test file in `test/for-docs/`.

   - **Ambiguous**: The code block doesn't clearly match any existing test, or may contain errors, or could match multiple tests. It might also match if the example was altered but you are unsure if the altered version would still serve the pedagogical purpose. Needs interactive review in the main session.

   - **Candidate for `@skip-check-approved`**: The code block is too small, purely conceptual, or pedagogical (pseudo-code, architecture diagrams, config snippets) to warrant a real test. Suggest `@skip-check-approved('reason')` with a reason like `'conceptual'`, `'pseudo-code'`, `'config-only'`, or `'type-signature'`.

## Convention

Test file naming mirrors doc file naming:
- `getting-started.mdx` → `getting-started.test.ts` or `getting-started/index.test.ts`
- `api-reference.mdx` → `api-reference.test.ts`
- `advanced-patterns.mdx` → `advanced-patterns.test.ts`

For the exemplar of what good `for-docs/` tests look like, reference `packages/mesh/test/for-docs/getting-started/` — it has its own `wrangler.jsonc`, worker entry point, DO classes, and phased narrative tests.

## Output Format

Produce a prioritized report grouped by category:

### Mechanical (ready for conversion)
For each block:
- File: `website/docs/{package}/{file}.mdx`, line {N}
- Preview: (first 2-3 lines of the code block)
- Matching test: `packages/{package}/test/for-docs/{test-file}.test.ts`
- Action: Replace `@skip-check` with `@check-example('packages/{package}/test/for-docs/{test-file}.test.ts')`. Possibly also suggested change to the example and/or test.

### Needs new test
For each block:
- File: `website/docs/{package}/{file}.mdx`, line {N}
- Preview: (first 2-3 lines of the code block)
- Suggested test file: `packages/{package}/test/for-docs/{suggested-name}.test.ts`
- Notes: (what the test would need to cover)

### Ambiguous (needs interactive review)
For each block:
- File: `website/docs/{package}/{file}.mdx`, line {N}
- Preview: (first 2-3 lines of the code block)
- Issue: (why it's ambiguous — e.g., "code doesn't match any existing test" or "possible error in example")

### Candidate for @skip-check-approved
For each block:
- File: `website/docs/{package}/{file}.mdx`, line {N}
- Preview: (first 2-3 lines of the code block)
- Suggested reason: `'conceptual'` | `'pseudo-code'` | `'config-only'` | `'type-signature'`

### Summary
- Total `@skip-check` blocks found: {N}
- Mechanical: {N}
- Needs new test: {N}
- Ambiguous: {N}
- Candidate for approved skip: {N}

## Rules

- **Never edit files** — this is a read-only audit.
- Report what you find accurately. Do not invent matching tests that don't exist.
