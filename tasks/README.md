# Task File Templates & Conventions

**Process lives in the `/task-management` skill** (`.claude/skills/task-management/SKILL.md`) — workflow selection, review → go, phase retros. Folder structure is in `.claude/rules/workflow.md`. This file holds only the **templates** and **phrasing conventions** for the task files themselves.

## Archive is frozen

A file moved to `tasks/archive/` is a point-in-time record — it starts going stale immediately, and that's by design. **Never update archived files**: no link fixups when referenced files move, no terminology syncs, no corrections when code drifts. Sole exception: a dated one-line status/superseded banner at the top when a later decision overturns one — added at the moment of supersession, touching nothing else. If a decision in an archived file must stay *live* (still constrains new work), its home is an ADR (`docs/adr/README.md` has the bar) or a rule, not edits to the archive.

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

### Multi-version (vN) phases: pinned decisions OR an explicit exploratory tag

A phase carries one of two kinds of spec, and it should be obvious which:

- **Pinned** — decisions are settled; the phase has a decisions table (Decision | Choice | Rationale) and concrete, testable success criteria. `/build-task` transcribes it and the verifier checks conformance.
- **Exploratory** — the mechanism is *empirically discoverable* (real-infra harnesses, browser/WS tooling, network-failure simulation) and genuinely can't be pinned in advance. Tag it `**Exploratory — mechanism TBD**` and name the candidate prior-art template to adopt. Its deliverable is capable-of-failing tests for the discovered behavior **plus a captured findings note** (the mechanism that worked + the alternatives that failed, harvested into a reference memory or rule).

A vN phase that is **thin but neither** — only `"works"`-grade bullets, no decisions, no exploratory tag — is a smell: either the decisions exist and should be written, or the work is a spike and should say so. Don't leave "thin because genuinely exploratory" indistinguishable from "thin because under-thought."

This is the §5.3.7 lesson: at the `/build-task` handoff, v3 carried 34 pinned decisions and shipped as transcription; v4 carried 0 and was where every under-specified call landed (the WS-disconnect tooling took three tries to discover). v4 still shipped clean *because* the work was inherently empirical — but tagging it exploratory up front would have set the right expectation and verifier bar instead of looking like an oversight.
