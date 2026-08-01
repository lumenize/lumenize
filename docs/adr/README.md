# Architecture Decision Records

The few repo-shaping commitments — single digits, ever. The bar is not abstraction height; it's **relitigation risk**.

## The bar — write an ADR only when ALL of these hold

- It spans packages/subsystems, not one component's design.
- It survives mechanism swaps — the commitment is *what*, not *how*. (ADR-001's principle outlived its tsc mechanism; ADR-002's value-space promise outlived the tuple→W4 wire-format swap.)
- A competent new contributor — or a fresh LLM session with no memory — would plausibly propose violating it within their first week.

## What does NOT belong here

- Enforceable how-to-write-code conventions → `.claude/rules/` (those load into context automatically; ADRs don't).
- Project-scoped decisions → "Decisions pinned" in the task file, archived with the project. If a pin must outlive its task file, promote it to an ADR when the task archives.
- Research records / experiment findings → task files in `tasks/archive/`; link them from the ADR as evidence.
- Implementation notes and mechanism detail → task files. Mechanism in an ADR is the part that rots — name the current mechanism in a sentence and link out; if it swaps, rewrite that sentence rather than appending a history of past mechanisms.

## Format

`NNN-short-slug.md`, about one page: **Context, Decision, Alternatives considered, Consequences.** Header carries Date / Status / Deciders. Link out for history; don't inline it.

## Lifecycle — what `Proposed` and `Accepted` mean

**`Proposed`** — the decision is a **hypothesis under test**. Cite it, follow it, build against it: that is *how* it gets battle-tested, and it is effective in that state. A conflict with real work is **bidirectional evidence** — either side may be wrong.

**`Accepted`** — the decision is a **commitment**. A conflict means the work is wrong, unless you explicitly supersede the ADR.

### A conflict is evidence — of one of three things

Reaching for "the ADR must be wrong" whenever it is inconvenient is not testing, it is **erosion** — precisely what ADRs exist to prevent. Classify before acting:

| | The conflict means | Do |
|---|---|---|
| **(a)** | the decision is wrong or over-general | **change the decision** — legitimate while `Proposed`; an explicit supersession once `Accepted` |
| **(b)** | the work is wrong | change the work — the ordinary case, and it stays ordinary |
| **(c)** | the decision is right, but its **wording** invites a misreading | sharpen the prose; the decision does not move |

⚠️ **(c) is the common one, and the easiest to misfile as (a).** All three ADR-016 edits in its first week were (c) — "mechanism may change" reading as an open per-consumer choice, an implied storage obligation nobody intended, and contents read as a checklist each caller re-implements. The decision never moved. Offer only "change the ADR or change the work" and (c) drifts the *decision* when a sentence was the whole problem.

### Ready to accept when it stops changing under contact

Not "after N consumers" — after the **change rate drops**. An ADR still generating wording fixes is still teaching you something. It is a signal anyone can check rather than a judgment call: ADR-016 changed three times in two days (not ready); ADR-015 has not moved since it was written while being cited constantly, including as a settled constraint in another file's design (ready).

### Record what the battle-testing found

An exception proposed against an ADR and **rejected on its merits** goes into **Alternatives considered** — the same place a superseded approach goes, for the same reason (§ *Forward-facing discipline*: the growing list is useful signal for the next reviewer). A reviewer then sees what the ADR has already survived instead of re-proposing it.

### The ratification gate

**If a task file exercises a `Proposed` ADR, ratify it after `/review-task` Stage 2 resolves and before `/build-task`.**

- **Stage 2, not Stage 1** — Stage 2 is the ADR stage: its lenses are handed the full ADR text and told to flag a conflict as a blocker. Stage 1's lenses (framing, scope, product vision) would catch one only by accident.
- **Before build** — that is when code starts depending on the commitment.
- ⚠️ **Conditional, not a pipeline step.** Most task files exercise no `Proposed` ADR; a fixed stage would fire spuriously and get ignored, which is worse than not having it.

## Forward-facing discipline

An ADR reads as if written fresh for the **current** design — it is not an append-log. When reality drifts, **rewrite the body** so it describes the decision as it now stands; a superseded approach moves into *Alternatives considered* (it is exactly that — an approach considered and rejected, and the growing list is *useful* signal for the next reviewer). Don't accrete dated "Amended …" notes or a mechanism-history section in the body — that's the noise a fresh review panel has to wade through, and **git is the record** that preserves how the decision evolved. Keep the Status line current: `Proposed`, `Accepted`, `Superseded by ADR-NNN`, or `Deprecated` (§ *Lifecycle*).

## How ADRs reach coding agent context

ADRs have no automatic loading path, so two mechanisms keep them live:

1. **One-liner index** in `.claude/rules/workflow.md` § Architecture commitments (always loaded). Adding an ADR means adding its one-liner there — an ADR without an index line is invisible.
2. **`/review-task` reads the full ADR files** while scouting the spec — design review is where ADR conflicts get caught. `/build-task` deliberately does not re-read them: by build time the task file has been reviewed, and the index one-liners are in context anyway.
