---
name: task-management
description: Workflow selection for new tasks — docs-first vs implementation-first. Use when starting a new task or creating a task file.
---

# Task Management

## Usage
`/task-management` or `/task-management <action> <task-name>`

---

## Workflow Selection

**Ask: "Will this change how a developer uses this package?"**

### If YES → Docs-First
1. Create task file pointing to MDX location(s)
2. Draft docs first (`website/docs/[package]/[feature].mdx`)
3. Iterate until docs are approved
4. Add implementation phases to task file (goals + success criteria, not steps)
5. Implement, create `test/for-docs/` tests
6. Replace `@skip-check` with `@check-example` — use `/doc-example-audit` to get a categorized report, then convert interactively (see also CLAUDE.md Documentation section for annotation rules)
7. Archive when complete

**Key**: MDX dominates. Task file holds implementation details, not user-facing API.

**Especially valuable for:**
- Multi-component flows (browser ↔ server ↔ external services)
- User-facing APIs where ergonomics matter
- Integration points between systems
- Anything involving redirects, callbacks, or multi-step handshakes

### If NO → Implementation-First
1. Add to `tasks/backlog.md` (small) or create `tasks/[project-name].md` (multi-phase)
2. Define phases with goals + success criteria
3. Implement, updating task file as you go
4. Archive when complete

**Better suited for:**
- Internal utilities and helpers
- Algorithms where the interface is already clear
- Refactoring with stable external API
- Bug fixes

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
