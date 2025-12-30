# Task Management

Manage project tasks using two complementary workflows: docs-first for user-facing features, implementation-first for internal work.

## Usage

`/task-management` or `/task-management <action> <task-name>`

---

## Two Workflows

### Docs-First (Preferred for User-Facing Features)

**When**: New features, API design, or changes affecting user-facing behavior.

**Why**: Perfecting the API from the user's perspective before code prevents costly late-stage refactoring.

**Process**:
1. Create task file pointing to MDX location
2. **Draft user-facing documentation first** (`website/docs/[package]/[feature].mdx`)
3. **Iterate on docs until API is perfect** (maintainer reviews/approves)
4. Update task file with implementation phases (focus on goals, not detailed steps)
5. Implement following the finalized API spec
6. Create validation tests (`test/for-docs/`)
7. Replace `@skip-check` with `@check-example` (see `/documentation-workflow`)
8. Archive when complete

**Key**: The MDX documentation **dominates** the task file. Task file contains implementation phases with goals and success criteria, not detailed step-by-step instructions.

### Implementation-First (For Internal Work)

**When**: Refactoring, performance improvements, bug fixes, internal tooling, or changes that don't affect user-facing API.

**Process**:
1. Determine if small task (backlog) or multi-phase project
2. Create/update task file with phases and goals
3. Implement changes
4. Update task file as work progresses
5. Update/create documentation after implementation (if needed)
6. Archive when complete

---

## Task Structure

### Docs-First Task File

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
```

### Implementation-First Task File

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

---

## Key Principles

**Focus on Goals, Not Steps**:
- Each phase defines **what** it achieves (goal) and **how we know it's done** (success criteria)
- Don't pre-define detailed steps - they emerge during implementation
- Iterate on task file as learnings emerge

**Docs-First API Approval**:
- Wait for explicit maintainer approval on API design before implementing
- MDX dominates - if conflict between task file and MDX, MDX wins
- Implementation details go in task file, user-facing API goes in MDX

**Phase Gates**:
- Ask "Ready to proceed with [next phase]?" after completing each phase
- Update task file when plans change based on learnings
- Archive completed tasks (don't delete)

---

## Task Types

- **Small tasks**: Add to `tasks/backlog.md`
- **Multi-phase projects**: Create `tasks/[project-name].md`
- **Decisions**: Document in `tasks/decisions/`
- **Completed**: Move to `tasks/archive/`

---

## Choosing the Right Workflow

**Use Docs-First When**:
- Designing new user-facing API
- Adding major features to packages
- Creating new public methods/services
- Changing existing user-facing behavior

**Use Implementation-First When**:
- Refactoring internal code (no API changes)
- Performance optimizations
- Bug fixes (preserving API)
- Internal tooling/scripts
- Test infrastructure

**When in doubt**: Ask "Will this change how a developer uses this package?" If yes → Docs-First.
