# Tasks Directory

## Structure

- **`backlog.md`** - Small tasks and ideas
- **`[project-name].md`** - Active multi-phase projects
- **`archive/`** - Completed projects (for reference)

## Templates

### Docs-First Task File

For user-facing API changes. MDX documentation dominates; task file holds implementation details.

```markdown
# [Project Name]

**Status**: Design Complete | In Progress | Complete
**Design Document**: `/website/docs/[package]/[feature].mdx`

## Goal
[One sentence - what capability are we adding?]

## Design Principles (See MDX for Details)
1. [Key principle 1]
2. [Key principle 2]

## Prerequisites
- [ ] Design documented in MDX
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
- [ ] Docs match implementation: grep `.mdx` files for keywords from changed APIs
- [ ] JSDoc comments in source reflect current behavior
```

### Implementation-First Task File

For internal work (refactoring, bug fixes, tooling).

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

## Completing a Project

Move to archive:
```bash
mv tasks/completed-feature.md tasks/archive/
```
