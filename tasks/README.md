# Task File Templates & Conventions

**Process lives in the `/task-management` skill** (`.claude/skills/task-management/SKILL.md`) — workflow selection, review → go, phase retros. Folder structure is in `.claude/rules/workflow.md`. This file holds only the **templates** and **phrasing conventions** for the task files themselves.

## Archive is frozen

A file moved to `tasks/archive/` is a point-in-time record — it starts going stale immediately, and that's by design. **Never update archived files**: no link fixups when referenced files move, no terminology syncs, no corrections when code drifts. Sole exception: a dated one-line status/superseded banner at the top when a later decision overturns one — added at the moment of supersession, touching nothing else. If a decision in an archived file must stay *live* (still constrains new work), its home is an ADR (`docs/adr/README.md` has the bar) or a rule, not edits to the archive.

## Backlog: delete completed rows, don't mark them

`backlog.md` tracks only OPEN work. When a row is done, **delete it** — never leave it as `[x]` / "DONE" (a completed row checked-in-place re-reads as live every session = clutter). If finishing a row leaves *residual* open work, lift that into its own fresh `[ ]` row and delete the original. Capture the completed work's durable nuggets where they actually live — an archived task file, an ADR/rule, a memory, or a status note in the relevant master plan — never as a checked backlog row.

## Cut/deferred phases: confirm the home, then DELETE — don't tombstone

Same principle inside an active task file. When a phase or section is **cut** (won't be built) or **deferred** (built later, elsewhere), delete it — don't leave a `~~struck~~ ✅ CUT/DEFERRED` tombstone. A tombstone is decision-history: it re-reads every session as "there was a Phase 4," and the suffix scars it leaves (`1a`/`4b` with no sibling) are numbering-history of their own. **One-step safety check first: confirm the still-to-do part has a home somewhere else** — a backlog row, another task file, an ADR/rule — *then* delete; the reasoning for a cut (the rejected alternative + why) belongs in the file's Decisions table as a single line, not a dead phase. After deleting, **renumber to a clean sequence** and grep every cross-reference (in-file *and* other files/backlog) so nothing is stranded. (The reflex to keep a stub "so git-history references keep resolving" is wrong — commit messages are point-in-time records read in their own context; the live doc owes them no fidelity.)

## Templates

### Docs-First Task File

For user-facing API changes. The docs dominate; task file holds implementation details.

```markdown
# [Project Name]

**Status**: Design Complete | In Progress | Complete
**Design Document**: `/website/docs/[package]/[feature].md`

## Goal
[One sentence - what capability are we adding?]

## Design Principles (See docs for Details)
1. [Key principle 1]
2. [Key principle 2]

## Prerequisites
- [ ] Design documented in the website docs
- [ ] API finalized with maintainer

## Implementation Phases

### Phase 1: [Name]
**Goal**: [What this achieves]

**Success Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

### Phase 2: [Name]
...

### Final Verification (every phase)
- [ ] All tests pass (`npx vitest run` in package dir)
- [ ] Type-check clean (`npm run type-check`)
- [ ] Docs match implementation: grep `website/docs/[package]/` for keywords from changed APIs
- [ ] JSDoc comments in source reflect current behavior
```

### Task-File-First Task File

For internal work (refactoring, bug fixes, tooling) — the task file is the sole design artifact.

```markdown
# [Project Name]

## Objective
[Brief description]

## Phase 1: [Name]
**Goal**: [What this achieves]

**Success Criteria**:
- [What indicates completion]

## Phase 2: [Name]
...

## Notes
- Design decisions
- Trade-offs
```

## Phrasing Conventions

### Inventories: prefer "all files matching" over counts

When a task lists files (or symbols, or call sites) to migrate, prefer a verifiable description over a numeric count:

- ✅ "Migrate **all test files referencing `SELF.fetch('/parse')`** — run `grep -l \"SELF.fetch('/parse')\" test/` to enumerate"
- ❌ "Migrate **the 5 test files** off `SELF.fetch('/parse')`"

Counts are written-time snapshots. They go stale (someone adds a 6th file before you start) or are wrong on entry (the original author missed some). The success criterion "All N migrated" silently passes when the count was wrong. A description-plus-grep makes the inventory self-verifying at task-execution time.

If you need a count for scoping ("this is small, ~5 files"), include it as commentary, not as the inventory:

> "Migrate all files matching `grep -l 'X' test/` (\~5 files at time of writing)."

### Anchor code citations on symbol + quoted fragment, NOT line numbers

Same failure mode as counts, one level down. A `file.ts:734` reference into source **rots before `/build-task` runs** — and worse than a stale count, a wrong line number can point at *different, plausible* code, turning a "pin this, don't delete it" instruction into a booby trap. (Bit 2026-07-21: a 🚨 safety pin read `registry:735-737`; a sweep commit **in the same session** shifted the real target to `:742-745`, and `:735-737` had become the tail of an unrelated SQL query. A cold implementer would pin the decoy and delete the guard the pin existed to protect — the exact catastrophic regression it warned against. The drift was **not uniform** — `+8`, `+10`, `+3`, `+1`, and two *exact* — so there is no mechanical "add N" fix either.)

The trap is sharpest in the common case where **the task file instructs edits to the very files it cites** — your own edits (and any companion sweep) invalidate the numbers you wrote. So:

- ✅ "the `if (blockedBy.length > 0)` early return in `#computeDeletionPlan` — immediately after the `#otherUsers(down, …)` call, before the prune-up loop"
- ❌ "the early return at `registry:735-737`"

Anchor on the **symbol + a quoted code fragment** (a predicate, a throw, a distinctive string). A line number is fine as *trailing commentary* on a self-verifying anchor (`` `#computeDeletionPlan` (~:742) ``), never as the sole locator — and never for the one instruction whose mis-resolution is dangerous.

### Multi-version (vN) phases: pinned decisions OR an explicit exploratory tag

A phase carries one of two kinds of spec, and it should be obvious which:

- **Pinned** — decisions are settled; the phase has a decisions table (Decision | Choice | Rationale) and concrete, testable success criteria. `/build-task` transcribes it and the verifier checks conformance.
- **Exploratory** — the mechanism is *empirically discoverable* (real-infra harnesses, browser/WS tooling, network-failure simulation) and genuinely can't be pinned in advance. Tag it `**Exploratory — mechanism TBD**` and name the candidate prior-art template to adopt. Its deliverable is capable-of-failing tests for the discovered behavior **plus a captured findings note** (the mechanism that worked + the alternatives that failed, harvested into a reference memory or rule).

A vN phase that is **thin but neither** — only `"works"`-grade bullets, no decisions, no exploratory tag — is a smell: either the decisions exist and should be written, or the work is a spike and should say so. Don't leave "thin because genuinely exploratory" indistinguishable from "thin because under-thought."

This is the §5.3.7 lesson: at the `/build-task` handoff, v3 carried 34 pinned decisions and shipped as transcription; v4 carried 0 and was where every under-specified call landed (the WS-disconnect tooling took three tries to discover). v4 still shipped clean *because* the work was inherently empirical — but tagging it exploratory up front would have set the right expectation and verifier bar instead of looking like an oversight.

### "Open questions" are decisions to MAKE — not design considerations to keep in mind

An **open question** is a decision that *must be made* before or during the build, and that *gates* something (a phase can't be scoped, a criterion can't be written) until it's answered. It belongs in an `## Open questions` list, and resolving it removes it.

A **design consideration** is different: something the builder should *hold in mind so they don't foreclose a future option* — "when you build X, shape it so Y can extend it later; don't build Y now." It gates nothing and needs no decision. It belongs **inline in the design prose** at the point it applies, phrased as forward guidance (`⚠️ Design consideration:` …), **never** as a tracked open question.

Mis-filing a design consideration as an open question bloats the doc: it reads as an unresolved blocker, invites a "decide now" round that ends in "defer," and then sits as resolution-churn. If the honest answer to "what happens if we never *decide* this?" is "nothing — we just keep a seam open when we build," it was never an open question. (Bit twice on `nebula-star-founder-provisioning.md` 2026-07-21: `signupPolicy` field-shape and DO placement were both tracked as OQs when each was really "keep the seam open, build nothing now.")

Corollary for the whole doc: once every OQ is resolved/folded/deferred, a top-of-file "build order / dependency" summary table has done its job — the per-phase `⛔` markers carry the ordering, so the table becomes a redundant second source. Remove it.

### Grep-based success criteria: target structure, not a bare word

A criterion of the form `grep 'X' <file>` returns nothing must target **structure** — a JSON key, a symbol, a code token — not a bare **word**. A word the same task ALSO instructs you to write into a comment or prose will false-fail the grep even when the substantive intent is met. Scope the grep to the structure it means (e.g. `grep '"state": "deleted"'` for tombstone *entries*, or a key like `"type": "durable-object"`), not a bare token like `deleted` that a required comment also contains. (Bit 2026-07-16: the exports-conversion Phase-2 `grep 'deleted'`-clean criterion was doomed by its own "note the dropped tombstones in the file's comment" instruction — the `/build-task` verifier panel flagged the self-contradiction.)
