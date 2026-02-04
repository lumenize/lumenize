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
7. Phase retro (see below)
8. Archive when complete

**Key**: MDX dominates. Task file holds implementation details, not user-facing API.

**Especially valuable for:**
- Multi-component flows (browser ↔ server ↔ external services)
- User-facing APIs where ergonomics matter
- Integration points between systems
- Anything involving redirects, callbacks, or multi-step handshakes

**Docs-to-implementation handoff**: When the docs phases are done and implementation begins (often in a new session with fresh context), the docs are a *specification*, not a description of existing reality. Code examples with `@skip-check` don't work yet — they describe the target API. The task file should clearly mark this transition, and session prompts should state: "The docs in `website/docs/[package]/` are the spec — code examples describe the target API, not current behavior."

### If NO → Implementation-First
1. Add to `tasks/backlog.md` (small) or create `tasks/[project-name].md` (multi-phase)
2. Define phases with goals + success criteria
3. Implement, updating task file as you go
4. Phase retro (see below)
5. Archive when complete

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

## Phase Retro

After each phase, briefly answer:
1. **What did we learn?** (surprising discoveries, undocumented behavior, patterns worth capturing)
2. **What did we struggle with?** (implementation friction, confusing APIs, wrong assumptions)
3. **Did any tests fail unexpectedly?** (root cause, not just the fix)
4. **Impact on follow-on work?** (does this change later phases, create new backlog items, or simplify/complicate the plan?)

Capture anything reusable (patterns, conventions, gotchas) in the appropriate place: CLAUDE.md, skill files, AGENTS.md, or backlog.md. Don't let hard-won knowledge stay only in the conversation transcript.

---

## Rules
- Ask "Ready to proceed with [next phase]?" after each phase
- Run a phase retro after each phase completes
- Update task file when plans change
- Archive completed tasks (don't delete)
