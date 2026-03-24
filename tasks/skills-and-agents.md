# Skills & Sub-Agents Overhaul

**Status**: Design
**Workflow**: Implementation-first (internal tooling, no user-facing API change)

## Objective

Replace stale skills/sub-agents with a focused set aligned to our actual working pattern. The current skills are mostly implementation-oriented, but our workflow has evolved: task writing takes days of iterative design (spikes, pseudo-code, interfaces, examples), while implementation is often minutes of near-transcription. The highest-value intervention point is task file review, not implementation.

## How We Actually Work

Understanding the real workflow is critical to designing agents that get used:

1. **Task writing** (days) — Iterative design with spikes, pseudo-code, interfaces, examples. Task files break into sub-task files, sometimes one more layer deep. Short spike loops (task-writing → implementation → back to task-writing) happen during this phase.
2. **Task review loops** (hours) — Run the task file through fresh contexts repeatedly, each producing 8-15 items. Resolve via conversation. Repeat in new sessions until only nits remain. This pattern has eliminated architectural drift that previously appeared in later phases.
3. **Implementation** (minutes) — Mostly transcription of the now-tight spec. Retros consistently report "more like transcription than development."

**Key insight**: The repeated-fresh-context review pattern works because each session lacks the anchoring bias of having written the content. But it's expensive — serial generalist passes where each re-reads everything and produces a mixed bag of product, architecture, security, and testing feedback. Specialized agents running in parallel could replace N serial loops with fewer, more targeted passes.

**Implication**: These agents are primarily **reviewers during task writing**, not monitors during implementation. Implementation needs a lighter conformance check ("did the code match the spec?"), not deep architectural review.

## Existing Skills Audit

| Skill | Still Relevant? | Notes |
|-------|----------------|-------|
| `task-management` | Yes | Workflow selector, still on target |
| `do-conventions` | Partially | Good content, but should be absorbed into Architecture Guardian |
| `refactor-efficiently` | Yes | `.only` pattern is useful |
| `coverage-improvement` | Yes | Mechanical coverage work |
| `doc-example-audit` | Yes | Phase 2 handoff tool |
| `review-skip-check-approved` | Yes | Pre-release check |

## New Agents & Skills

### The Review Panel (primary value: task writing phase)

The core idea: replace serial generalist review loops with a parallel panel of specialized reviewers. A single "review this task file" invocation dispatches all relevant agents, each reading through their lens, each returning a focused list. This should reduce the number of fresh-context loops needed from ~5-8 down to ~1-2.

Each agent operates in two modes:
- **Task review mode** (primary): Deep review of task files, pseudo-code, interfaces, examples
- **Conformance mode** (post-implementation): Lighter check — did the code match the spec?

#### 1. Product Steward (sub-agent)

**Purpose**: Enforces the Nebula vision and product coherence.

**Task review mode** (primary):
- Enforces walled-garden philosophy: no escape hatches, one right way, guard against footguns by removing them
- Reviews API surface decisions for ergonomic consistency (absorbs "API Designer" role)
- Checks that task files follow templates from `tasks/README.md`
- Ensures phases have clear goals + success criteria (not step lists)
- Validates that new work aligns with the master plan in `nebula.md`
- Flags scope creep or premature generalization
- Reviews pseudo-code and interfaces for user ergonomics (remember: vibe coders, not experienced devs)

**Conformance mode** (post-implementation):
- Does the implemented API match what the task file specified?
- Are there user-facing behaviors that diverged from the spec?

**Key context files**: `tasks/nebula.md`, `tasks/README.md`, active task file, relevant `.mdx` docs

#### 2. Architecture Guardian (sub-agent)

**Purpose**: Reviews designs and implementations against Lumenize architectural constraints, operating at the **Mesh abstraction level** — not raw DO primitives.

**Task review mode** (primary):
- **Mesh pattern enforcement** (highest value — this is what task reviews most often catch):
  - `this.lmz.call()` over raw Workers RPC calls — always
  - `this.lmz.ctn()` continuations for callbacks — understands how they propagate callContext
  - Two one-way call pattern: Worker makes external call, calls back to DO with result (avoids DO wall-clock billing)
  - Multi-hop calls: client → star → somewhere else → directly back to client (not back through star)
  - `this.lmz.callContext` for auth/identity propagation
  - Flags pseudo-code that uses raw `stub.method()` instead of `lmz.call(stub, continuation)`
- Inverted DWL model: DO calls out to DWL, never reverse
- Storage conventions: synchronous API only, SQL naming, write cost optimization
- Package dependency graph: mesh is MIT foundation, nebula extends but never the reverse
- Cross-package boundary review: what belongs in mesh vs nebula vs nebula-auth
- Reviews pseudo-code for architectural feasibility (e.g., "this design requires async in a business logic method — won't work")

**Conformance mode** (post-implementation):
- Does the implementation use `lmz.call()` / `lmz.ctn()` everywhere it should?
- Any places where raw RPC snuck in during "transcription"?
- Does the implementation follow the storage patterns specified?

**Key context files**: `CLAUDE.md`, current `do-conventions/SKILL.md`, `wrangler.jsonc` files, package.json dependency trees, `website/docs/mesh/calls.mdx`, `website/docs/mesh/testing.mdx`

**Relationship to `do-conventions`**: Architecture Guardian supersedes it. Raw DO-level guidance (input/output gates, wall-clock billing, synchronous methods) is still valid but is the *fallback* layer — if you're using Mesh patterns correctly, you naturally follow DO best practices. The guardian's primary job is ensuring Mesh patterns are used, not re-teaching DO fundamentals.

**Key learning**: The most common review finding is pseudo-code that drops to raw Workers RPC instead of using Mesh abstractions. This agent needs deep understanding of `lmz.call()`, continuations, and multi-hop patterns to be effective. It should be populated with examples of correct and incorrect patterns from existing code.

#### 3. Security Guardian (sub-agent)

**Purpose**: Lumenize-specific security review, not generic OWASP.

**Task review mode** (primary):
- Reviews auth flows in task file designs: are there missing validation steps?
- DWL sandbox boundary analysis: can user code escape the sandbox via the proposed API?
- Permission model completeness: are there resource operations without DAG permission checks?
- Identifies trust boundary crossings in the proposed architecture

**Conformance mode** (post-implementation):
- Secrets: never in committed files, `.dev.vars` only in gitignored locations
- Test-mode flags: `LUMENIZE_AUTH_TEST_MODE` only in vitest `miniflare.bindings`, never in wrangler.jsonc vars
- JWT validation: token verification paths, scope enforcement, refresh token rotation
- SQL injection: parameterized queries in `ctx.storage.sql`, review of `svc.sql` template usage
- Actual code matches the security design in the task file

**Key context files**: `packages/auth/`, `packages/nebula-auth/`, `apps/nebula/`, `.dev.vars.example`

#### 4. Test Strategist (sub-agent)

**Purpose**: Reviews test strategy, ensuring the right *kind* of tests are planned/written.

**Task review mode** (primary):
- Does the task file's success criteria include testable conditions?
- Should this phase produce a for-docs mini-app (cross-node interaction) or isolated tests?
- Are there untestable claims in the pseudo-code?
- Does the test plan match the docs narrative (for docs-first work)?
- Identifies scenarios the task file doesn't mention: error paths, concurrent access, eviction recovery

**Conformance mode** (post-implementation):
- Integration vs unit test selection: was the right kind chosen?
- Coverage gap analysis: not just line numbers but *what scenarios* are untested
- Test organization review: does it need its own vitest project or wrangler.jsonc?
- For-docs mini-app review: does it exercise realistic multi-node scenarios?

**Key context files**: Existing `test/for-docs/` exemplars (especially `packages/mesh/test/for-docs/getting-started/`), `vitest.config.js` files, `website/docs/mesh/testing.mdx`

**Relationship to `coverage-improvement`**: Test Strategist decides *what* to test; `coverage-improvement` is the mechanical skill for raising numbers on existing tests.

#### 5. Docs Writer (skill — iterate existing)

**Purpose**: Documentation authoring following project conventions.

**Status**: Existing skill is mostly on target. Iterate rather than replace.

**Adjustments needed**:
- TBD — audit current skill against actual usage patterns

## Sub-Tasks

| Sub-Task | Scope | Task File | Status |
|----------|-------|-----------|--------|
| Architecture Guardian | Doc extraction tooling, agent definition, do-conventions absorption | `tasks/skills-agents-architecture-guardian.md` | Design |
| Remaining Agents | Product Steward, Security Guardian, Test Strategist, Docs Writer, review panel orchestration | `tasks/skills-agents-remaining.md` | Pending |

The Architecture Guardian goes first because:
1. It catches the most common review findings (raw RPC vs Mesh patterns)
2. It has a concrete prerequisite (doc extraction tooling) that benefits the other agents too
3. It absorbs do-conventions, resolving the staleness question
4. The doc extraction tooling built for it can be reused by other agents (Security Guardian needs `security.mdx`, Test Strategist needs `testing.mdx`)

The remaining agents are designed together in a second sub-task because they share structure and the doc extraction tooling from the first sub-task.

## Open Questions

1. **Review panel orchestration**: Should there be a single `/review-task` skill that dispatches all 4 agents in parallel? Or should the main agent decide which subset to invoke based on the task file content? The former is simpler; the latter avoids noise (e.g., Security Guardian reviewing a pure refactoring task).
2. **Conformance check trigger**: Should conformance mode run automatically after implementation (e.g., hook on commit), or remain manual? The risk of auto-trigger is alert fatigue; the risk of manual is forgetting.
3. **Granularity of Architecture Guardian**: Should it absorb `do-conventions` entirely, or keep do-conventions as a quick-reference that the guardian's prompt includes?
4. **Fresh-context problem**: **Resolved** — agents reduce loops, don't replace them. The review panel front-loads specialized catches (architecture violations, security gaps, missing test scenarios) so that fresh-context passes find fewer and more subtle issues. Expect to go from ~5-8 loops to ~1-2.
5. **Docs Writer scope**: What specifically is stale about the current docs skill? Need to audit before deciding adjustments.
6. **Feedback format**: Should agents return structured findings (severity, category, file location, suggestion) or prose? Structured is easier to track resolution; prose is easier to discuss. **Leaning structured** — if findings feed into fresh-context review sessions, a new context can quickly parse "here's what the panel already caught, focus on what they missed."

## Notes

- The Product Steward absorbs the "API Designer" role — the API *is* the product surface, and separating them risks conflicting ergonomics advice.
- Security Guardian must be Lumenize-specific. Generic OWASP advice is too broad to be actionable.
- Test Strategist is distinct from `coverage-improvement`: strategist decides *what* to test, coverage-improvement raises numbers mechanically.
- The repeated-fresh-context review pattern is valuable but expensive. These agents should reduce the loops needed, not eliminate them entirely. The first 1-2 fresh-context passes may still be needed to catch what anchored sub-agents miss.
