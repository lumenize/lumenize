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

## Forward-facing discipline

An ADR reads as if written fresh for the **current** design — it is not an append-log. When reality drifts, **rewrite the body** so it describes the decision as it now stands; a superseded approach moves into *Alternatives considered* (it is exactly that — an approach considered and rejected, and the growing list is *useful* signal for the next reviewer). Don't accrete dated "Amended …" notes or a mechanism-history section in the body — that's the noise a fresh review panel has to wade through, and **git is the record** that preserves how the decision evolved. Keep the Status line current: `Accepted`, `Superseded by ADR-NNN`, or `Deprecated`.

## How ADRs reach coding agent context

ADRs have no automatic loading path, so two mechanisms keep them live:

1. **One-liner index** in `.claude/rules/workflow.md` § Architecture commitments (always loaded). Adding an ADR means adding its one-liner there — an ADR without an index line is invisible.
2. **`/review-task` reads the full ADR files** while scouting the spec — design review is where ADR conflicts get caught. `/build-task` deliberately does not re-read them: by build time the task file has been reviewed, and the index one-liners are in context anyway.
