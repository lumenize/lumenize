---
name: convert-doc-examples
description: Convert audited @skip-check code blocks into @check-example annotations or flag @skip-check-approved candidates for human approval. Use after /doc-example-audit, before publishing docs.
argument-hint: [package-name or mdx-file-path]
---

# Convert Doc Examples

Phase 2 of the documentation workflow. Takes an audit (from `/doc-example-audit`) and converts each `@skip-check` block into `@check-example('path')` with a real target file, or flags it as a `@skip-check-approved` candidate for the human to approve.

## Preflight — re-read these before editing

Context drifts; the matching rules are easy to forget. Before making any edits, re-read:

- [.claude/rules/documentation.md](.claude/rules/documentation.md) §Check-Example Matching Behavior
- [tooling/check-examples/README.md](tooling/check-examples/README.md) §Design Decisions

Key reminders that catch me out:
- **Comments are stripped before matching.** `// ...` at the start or end of a doc block is redundant — use it only BETWEEN meaningful lines to skip boilerplate.
- **Imports are stripped.** Don't pad doc blocks to match import lines.
- **Type parameters are stripped.**
- **Substring match** after normalization — doc code must appear inside the target file.
- **Ellipsis wildcards** (`// ...`, `/* ... */`) between lines become regex wildcards.

## `@check-example` targets: not just tests

`@check-example('path')` accepts any file. Pick the file whose contents the doc block naturally lives in:

- **Test files** — usage examples, behavior demos (most common).
- **Type-definition source files** (`src/types.ts`, `src/index.ts`) — doc blocks that show interfaces, type aliases, API signatures. Prefer these over synthetic tests for pure type content; the source is single-source-of-truth.
- **Implementation source** — when a doc block is literally quoting a function signature or constant.
- **Config files** (`wrangler.jsonc`, `package.json`) — doc blocks showing config.

When the block is a type definition or API signature, default to the source file, not a test.

## Editing source to serve doc pedagogy

Doc blocks are pedagogical. If the current source shape hurts the doc's flow, modify the source (within reason):

- Reorder interface fields so the doc's "first, …, last" presentation matches.
- Split a monolithic type into smaller named types if the doc introduces them incrementally.
- Add explanatory comments to the source that the doc block wants to show.
- **Reorder a test's assertions so the doc-relevant ones come first.** When an existing test already covers the example, the doc only needs to show one or two headline assertions. Put those at the top of the test's assertion list, then the doc block truncates there and substring-matches the prefix. The test keeps its full coverage; the doc shows the pedagogically-minimum subset. Often requires touching most tests in the file.

Don't refactor source into a worse shape just to serve a lazy doc. If the source reads well and only the doc is awkward, fix the doc.

## Comment placement

The strip-comments rule means a comment in the doc block that isn't in the source still passes — which is a trap. Useful comments often belong in BOTH the source and the doc, or primarily the source.

Heuristic: if a comment explains *why* something is shaped this way, it's permanent — put it in the source. If it's explaining *what this line does* to a learner, doc-only is fine.

## Default to `@check-example`, not `@skip-check-approved`

`@skip-check-approved` is human-only. I can only recommend; the human applies.

**Reset the default:** if ANY part of the block is executable (type declarations count), try `@check-example` first. Only recommend `@skip-check-approved` when the block is genuinely non-executable:

- Architecture / flow diagrams (mermaid usually auto-skips anyway).
- Pseudo-code.
- CLI snippets not worth testing.
- Content whose value is the narrative arrangement, not the code.

When unsure, the answer is `@check-example` pointing at whatever source file most closely holds the content.

## Bugs discovered during conversion

Sometimes the doc example describes *intended* behavior and the code has a bug. The temptation is to align the example with current (buggy) behavior — which hides the bug and degrades DX.

The key property is: **surface the discrepancy in some form.** What "surface" means varies with how blocking the bug is.

**Default — log and keep going.** If the bug is localized and doesn't block remaining conversions:
- Log the discrepancy (file, line, doc-says-X, code-does-Y, what-the-doc-expected) — ideally in a running "bugs found during conversion" list this session.
- Leave that block at `@skip-check` with a short note naming the discrepancy.
- Continue with the next block.
- At session end, surface the full list to the user for triage.

**Stop and surface immediately when:**
- The bug blocks further conversions in this file (e.g., the broken API is referenced by most remaining examples).
- The fix is large enough that accumulating a backlog would be worse than handling it now.
- You can't tell whether the doc or the code is right — you need direction before making more assumptions.

**Never silently paper over.** Rewriting the example to match buggy behavior is the failure mode to avoid. Interactive pause is one way to avoid it; logged-and-continued is another. Silent-edit is not.

## Workflow

1. **Preflight** — re-read the two rules files above.
2. **Process audit results** in priority order (Mechanical → Needs new test → Ambiguous → Approved-skip candidates):
   - Decide target file.
   - Check matching mentally using the normalization rules.
   - Apply source edits only if they improve pedagogy without degrading the source.
   - If a bug surfaces, stop and surface to the user.
3. **Validate** — `cd website && npm run check-examples` from the repo root.
4. **Final gate** — `cd website && npm run build` before publishing.

## Output

- `.md` / `.mdx` edits replacing `@skip-check` with `@check-example('...')`.
- Source-file edits where pedagogy warrants (flag these clearly).
- New `test/for-docs/` files where no suitable target exists.
- A list of `@skip-check-approved` recommendations with suggested reasons, for human review.
- A list of bugs surfaced during conversion with locations and suggested dispositions.
