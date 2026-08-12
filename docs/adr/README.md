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

`NNN-short-slug.md`, about one page: **Context, Decision, Alternatives considered, Consequences.** Header carries Date / Status / Deciders, and an **Evidence** line naming the code and the incidents the decision answers to — the body may defer to it rather than re-telling them. Link out for history; don't inline it.

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

Not "after N consumers" — after the **change rate drops**. An ADR still generating wording fixes is still teaching you something. It is a signal anyone can check rather than a judgment call: ADR-016 changed three times in two days (not ready).

⚠️ **Citation is not contact, and mistaking the two is how a text gets accepted while still defective.** ADR-015 sat unmoved for two weeks while being cited constantly — including as a settled constraint in another file's design — and read as ready on exactly that basis. Then its terms were used in prose written for a reader, and it took two rounds of fixes in two days: a definition that denied the superuser dominion anywhere, a characterisation of passage that two readers read oppositely, and a Decision clause stating dominion as position alone. The decision never moved; the statement was wrong the whole time and nothing had pressed on it. **Count changes made under contact, not quiet time since the last edit.**

### Record what the battle-testing found

An exception proposed against an ADR and **rejected on its merits** goes into **Alternatives considered** — the same place a superseded approach goes, for the same reason (§ *Forward-facing discipline*: the growing list is useful signal for the next reviewer). A reviewer then sees what the ADR has already survived instead of re-proposing it.

### The ratification gate

**If a task file exercises a `Proposed` ADR, ratify it after `/review-task` Stage 2 resolves and before `/build-task`.**

- **Stage 2, not Stage 1** — Stage 2 is the ADR stage: its lenses are handed the full ADR text and told to flag a conflict as a blocker. Stage 1's lenses (framing, scope, product vision) would catch one only by accident.
- **Before build** — that is when code starts depending on the commitment.
- ⚠️ **Conditional, not a pipeline step.** Most task files exercise no `Proposed` ADR; a fixed stage would fire spuriously and get ignored, which is worse than not having it.

## Forward-facing discipline

⚠️ **Where the body describes something the code has not reached, record it in a blockquote opening `**Today's code differs.**`** — never as a "today" or "currently" hedge inside the commitment itself. A hedge makes the decision read as provisional, which is the opposite of what an ADR is for; a blockquote states the commitment in the present tense and puts the divergence beside it, where it is enumerable: `grep -rn '^> \*\*Today' docs/adr/`. This is [`docs/vision/auth.md`](../vision/auth.md)'s convention and it works the same way here. It is also what makes ratifying **before** the work lands coherent — see § *The ratification gate*.

An ADR reads as if written fresh for the **current** design — it is not an append-log. When reality drifts, **rewrite the body** so it describes the decision as it now stands; a superseded approach moves into *Alternatives considered* (it is exactly that — an approach considered and rejected, and the growing list is *useful* signal for the next reviewer). Don't accrete dated "Amended …" notes or a mechanism-history section in the body — that's the noise a fresh review panel has to wade through, and **git is the record** that preserves how the decision evolved. Keep the Status line current: `Proposed`, `Accepted`, `Superseded by ADR-NNN`, or `Deprecated` (§ *Lifecycle*).

## How ADRs reach coding agent context

ADRs have no automatic loading path, so two mechanisms keep them live:

1. **One-liner index** in `.claude/rules/workflow.md` § Architecture commitments (always loaded). Adding an ADR means adding its one-liner there — an ADR without an index line is invisible.

   ### The index line — a POINTER, with a budget
   ⚠️ **One sentence naming the commitment, plus any tripwire that would bite before a reader thought to open the ADR. Target ≤60 words; treat 100 as the hard stop.** Argument, evidence, measurements, worked examples, and dated amendment history all belong in the ADR — the index exists to make you *go read it*, not to substitute for it.

   **This has a measured failure behind it.** Left unbudgeted, the section grew to **3,273 words** — 38% of `workflow.md` and 22% of *all* always-loaded standing guidance — by accreting restated reasoning one reasonable-looking addition at a time. Condensed back to ~1,270 on 2026-08-05 with no commitment changed. ⚠️ **The trim also found content that existed ONLY in the index** (ADR-012's `emailVerified` tripwire), which is the failure mode to actually fear: an index line is not a place to record a decision. If a clause belongs anywhere, it belongs in the ADR **first** — then decide whether the index needs to point at it.

   Growth is watched by a scheduled routine (monthly, threshold-triggered), which **proposes and never edits** — trimming a guard is a silent-failure class, so a human decides.

   ### Reviewing always-loaded guidance — the `Guidance-Review:` trailer
   The growth watch holds the line but **never re-examines the baseline**, so a second monthly routine nominates one always-loaded file for a line-by-line human pass, scored by `words × months-since-last-review`. It needs to know when a file was last *reviewed* — which is not when it was last *modified*, since the files that grow constantly are exactly the ones nobody re-reads.

   ⚠️ **That date is derived from git, never from a maintained list.** A review commit carries a trailer naming the file it covered:

   ```
   Guidance-Review: .claude/rules/calibration.md
   ```

   Add it **only for a genuine line-by-line pass of the whole file** — not for an ordinary edit, and not for trimming one section (the 2026-08-05 ADR-index condensation deliberately carries no trailer for `workflow.md`, because only that section was examined). If the trailer is forgotten the file simply looks unreviewed and gets nominated again: the lapse fails toward over-nominating, which is the safe direction.
2. **`/review-task` reads the full ADR files** while scouting the spec — design review is where ADR conflicts get caught. `/build-task` deliberately does not re-read them: by build time the task file has been reviewed, and the index one-liners are in context anyway.
