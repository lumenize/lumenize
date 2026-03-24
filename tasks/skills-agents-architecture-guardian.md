# Architecture Guardian Agent

**Status**: Design
**Parent**: `tasks/skills-and-agents.md`
**Workflow**: Implementation-first

## Goal

Build the Architecture Guardian sub-agent — the highest-value reviewer for task file pseudo-code, operating at the Mesh abstraction level. Its primary job is catching when designs or implementations drop to raw Workers RPC instead of using Mesh patterns (`lmz.call()`, continuations, two-one-way calls, multi-hop).

## Phases

### Phase 0: Doc Extraction Tooling

**Goal**: Build automated tooling to extract LLM-friendly context from `.mdx` docs, driven by a manifest file.

**How it works**:
- A manifest file lists source files + optional section anchors (e.g., `calls.mdx#two-one-way-calls`, `continuations.mdx`)
- A script reads the manifest, extracts the specified content, strips MDX-specific markup (frontmatter, Docusaurus imports, admonitions, tabs, `@check-example` annotations), and outputs clean markdown
- Output is a single file per agent, optimized for LLM context consumption

**Architecture Guardian manifest** (initial — refine during implementation):
- `website/docs/mesh/calls.mdx` — call patterns, two-one-way, multi-hop (~309 lines)
- `website/docs/mesh/continuations.mdx` — continuation mechanics (~104 lines)
- `website/docs/mesh/managing-context.mdx` — callContext propagation (~173 lines)
- `website/docs/mesh/lumenize-do.mdx` — DO base class patterns (~186 lines)
- `website/docs/mesh/services.mdx` — service registration, inter-DO communication (~805 lines, may need section filtering)

Estimated output: ~500-700 lines after stripping, well within agent prompt budget.

**Success Criteria**:
- Script exists in `tooling/` (or `scripts/`)
- Manifest format is defined and documented
- Running the script produces clean markdown from the Architecture Guardian manifest
- Output is diffable so changes to source docs are visible
- Can be reused by other agents with different manifests (Security Guardian → `security.mdx`, Test Strategist → `testing.mdx`)

**Open questions**:
- Where does the output live? `.claude/agent-context/`? Committed or gitignored?
- Should this run as part of `postinstall`, a pre-commit hook, or on-demand only?
- Does it need to handle code blocks specially (preserve them verbatim while stripping surrounding MDX)?

### Phase 1: Agent Definition

**Goal**: Create the Architecture Guardian agent with its system prompt, extracted doc context, and correct/incorrect pattern examples.

**Responsibilities** (two modes):

**Task review mode** (primary):
- **Mesh pattern enforcement** (highest-value check):
  - `this.lmz.call()` over raw Workers RPC — always
  - `this.lmz.ctn()` continuations for callbacks — how they propagate callContext
  - Two one-way call pattern: Worker makes external call, calls back to DO with result
  - Multi-hop calls: client → star → somewhere else → directly back to client
  - `this.lmz.callContext` for auth/identity propagation
  - Flags pseudo-code that uses raw `stub.method()` instead of `lmz.call(stub, continuation)`
- Inverted DWL model: DO calls out to DWL, never reverse
- Storage conventions: synchronous API only, SQL naming, write cost optimization
- Package dependency graph: mesh is MIT, nebula extends but never the reverse
- Cross-package boundary review: what belongs in mesh vs nebula vs nebula-auth
- Architectural feasibility of pseudo-code (e.g., "this requires async in business logic — won't work")

**Conformance mode** (post-implementation):
- Does the implementation use `lmz.call()` / `lmz.ctn()` everywhere it should?
- Any raw RPC that snuck in during implementation?
- Storage patterns match the spec?

**Agent prompt structure**:
1. Role and purpose
2. Extracted doc context (from Phase 0 tooling)
3. Correct vs incorrect pattern examples (extracted from codebase)
4. Review checklist
5. Output format (structured findings)

**Success Criteria**:
- Agent definition exists in `.claude/skills/` or `.claude/agents/`
- Includes extracted Mesh docs as context
- Includes at least 3 correct/incorrect pattern pairs from real code
- `do-conventions` content absorbed (raw DO guidance as fallback layer)
- Tested against a recent task file — produces actionable findings

### Phase 2: Validate & Integrate

**Goal**: Run the agent against real task files and calibrate.

**Success Criteria**:
- Run against `tasks/nebula-resources.md` — does it catch the kinds of things fresh-context reviews catch?
- Run against a completed task file where we know what the reviews found — does it find the same issues?
- Findings are actionable, not generic advice
- `do-conventions` skill retired or redirected to Architecture Guardian
- `task-management` skill updated to reference the Architecture Guardian

## Relationship to `do-conventions`

The Architecture Guardian absorbs `do-conventions`. Raw DO-level guidance (input/output gates, wall-clock billing, synchronous methods) remains valid but is the fallback layer. If you're using Mesh patterns correctly, you naturally follow DO best practices. The guardian's primary job is ensuring Mesh patterns are used, not re-teaching DO fundamentals.

Content migration:
- Sections 1-3 (storage, private members, env vars) → kept as-is in guardian context
- Section 4 (synchronous methods) → reframed: "if you're using `lmz.call()` this is handled; check for raw async"
- Sections 5-8 (instance state, IDs, billing, routing) → kept as fallback checks
- Sections 9-11 (testing, env type, for-docs) → move to Test Strategist
- Sections 12-16 (SQL, migrations, bindings, WebSocket, write costs) → kept as-is in guardian context

## Notes

- The doc extraction tooling from Phase 0 is intentionally general-purpose. Other agents will use it with different manifests.
- The `services.mdx` file is 805 lines — likely needs section-level filtering in the manifest rather than including the whole file.
- The agent needs to understand that Mesh patterns are the *preferred* level, not the *only* level. There are legitimate cases for dropping to raw DO primitives (e.g., alarm handling, WebSocket accept). The guardian should flag raw usage for review, not reject it outright.
