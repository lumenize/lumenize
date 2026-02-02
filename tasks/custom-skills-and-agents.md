# Custom Skills for Lumenize

**Status**: Design Drafted — Awaiting Review

## Goal

Define a small, focused set of skills for the Lumenize monorepo — new skills plus migration of existing commands to the skills system.

## Inventory: 5 Items (4 Skills + 1 Command)

| # | Name | Type | Invocation | Model | Context | Status |
|---|------|------|------------|-------|---------|--------|
| 1 | `do-conventions` | Skill | `user-invocable: false` | — | Append (reference knowledge) | New |
| 2 | `doc-example-audit` | Skill | `/doc-example-audit` | haiku | Fork → Explore agent (read-only) | New |
| 3 | `task-management` | Skill | `/task-management` | — | Append (workflow guidance) | Migrate from command |
| 4 | `refactor-efficiently` | Skill | `/refactor-efficiently` | — | Append (workflow guidance) | Migrate + rename from `api-refactor` command |
| 5 | `release-workflow` | Command | `/release-workflow` | — | Append | Keep as-is |

---

## 1. `do-conventions` — Skill

**File**: `.claude/skills/do-conventions/SKILL.md`

**Description**: Cloudflare Durable Object conventions for the Lumenize monorepo — storage patterns, private members, config delivery, billing avoidance, and testing.

**Frontmatter**:
```yaml
name: do-conventions
description: Cloudflare Durable Object conventions for the Lumenize monorepo — storage, private members, config, billing models, testing patterns. Loaded automatically when relevant to DO implementation.
user-invocable: false
```

**Rationale for content**:

This skill extracts and concentrates DO-specific rules from CLAUDE.md plus project-learned patterns into a single referenceable document. While CLAUDE.md covers the entire monorepo, this skill distills just the DO rules into a focused reference that the main session can auto-load when DO work is relevant, without parsing 200+ lines of mixed context.

**Content outline**:

1. **Storage** — Always `ctx.storage.sql.*` or `ctx.storage.kv.*`. Never legacy async. SQL for relational data (subjects, tokens). KV for simple key-value.
2. **Private members** — `#` prefix, never TypeScript `private`. Private handler methods for route logic.
3. **Config delivery** — `this.env.VAR_NAME` with inline defaults. No `configure()` Workers RPC. No `#config` instance variables.
4. **Sync methods** — Only `fetch()`, `alarm()`, `webSocketMessage/Close/Error()` are `async`. Everything else synchronous.
5. **No mutable instance state** — DOs evicted anytime. Storage is source of truth. Safe: statically initialized utilities, constructor-set config, loss is OK like rate limiting counter.
6. **IDs** — `crypto.randomUUID()` or `ulidFactory({ monotonic: true })` from `ulid-workers` package. Never `Date.now()` (clock doesn't advance in CF Workers during execution).
7. **DO's wall-clock billing** — Avoid `await` in business logic, `setTimeout`, holding Workers RPC stubs. Use `using` keyword for stubs. Offload long running fetches to a Worker.
8. **Route pattern** — DO handles routes in `fetch` via URL path matching. Private handler methods unless you need DRY for equivalent Workers RPC API.
9. **Testing basics** — `vi.waitFor()` instead of `setTimeout`. Integration tests primary. Coverage targets: >80% branch, >90% statement.
10. **Env type** — Use global `Env` from `worker-configuration.d.ts` (auto-generated via `npm run types`). Never manually define.
11. **`for-docs/` tests are mini-apps, not toy examples** — Each `test/for-docs/` directory is a self-contained application with its own `wrangler.jsonc`, worker entry point, node classes, and a phased narrative test. They exercise realistic multi-node scenarios end-to-end (see `packages/mesh/test/for-docs/getting-started/` as the exemplar). Use `for-docs/` when the test validates a documentation scenario *and* exercises cross-node interactions. Use isolated tests in `test/` for single-node logic, edge cases, and error paths.

**Supporting files**: None initially. Could add `examples.md` with before/after patterns if the skill body exceeds 500 lines.

**Why a skill**:
This is pure reference knowledge — no tools needed, no autonomous execution. The main session auto-loads it when DO work is detected, giving it domain expertise without the user needing to remember a slash command.

---

## 3. `doc-example-audit` — Skill

**File**: `.claude/skills/doc-example-audit/SKILL.md`

**Description**: Read-only audit of `@skip-check` annotations in `.mdx` files. Returns a categorized report for the main session to act on interactively.

**Frontmatter**:
```yaml
name: doc-example-audit
description: Audit @skip-check annotations in .mdx files — categorize each block and produce a prioritized conversion plan. Use before starting Phase 2 doc work.
context: fork
agent: Explore
model: haiku
argument-hint: [mdx-file-path or package-name]
```

**Rationale for content**:

The actual `@skip-check` → `@check-example` conversion work is best done interactively in the main session: analyze, plan, convert one example, review with the user, iterate. That's where judgment calls happen (Is the code block wrong? Does a new test file need to be created? Should this be `@skip-check-approved` instead?). But the *audit* step — scanning files, checking for matching tests, categorizing blocks — is mechanical and benefits from running on a fast, cheap model in isolation so it doesn't consume the main session's context window.

**Content outline**:
- Accept an `.mdx` file path as `$ARGUMENTS` (or audit all `@skip-check` in `website/docs/` if none given)
- For each `@skip-check` block, categorize it:
  - **Mechanical**: Matching test file exists in `packages/{pkg}/test/for-docs/`, code block is clearly a subset — ready for conversion
  - **Needs new test**: No matching test file found — will require creating a new `for-docs/` test
  - **Ambiguous**: Code block doesn't clearly match any existing test, or may contain errors — needs interactive review
  - **Candidate for `@skip-check-approved`**: Too small or purely pedagogical to warrant a test
- Convention: test file name mirrors the doc file (e.g., `api-reference.mdx` → `api-reference.test.ts`)
- Output a prioritized plan: mechanical items first, then items needing new tests, then ambiguous items
- For each item, include: file path, line number, code block preview, category, and suggested test file path
- Never edit files — this is a read-only audit

**Why read-only audit (not autonomous converter)**:
The conversion workflow requires judgment calls and iterative review with the user — plan, convert one, review, course-correct, repeat. That interactive loop can't happen in a forked agent. The audit runs on haiku via the Explore agent (fast, cheap, read-only), then the main session works through the plan interactively with the user on Opus.

**Why `agent: Explore` and `model: haiku`**:
The audit is pure scanning — read `.mdx` files, grep for `@skip-check`, check if test files exist. No editing, no test creation. Explore is purpose-built for this. Haiku keeps it fast and cheap, and gives the user a concrete example of using a different model for the right job rather than running everything on Opus.

---

## Interaction Model

```
Main Claude Code Session (Opus, interactive)
│
├── `do-conventions` skill auto-loaded when DO work is relevant
├── `/task-management` skill auto-loaded when starting new tasks
├── `/refactor-efficiently` skill auto-loaded when refactoring
│
└── user invokes /doc-example-audit ──→ [Explore agent via context: fork, haiku]
                                              └── returns categorized report of @skip-check blocks
```

**Data flow**:
1. Main session plans work (`/task-management` auto-invokes when relevant)
2. Main session implements DO code interactively (guided by `do-conventions`)
3. Main session writes tests (guided by `do-conventions` items 9 and 11 for `for-docs/` vs isolated test decisions)
4. User invokes `/doc-example-audit` to get a categorized report (after implementation is stable)
5. Main session works through the audit report interactively — convert one, review with user, iterate

---

## Design Decisions

### Considered and Accepted

**1. `do-conventions` as a skill, not CLAUDE.md-only**

The DO rules are in both CLAUDE.md (for broad context) and a focused skill (for concentrated reference). The duplication is intentional — CLAUDE.md covers the whole monorepo while the skill distills just the DO rules. The main session auto-loads it when DO work is relevant.

**2. Read-only audit for `doc-example-audit`, not autonomous converter**

The `@skip-check` → `@check-example` conversion requires judgment calls and interactive review. A forked agent can't iterate with the user. The audit (haiku/Explore) produces a categorized report; the main session (Opus, interactive) works through it.

**3. Testing guidance in `do-conventions` skill, not a separate test-writer sub-agent**

The `for-docs/` mini-app pattern and the decision criteria for `for-docs/` vs isolated tests are encoded in `do-conventions` (items 9 and 11). This keeps the main session informed when it writes tests interactively, without the overhead of a separate sub-agent. If the main agent consistently writes shallow `for-docs/` tests despite this guidance, a `do-test-writer` sub-agent can be reconsidered.

### Considered and Rejected

**1. Rejected: `auth-design-reviewer` sub-agent**

Considered a read-only agent to review implementation against the design docs. Rejected because:
- The design docs are already loaded as context in the main session
- A review agent would duplicate what the main session does naturally when comparing code to spec
- The existing `/task-management` skill already guides phase transitions with checkpoint questions

**2. Rejected: `security-auditor` sub-agent**

Considered a specialized agent to check for OWASP issues, injection, and auth bypass. Rejected because:
- Security is a cross-cutting concern best handled by the main session and existing `/refactor-efficiently` skill
- A separate agent would lose the implementation context needed to spot subtle issues
- The `do-conventions` skill already encodes the key security patterns (no public Workers RPC, storage as truth)

**3. Rejected: Separate `auth-conventions` skill**

Considered extracting auth-specific patterns (dual auth, bootstrap protection, token types) into a dedicated skill beyond `do-conventions`. Rejected because:
- These patterns are specific to a single package — not reusable across the monorepo
- Adding another skill increases context budget consumption without clear payoff
- If we generalize later, it's easy to extract

**4. Rejected: Autonomous `doc-example-linker` with `agent: general-purpose`**

Initially designed as an autonomous converter that would scan `.mdx` files, create/update test files, and replace annotations — all in a forked `general-purpose` agent. Changed to a read-only audit (`agent: Explore`, `model: haiku`) because:
- The conversion requires judgment calls (Is the code block correct? Does it need a new test or an existing one? Should it be `@skip-check-approved`?) that benefit from interactive review
- The user's preferred workflow is: audit → plan → convert one → review → iterate — which is main-session work
- A forked agent can't do back-and-forth with the user
- The audit step (scanning, categorizing, checking for matching tests) is mechanical and benefits from haiku's speed and low cost

**5. Rejected: `do-implementation` sub-agent**

Considered a sub-agent that would autonomously implement DO business logic with `do-conventions` preloaded. Removed because:
- The user's interactive, question-driven workflow means they're naturally in the loop during implementation — delegating loses that back-and-forth
- The main session with `do-conventions` auto-loaded provides the same DO expertise without delegation overhead
- Sub-agents are best for well-defined, chunky tasks where you don't want to be in the loop — that's rarely the case for DO implementation work
- If a batch of repetitive DO tasks arises, a sub-agent can be reconsidered on the next sharpening-the-saw day

**6. Rejected: `auth-test-writer` sub-agent**

Initially designed as a sub-agent specialized for writing `@lumenize/auth` integration tests. Rejected because:
- The auth-specific knowledge (test helpers, login patterns, miniflare config) is package-specific, not reusable across the monorepo
- A generalized `do-test-writer` was considered but its system prompt would be thin — mostly restating what's already in `do-conventions`
- The key insight (that `for-docs/` tests should be realistic mini-apps, not toy examples) is better encoded in `do-conventions` item 11 where both the main session and sub-agents can reference it
- If the main agent consistently writes poor tests despite the strengthened guidance, a sub-agent can be reconsidered

---

## Generalization Path

| Item | Auth-scoped | Generalized |
|------|------------|-------------|
| `do-conventions` | Already general | No changes needed |
| `doc-example-audit` | Already general | No changes needed — works on any `.mdx` file |
| `task-management` | Already general | No changes needed |
| `refactor-efficiently` | Already general | No changes needed |

All items are already package-agnostic.

---

## Command → Skill Migration

Three existing commands live in `.claude/commands/`. Skills (`.claude/skills/*/SKILL.md`) are the evolution of commands — they're backward-compatible but add capabilities: auto-invocation via `description`, supporting files, `context: fork`, `allowed-tools`, and per-skill model selection. Commands still work but are not receiving new features.

### `/task-management` → Skill (convert)

**Rationale**: Workflow guidance ("docs-first or implementation-first?") that Claude should auto-load when you say "let's start a new task" without needing to remember the slash command. A good `description` field enables this.

**Migration**: Move `.claude/commands/task-management.md` → `.claude/skills/task-management/SKILL.md`. Add frontmatter:
```yaml
name: task-management
description: Workflow selection for new tasks — docs-first vs implementation-first. Use when starting a new task or creating a task file.
```

### `/api-refactor` → `/refactor-efficiently` Skill (convert + rename)

**Rationale**: The `.only` validation pattern (fix one test first, then the rest) applies to any refactor that breaks tests, not just API changes. The old name `api-refactor` was too narrow — you'd say "fix one test first" without thinking "API." Renaming to `refactor-efficiently` matches how you think about the process. Auto-invocation via `description` means Claude loads it when you say "let's refactor this" without you needing to remember the slash command.

**Migration**: Move `.claude/commands/api-refactor.md` → `.claude/skills/refactor-efficiently/SKILL.md`. Add frontmatter:
```yaml
name: refactor-efficiently
description: Efficient refactoring using the .only validation pattern — get one representative test passing before updating all tests. Use when a change will break multiple tests.
```

### `/release-workflow` → Keep as command

**Rationale**: You'd never want Claude to auto-invoke a release workflow — it's always a deliberate action. Converting to a skill with `disable-model-invocation: true` would be functionally identical to a command with no benefit. Lowest priority; convert later if skill-only features (e.g., `allowed-tools` to restrict to bash release scripts) become useful.

---

## Open Questions

1. **Skill context budget**: The default is 15,000 characters for all skill descriptions combined. After migration, 4 skills will have descriptions loaded at session start: `task-management`, `refactor-efficiently`, `doc-example-audit`, and `do-conventions` (even though `user-invocable: false`, its description still counts). All four descriptions are short — likely well within 15,000 characters.
