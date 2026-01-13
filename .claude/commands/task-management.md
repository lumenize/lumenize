# Task Management

## Usage
`/task-management` or `/task-management <action> <task-name>`

---

## Workflow Selection

**Ask: "Will this change how a developer uses this package?"**

### If YES → Docs-First
1. Create task file pointing to MDX location(s)
2. Draft docs first (`website/docs/[package]/[feature].mdx`)
3. Iterate until API is approved
4. Add implementation phases to task file (goals + success criteria, not steps)
5. Implement, create `test/for-docs/` tests
6. Replace `@skip-check` with `@check-example` (see CLAUDE.md Documentation section)
7. Archive when complete

**Key**: MDX dominates. Task file holds implementation details, not user-facing API.

### If NO → Implementation-First
1. Add to `tasks/backlog.md` (small) or create `tasks/[project-name].md` (multi-phase)
2. Define phases with goals + success criteria
3. Implement, updating task file as you go
4. Archive when complete

---

## Task File Structure

See `tasks/README.md` for templates. Key elements:
- **Goal**: One sentence
- **Phases**: Each with goal + success criteria (not detailed steps)
- **Status**: Design Complete | In Progress | Complete

---

## Rules
- Ask "Ready to proceed with [next phase]?" after each phase
- Update task file when plans change
- Archive completed tasks (don't delete)
