---
name: review-skip-check-approved
description: Verify @skip-check-approved code examples against actual source code — catch stale or incorrect examples before release. Use as a pre-release check.
context: fork
agent: Explore
model: sonnet
argument-hint: [diff-base or package-name]
---

# Review Skip-Check-Approved

Verify that `@skip-check-approved` code examples in `.mdx` files still accurately reflect the actual source code. These examples were deliberately excluded from automated testing, so this review is the safety net that catches drift.

## Input

`$ARGUMENTS` is optional and controls scope:

- If a **branch or ref** is provided (e.g., `main`), scope to packages whose source changed: run `git diff $ARGUMENTS...HEAD --name-only` and only review `@skip-check-approved` blocks in docs for packages with changed `packages/{name}/src/` files.
- If a **package name** is provided (e.g., `mesh`), review all `@skip-check-approved` blocks under `website/docs/{package-name}/`.
- If a **file path** is provided (e.g., `website/docs/auth/getting-started.mdx`), review only that file.
- If **no argument** is provided, review all `@skip-check-approved` blocks across `website/docs/`.

### Detecting the argument type

- Looks like a file path → contains `/` and ends in `.mdx`
- Looks like a git ref → run `git rev-parse --verify $ARGUMENTS` — if it succeeds, treat as diff base
- Otherwise → treat as a package name

## Review Procedure

For each code block annotated with `@skip-check-approved`:

### 1. Understand the example

Read the code block and its surrounding prose context in the `.mdx` file. Understand what API, pattern, or concept it's demonstrating.

### 2. Find the corresponding source code

Locate the actual implementation the example refers to. Common locations:

- `packages/{package-name}/src/` — the primary source
- Type definitions, exported interfaces, class methods
- If the example shows usage patterns, find the API surface it's calling

### 3. Verify accuracy

Check whether the example still correctly reflects the real code:

- **Method/function names** — do they still exist? Same signature?
- **Parameter names and types** — do they match?
- **Return types and shapes** — does the example show the right structure?
- **Behavioral claims** — does the prose around the example make promises the code keeps?
- **Import paths** — are package names and export names correct?
- **Options/config shapes** — do the properties and defaults match?

### 4. Classify the result

- **Verified OK** — the example accurately reflects the current source code.
- **Possibly stale** — something doesn't match. Describe specifically what's wrong (e.g., "method was renamed from `foo` to `bar`", "parameter `options.retries` no longer exists", "return type changed from `string` to `string | null`").
- **Cannot verify** — the example is too abstract/conceptual to trace to specific source, or the source is in a package you can't find. Note what you tried.

## Output Format

### Verified OK
List these concisely — one line per block:
- `website/docs/{package}/{file}.mdx`, line {N} — OK

### Possibly Stale
For each block, provide enough detail to act on:
- **File**: `website/docs/{package}/{file}.mdx`, line {N}
- **Example shows**: (brief description of what the code block claims)
- **Actual source**: `packages/{package}/src/{file}.ts`, line {N}
- **Issue**: (specific discrepancy — what changed)

### Cannot Verify
- **File**: `website/docs/{package}/{file}.mdx`, line {N}
- **Reason**: (why verification wasn't possible)

### Summary
- Total `@skip-check-approved` blocks reviewed: {N}
- Verified OK: {N}
- Possibly stale: {N}
- Cannot verify: {N}

## Scoping via Diff (when a git ref is provided)

1. Run `git diff {ref}...HEAD --name-only` to get changed files.
2. Extract package names from paths matching `packages/{name}/src/**`.
3. Only review `@skip-check-approved` blocks in `website/docs/{name}/**/*.mdx` for those packages.
4. Also review docs files that themselves changed: any `.mdx` files in the diff that contain `@skip-check-approved`.
5. Report the scope at the top of the output: which packages and files were reviewed and why.

## Rules

- **Never edit files** — this is a read-only review.
- **Be specific about discrepancies** — "possibly wrong" isn't helpful. Say exactly what doesn't match.
- **Read the actual source** — don't guess from memory. Open the source file and verify.
- **Check the approved reason** — if the reason is `'conceptual'` or `'pseudo-code'`, the example may be intentionally simplified. Focus on whether the simplification is still *correct*, not whether it's *complete*.
- **Don't flag style differences** — if the example uses `const` where source uses `let`, or omits error handling, that's fine. Focus on semantic accuracy.
