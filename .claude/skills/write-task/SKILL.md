---
name: write-task
description: Draft a task file in two passes with a human gate between them — design intent FIRST, hand-reviewed, then phases written against it. Use when creating a new task file, or when an existing one needs restructuring because its lower sections fight its goal. Sits between /task-management (which routes) and /review-task (which reviews).
---

# Write Task

Drafts a task file in **two passes with a gate**: write the *design intent* and stop; get Larry's read; only then write the phases. The pipeline is `/task-management` (route) → **`/write-task`** (draft) → `/review-task` (review) → `/build-task` (implement).

## Why the gate, not just the section

The failure this exists to prevent: phases and mechanism written before the design intent is settled, so the lower half of the file encodes assumptions the reviewer then has to *overcome* rather than confirm. That is expensive in the one resource that is actually scarce — reviewer time.

Empirically (`tasks/nebula-auth-identity-mint.md`, 2026-07-25/26): a mechanism was specified before the question it depended on was answered, survived **two** `/review-task` Stage-1 passes, and was then deleted outright once the underlying model was decided. A separate stated rationale ("both changes are on the same call chain") was simply false and went unnoticed for a week. Both are design-intent defects, and both are the kind a gate catches cheaply.

⚠️ **The gate is the mechanism. The section is just where the gate's subject lives.** Writing a design-intent section and then continuing straight into phases in the same pass gets you the cost and none of the benefit.

## When to skip

Small, mechanical, single-surface tasks — a rename, a version bump, a one-file fix. If you cannot write three non-obvious sentences of design intent, the task does not need this; write the file directly per `tasks/README.md`. **Do not manufacture intent to satisfy the outline.**

## Pass 1 — design intent only

Write the file down to and including *Design intent, constraints, and future state*, then **stop and ask for a read.** Nothing below it exists yet.

```markdown
# [Title — what it delivers, not what it touches]

**Status:** [one line: what this is, what it blocks or is blocked by, any pinned business decision + date]

**Objective — [the capability, in the sentence a stranger would need].**

## Context and current state
Built already: [what exists, anchored on symbol + quoted fragment — never line numbers]
Missing: [numbered, specific, each a thing this task adds or changes]

## Design intent, constraints, and future state
[The contract the phases must conform to. See the rules below.]
```

**Rules for the design-intent section — these are what make it worth reviewing:**

- **State it once.** This section is a *contract*, not a summary of the phases. If a claim appears here and again in a phase, delete one. (The identity-mint file stated one fact in **five** places; a reviewer then has to diff five copies to find the current one.)
- **Positive form only.** No "not X" disclaimers, no dated self-corrections, no rebutting an objector the reader cannot see. The negative belongs in the Decisions table as a rejected alternative — that is its home, per the `answer-by-describing-not-asserting` rule.
- **Name the invariant, not the incidental property.** "This is safe because *nothing currently mints such a principal*" expires silently. "This is safe because authority is confined to the node it runs in" does not. See `.claude/rules/calibration.md` § 4.
- **State every load-bearing assumption as a checkable claim.** If the intent depends on "these two changes share a call chain" or "this test is blocked only on X", write it as a claim so review can falsify it. Both of those examples were false in a real file.
- **Constraints:** which ADRs bind this, which rules apply, what the milestone allows. Cite; do not restate.
- **Future state:** what this makes possible next, and what it must not foreclose. Mark forward guidance inline as `⚠️ Design consideration:` — it gates nothing and must not become a tracked open question (`tasks/README.md`).
- **Open questions** are decisions that must be MADE and that gate something. If the honest answer to *"what happens if we never decide this?"* is "nothing — we keep a seam open," it is a design consideration, not an open question.

**Then stop.** Present the section and ask for a read. Expect to iterate here — it is cheaper than iterating on phases.

## Where the review stages go: Stage 1 → phases → Stage 2

**`/review-task`'s two stages straddle Pass 2, they do not both follow it.** Run Stage 1 (framing &
scope) on the phase-less file, resolve it, *then* write phases, *then* run Stage 2 (conformance).

The reason is what each stage can see. Stage 1 judges design intent, and phases present at that point
anchor reviewers on a shape that is about to move — the same argument that keeps phases out of a
pre-review draft at all. Stage 2 judges architecture, security and test strategy, which have almost
nothing to bite on *without* phases: a security reviewer wants the landing order, a test-strategy
reviewer wants to know which phase carries which criterion.

Validated on `tasks/archive/nebula-auth-decouple-from-auth.md` (2026-07-31). Stage 1 returned 20 findings, all
framing/scope, none of them "you are missing phases". Stage 2 then returned 40+ across two passes that
were **specifically about the phases** — decomposition, ordering, intermediate-commit health, criteria
that could not fail, mutation notes — none of which Stage 1 could structurally have seen. The ordering
also let a late scope change land *before* Stage 1, so Stage 1 reviewed the real scope; and it exposed
a defect that lives only in the delta between decisions (a Decisions row whose second rationale a
later-added phase silently stranded), which no single-snapshot review can catch.

⚠️ **If the task exercises a `Proposed` ADR, ratify it between Stage 2 and `/build-task`** — Stage 2 is the stage that reads ADRs in full, and build is when code starts depending on the commitment. Conditional, not a step: most tasks exercise none. See `docs/adr/README.md` § *Lifecycle*.

## Pass 2 — the rest, written against the approved contract

Only after the intent is approved:

```markdown
## Decisions
| Decision | Rejected alternative — why |
|---|---|
| [what we do] | [what we don't, and the reason — this is where every negative lives] |

## Phases
1. **[Goal, not a step list.]** [What this achieves and how.]
   - **Success criteria (capable of failing):** [what reds against pre-fix code and greens after]
   - **Mutation note:** [which single change makes each criterion red — if you cannot name one, the criterion is not capable of failing]

## Non-goals
[Named exclusions, each with a home if it is deferred rather than dropped]

## Relationships
[Cross-file dependencies · un-skip obligations this task owns in other lanes · what it supersedes · which backlog rows it invalidates]
```

**Notes that carry their weight:**

- **Phases are goals with testable criteria, not step lists.** `/build-task` transcribes phase order, so numbering must equal executable order — and every acceptance obligation must live *in a phase*, or it is neither transcribed nor verified. A floating top-of-file section is not built.
- **Success criteria must be capable of failing.** Name the mutation. Assert the *persisted effect*, not a `200` (a `@mesh` guard runs post-ack, so a denial is not in the synchronous response).
- **An edit to standing guidance goes in the LAST phase that changes what it describes — never the phase that happens to notice it.** The trap is specific: when a phase rewrites an *enumeration whose value is that it is exhaustive* (a reader list, a call-site table, "the N sites that do X") and states the command that checks it, a **later phase in the same task can add a member and silently falsify it**. The list then ships wrong in exactly the way it was rewritten to stop being wrong, and no test can red it. This is `calibration.md` §4 with the clock sped up — the justification expires *before the task ships*, so the "re-derive when the reason dies" reflex never fires. **When drafting, ask of every rule/ADR/README edit: does any LATER phase add a member to what this counts?** If yes, move the edit down; if it must stay early (because an earlier phase would otherwise ship code the rule forbids), say in the phase text which later phase amends it. Bit 2026-07-28: `/mint-narrower-token` Phase 3 wrote *"one CONTENTS reader"* into always-loaded `security.md`; Phase 4, four bullets later, added the second.
  - ⚠️ **This is in tension with "the work lives in the phase that causes it"** — which is right for *code* and for a rule that merely renames. Enumerations are the exception, because their correctness is a property of the whole task's end state, not of one phase's diff. Prefer a **structural** claim over a counted one where you can (*"every ADR-016 site is on this list"* survives a later phase; *"one CONTENTS reader"* does not).
- **Inventories over structure, never a bare count.** "Every `Response` in `src/` with a 4xx status carries `issues[]`" beats "`grep 'error_description'` returns nothing." Counts go stale or are wrong on entry; a count-based criterion passes silently when the count was wrong. Scope any grep the same way the criterion is scoped, or the two disagree.
- **Relationships is load-bearing, not bookkeeping.** Every drift untangled on 2026-07-26 was cross-file: a backlog row asserting the opposite of a decision, a sibling task's premise invalidated, an un-skip obligation with no owner. If this task changes what another file says, say so here.
- **Give every section a meaningful NAME, and expect it to be cited by that name** — a sibling file will refer to it, and a bare `§N` there is opaque and rots the moment a section is inserted or moves out. Number for order where order is load-bearing (phases); otherwise the name is the handle. See `workflow.md` § *Referring to things across files*.
- Keep inline `//` comment lines ≤ ~85 chars — Larry reviews these in Typora.

## Finally

- Run the invisible-character check (`workflow.md` § Stray invisible characters) — a byte count, not a grep.
- If the file contains Mermaid, run the render-safety check. Do not draw a diagram of an **undecided** model; that is the artifact people anchor on.
- Hand off to `/review-task`. If Pass 2 turned into a design conversation that reshaped the intent, go back to Pass 1 rather than forward to review.
