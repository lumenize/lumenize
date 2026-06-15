---
name: task-management
description: Workflow selection for new tasks — docs-first vs task-file-first. Use when starting a new task or creating a task file.
---
# Task Management

## Usage
`/task-management` or `/task-management <task-name>`

---

## Workflow Selection

**Ask: "Will this change how a developer (even an internal one, like us developing Nebula on top of Mesh) uses this package?"**

### If YES → Docs-First
1. Create task file pointing to the doc location(s)
2. Draft docs first (`website/docs/[package]/[feature].md` — `.md` by default; `.mdx` is mostly legacy for this project, but, if necessary, can be used with explicit human approval, see `.claude/rules/documentation.md`)
3. Iterate until docs are approved
4. Add implementation phases to task file (goals + success criteria, not steps)
5. Review → go (see below)
6. Implement via `/build-task`, creating `test/for-docs/` tests
7. Replace `@skip-check` with `@check-example` — use `/doc-example-audit` to get a categorized report, then convert interactively (annotation rules: `.claude/rules/documentation.md`)
8. Phase retro (defined in `/build-task` § Phase Retro)
9. Move to `tasks/archive/` when complete

**Key**: the docs dominate. Task file holds implementation details, not user-facing API.

**Especially valuable for:**
- APIs where ergonomics matter — anything a package consumer touches: the public surface, but also cross-package interfaces another package extends (hooks, base classes, plugin slots — e.g. mesh's `onStart`/`onBeforeCall` consumed by nebula). These are easy to misfile as "internal."
- Multi-step flows that cross boundaries (browser ↔ server ↔ external service; redirects, callbacks, handshakes) — drafting the docs narrative forces walking the whole flow end-to-end in order, surfacing missing steps and ordering gaps before any code exists.

**Docs-to-implementation handoff**: When the docs phases are done and implementation begins (often in a new session with fresh context), the docs are a *specification*, not a description of existing reality. Code examples with `@skip-check` don't work yet — they describe the target API. The task file should clearly mark this transition, and session prompts should state: "The docs in `website/docs/[package]/` are the spec — code examples describe the target API, not current behavior."

### If NO → Task-File-First
1. Add to `tasks/backlog.md` (small) or create `tasks/[project-name].md` (multi-phase)
2. Define phases with goals + success criteria
3. Review → go (see below; skip for small backlog items)
4. Implement, updating task file as you go
5. Sync docs for any surface that grew (see below)
6. Phase retro (defined in `/build-task` § Phase Retro)
7. Archive when complete

**Key**: the task file is the sole design artifact. (Docs-first has a task file too — but there the docs dominate and the task file holds only implementation details.)

**Task-file-first still usually produces small docs changes.** Implementation often adds a new method, option, or a small set of them. When the additions are consistent with the existing API and purely enhancing, they carry little DX risk — document them after the fact (update the package's website docs, `@check-example` any new examples). That doesn't retroactively make the task docs-first; docs-first is about docs *leading* the design, not about whether docs get touched.

**Better suited for:**
- Internal utilities and helpers
- Algorithms where the interface is already clear
- Refactoring with stable external API
- Bug fixes

---

## Review → go (both tracks converge here)

Deep review of the task file (and docs where applicable) is the main quality gate — it's where success or failure is mostly determined, and it's what makes implementation near-transcription. For any multi-phase task file:

1. **`/review-task`** — parallel reviewer panel + adversarial verify; resolve blockers/majors with the user. Expect 1–2 human-led passes after it for most tasks but can go on for many turns and take days particularly when reviewing docs-first tasks.
2. At "go": **`/build-task`** — implement phase-by-phase, then fan out verifiers checking each phase against its own success criteria.

Skip for small backlog items — a single inline read beats orchestration there.

---

## Task File Structure

See `tasks/README.md` for templates. Key elements:
- **Goal**: One sentence
- **Phases**: Each with goal + success criteria (not detailed steps)
- **Status**: Design Complete | In Progress | Complete

---

## Rules
- Update task file when plans change
- Archive completed tasks (don't delete)
- Execution-time conventions — phase gating (ask vs authorized-unattended) and phase retros — are defined in `/build-task`, the skill that's loaded when they apply. Don't restate them here.
