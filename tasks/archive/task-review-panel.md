# Task Review Panel

**Status**: Complete (2026-06-10) — calibration carried to `tasks/backlog.md` § Testing & Quality
**Shipped 2026-06-06**: (1) the conformance layer as `.claude/rules/`; (2) the review panel as the **`/review-task`** skill; (3) the companion "go" orchestrator as the **`/build-task`** skill (named `/build-spec` until 2026-06-09 — renamed, and its parallel/worktree implementation option removed, per Larry's long-running-branch workflow). What's left is calibration against real task files.
**Supersedes**: `skills-and-agents.md` + `skills-agents-architecture-guardian.md` (both deleted 2026-06-06 — their *conformance* half shipped as rules; see below)
**Workflow**: Task-file-first (internal tooling)

## What this is

A **parallel panel of specialized reviewers that reads a task file before implementation** and returns focused, structured findings — replacing the expensive serial "run the task file through fresh contexts repeatedly" loop.

The original two task files bundled two different needs under "guardians": an always-on *conformance* layer (use `lmz.call`, sync storage, no committed secrets, …) and a *deep design review* of task-file pseudo-code. Those map to different mechanisms, and only the second remains to build.

## How we actually work (the rationale)

1. **Task writing** (days) — iterative design: spikes, pseudo-code, interfaces, examples. The highest-value intervention point.
2. **Task review loops** (hours) — run the task file through fresh contexts repeatedly, each producing 8–15 items, resolved in conversation, repeated until only nits remain. This pattern has eliminated architectural drift that used to surface in later phases. It works because each fresh session lacks the anchoring bias of having written the content — but it's expensive: serial generalist passes, each re-reading everything, each a mixed bag.
3. **Implementation** (minutes) — mostly transcription of the now-tight spec.

The panel front-loads specialized catches so the number of fresh-context loops drops from ~5–8 to ~1–2. It **reduces** loops, it doesn't replace them — the first 1–2 fresh passes still catch what anchored reviewers miss.

## What already shipped (2026-06-06) — do NOT rebuild

The **conformance layer is now `.claude/rules/`**, not an agent:

- **Architecture Guardian → `mesh.md` + `durable-objects.md`.** The "always use `lmz.call`/`ctn` over raw RPC", routing rule, two-one-way, multi-hop, result-handler, Gateway constraints, plus DO fundamentals — all live as **path-scoped rules** that load (and are self-checked by the model) whenever you touch `packages/**`/`apps/**` `.ts`. This is *more* reliable than a model-invoked agent and needs no doc-extraction step.
- **Phase 0 doc-extraction tooling — eliminated.** Its only purpose was to stuff mesh docs into an agent prompt. Rules are already in context; nothing to extract.
- **`do-conventions` skill — retired**, fully absorbed into `durable-objects.md` / `packaging.md` / `testing.md`.
- **Security Guardian *conformance* → `security.md`** (+ `critical.md`/`packaging.md`): secrets, test-mode flags, JWT/scope, permission checks, parameterized SQL, trust boundaries.
- **Test Strategist *conformance* → `testing.md`**: integration-vs-unit selection, for-docs mini-apps, coverage, capable-of-failing.

Opus 4.8 moved verification from the harness into the model (inline self-checking, ~4× fewer flaws passing vs 4.7). That self-check only checks against what's in context — which is exactly why the conformance layer belongs in always-on / path-scoped **rules**, and why a separate "conformance mode" agent pass is now largely redundant.

## Shipped as skills (2026-06-06)

Re-scoped from "4 standing agent definitions + Phase-0 doc-extraction tooling" to two skills that author + run Workflows on demand (the Workflow tool didn't exist when this was first designed). The rules are the checklists — single source of truth.

### `/review-task` — the panel (before "go")
Implemented at `.claude/skills/review-task/SKILL.md`. Scouts the task file + linked sub-tasks/docs, then fans out reviewer lenses in parallel, **each handed the relevant `.claude/rules/` as its checklist**, returning structured findings (`{ severity, category, location, finding, suggestion }`) synthesized into one ranked list and deduped against prior-loop findings. The four lenses carry the deep design-review intent that exceeds conformance — judgment-heavy perspectives inline self-verification can't replicate (the reviewer needs a perspective the author lacks):
- **architecture** (mesh.md + durable-objects.md) — raw-RPC-instead-of-`lmz.call`, async-in-business-logic, feasibility, dependency direction.
- **security** (security.md) — beyond conformance: sandbox-escape on the *proposed* API, permission-model *completeness*, trust-boundary mapping.
- **test-strategy** (testing.md) — beyond conformance: *what* to test, testable success criteria, for-docs-vs-isolated, omitted scenarios (error paths, concurrency, eviction).
- **product** (CLAUDE.md intro + tasks/README.md) — Nebula vision/ergonomics, walled-garden (no escape hatches, one right way, footguns removed), scope creep, template conformance. Absorbs the old "API Designer" role.

### `/build-task` — the orchestrator (at "go")
Implemented at `.claude/skills/build-task/SKILL.md`. Implements a reviewed task file phase-by-phase (always sequential, in the current branch — the parallel/worktree option was removed 2026-06-09: merge cost exceeds transcription savings in a solo long-running-branch workflow), then fans out adversarial verifiers that check each phase against its own **success criteria** + rules — the task-conformance pass `/code-review` can't do because it doesn't know the task. Composes with `/code-review ultra` (task-conformance here, deep bug-hunt there).

## Where we ended (2026-06-09/10 hand-review) — drift from the original premise

Larry hand-reviewed every rules file and skill with Claude (Fable 5) and the result drifted well beyond this task's scope — in a good way. Recorded here because the final state differs materially from the design above:

- **Rules hand-review produced substantive corrections, not just polish**: the two-one-way-calls rule was demoted (external I/O is no longer a slam-dunk case; multi-hop/direct-delivery promoted to the headline; `@lumenize/fetch`'s alarm-backstop flaw documented in its docs); a "broadcast vs fanout" naming authority was written to stop the recurring rename flip-flop; the `LumenizeClient` during-`super()` callback footgun was **fixed in code** (deferred initial state callback) and its rule section deleted outright; testing.md gained the instance-name-first cross-test-pollution framing, real-loop-over-test-bypass guidance for e2e, and lost its never-used snapshot bullet.
- **The pair was renamed** `/build-spec` → `/build-task` (no SDD/"spec" vocabulary; pairs with `/review-task`), and `/build-task` lost its parallel/worktree implementation option permanently (memory: `no-parallel-worktree-implementation`).
- **`/task-management` was restructured around the pair**: "implementation-first" renamed **task-file-first**; both tracks now converge on a shared "Review → go" gate (`/review-task` → `/build-task`); execution-time conventions (phase gating incl. authorized-unattended mode, phase retros) moved INTO `/build-task` — the skill in context when they apply; `tasks/README.md` slimmed to templates + phrasing conventions only.
- **Old skills synced**: `doc-example-audit` + `review-skip-check-approved` were `.mdx`-only (would silently skip new `.md` docs) — fixed; `release-workflow` converted from the last legacy `.claude/commands/` file to a proper skill, now invoking `/review-skip-check-approved` as its pre-release check.
- **Calibration (original items 1–2 + the Notes idea) carried to `tasks/backlog.md` § Testing & Quality** — the only work this task leaves open. Item 3 (decomposition gate) was resolved by removing parallelism; item 4 (conformance-after-implementation) was answered: path-scoped rules + model self-check inline, `/build-task` verifiers for task-conformance.

## Notes

- A `Docs Writer` was also contemplated; documentation authoring is already covered by `documentation.md` + the doc skills (`doc-example-audit`, `convert-doc-examples`, `review-skip-check-approved`), so it's out of scope here.
