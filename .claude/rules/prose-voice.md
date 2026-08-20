---
paths:
  - "docs/adr/**/*.md"
  - "docs/vision/**/*.md"
  - "tasks/**/*.md"
  - ".claude/rules/*.md"
  - ".claude/skills/**/*.md"
  - "CLAUDE.md"
---

# Prose Voice — write for Larry, who reads the prose of the files covered by the globs above

All of the prose under `docs/adr/`, `docs/vision/`, `tasks/`, and `.claude/rules/` is read by
one person, closely, and usually once. The one narrowing of that, is for `tasks/`. He only reads
the Pass 1 sections. He is the bottleneck. A sentence he has to read twice costs more than the 
three sentences it replaced.

⚠️ **You MUST read this before DRAFTING, not only before editing.** The `paths:` glob
above fires when you touch a matching file, which is too late for a new one — the draft
is already composed. ADR-016 and ADR-019, the two documents that drifted furthest, were
both new files.

## Where the target comes from

Three pieces of writing in this repo came from Larry's own hand. They are the reference,
one per genre — read a section of the one matching what you are writing, and do not point
a reader at them from inside another file, because loading them costs more context than a
draft is worth.

| Genre | Reference |
|---|---|
| Vision prose | `docs/vision/auth.md` |
| ADR | [ADR-015](../../docs/adr/015-passage-and-dominion.md) |
| Task file | `tasks/archive/nebula-invite.md` § *Context* through § *Constraints* (the pass-1 sections; its Decisions table and phases are not his) |
| Rule | **No hand-written reference yet.** `.claude/rules/*.md` is in scope — always-loaded rules are the strongest style example an agent sees, and `calibration.md` is where the abstraction in ADR-016 and ADR-019 leaked from. But its budgets are borrowed from the task-file numbers on a guess. Fix this by making a reviewed rule the reference. |

**Skills are governed on the same terms as rules** — `/review-task`'s SKILL.md is 35KB of
prose an agent acts on, and its lens strings are where an abstraction does the most damage,
because a panel repeats whatever vocabulary it was handed.

**What transfers to a rule or a skill and what does not.** Both are agent-facing reference material,
consulted rather than read start to finish, and the MUST/SHOULD convention makes them
deliberately terse — so leading a reader on a journey, and the roadmap sentence, do not
apply. Everything else does, and for the same reason: concrete over abstract, spell it out
rather than naming it, an example wherever something is defined.

**The genres differ, and the difference is real.** A task file is a cold-start spec: it
packs a decision, its rationale and its citation into one sentence, and its sentences run
about a third longer than `auth.md`'s. That is not drift — the length carries chains of
concrete facts. The budgets below are set per genre against these three files.

The rest of this file names what those two do differently, states the budgets that
separate them from the drafts that missed, and gives the command that checks a file.

## The moves that make the difference

**Open with the plain claim, then unpack it in order.** ADR-015 begins *"Coarse-grained
access control is determined by three concepts — scope, dominion, and passage."*
`auth.md` § *Scopes* opens with a seven-word sentence on its own line. Neither opens with
a compressed aphorism. You SHOULD write the specific sentence first and then ask whether
the summary above it survives.

**Tell the reader where they are going.** ADR-015: *"The rest of this ADR is spent
precisely specifying those calculations…"* `auth.md`: *"The sections that follow expand
on the model above."* Every Context section SHOULD end with a sentence like this.

**Put a literal value beside every definition.** `auth.md` gives the scope as
`https://nebula.lumenize.com/{bindingName}/{u}.{g}.{s}/`, then explains that braces stand
in for a value, then contrasts that with literal `:scope` `URLPattern` syntax — because a
reader would otherwise trip. ADR-015 shows `u.g.s1` against `u.g.s10` and `acme` against
`acme-2`, and says why: *"the second is the one a naive `startsWith` gets wrong."* Every
section that defines something MUST carry one real example.

**Walk the reader down a numbered path.** `auth.md` has M1–M7 and R1–R7. ADR-015 says
*"These things follow:"* and lists the consequences. ADR-018 says *"Three consequences
follow, in preference order."* `auth.md` even switches to second person for the walk:
*"You enter by authenticating… You then open a connection by presenting one."*

**Reach for a picture when the point is a judgement call.** ADR-015 on why downward is
generous: *"A Universe or Galaxy admin stands to their tenancy roughly as we stand to our
own Cloudflare account."* ADR-018: *"The singleton absorbs load by running out."*

**Spell it out rather than naming it.** A phrase like *the reflex*, *the shape*, *what is
replaceable*, or *the tell* asks the reader to hold a definition you never gave them. Say
the thing instead. Where an abstraction genuinely earns its place, the concrete case MUST
follow in the same paragraph; where there is no concrete case to give, delete it.

**A warning usually means the positive instruction above it is missing.** When you reach
for ⚠️, check what the surrounding sentences actually told the reader to do. A warning
saying *"don't confuse X with Y"* is generally load-bearing only because the paragraph
never said plainly what X is and when to reach for it — write that sentence, and the
warning is redundant. This is where most of the ⚠️ in this repo came from, and
hand-editing them out one at a time is how it was found: fixing the instruction deleted
the warning every time, and the reverse never worked.

⚠️ **Density is a consequence, not a target — and there is deliberately NO budget on it.**
A file whose subject is traps (`security.md`, `calibration.md`) should carry many; a file
that explains how something works, like `raw-comm.md`, carries few. Counting them invites the one repair that
makes a document worse — deleting a true warning to hit a number — which is cheaper than
the real fix and was done in this repo the day a warning budget existed: a ⚠️ was dropped
from a true statement in `security.md` purely to keep the count flat, and reported as
"neutral". Every other budget here is safe to satisfy lazily; that one was not.

**Coin a term only the way ADR-015 does it.** Its Terminology section defines `dominion`
and `passage`, names what they replaced, and says not to reintroduce those. A new term
MUST be proposed to Larry before use, and MUST arrive with a definition and the rejected
alternatives, or it MUST NOT be used at all.

## Duplication — direction decides it

**Across files, a little repetition is expected and wanted.** One or two sentences
restating a sibling's reasoning, so the reader need not open it, is correct here. This
does NOT license restating another file's counts, dates, inventories, or verbatim
wording — those rot silently, and `workflow.md` § *Referring to things across files* owns
that separate rule.

**Within one file, direction decides it.** A forward-looking summary is fine: it tells
the reader what is coming. A backward restatement is not — a point made in Decision MUST
NOT be made again in Consequences. The check lists candidates and does NOT fail on them,
because it cannot tell a lazy repeat from a deliberate one: it finds four in Larry's own
hand-written invite prose, and at least some of those earn their place. Read what it
prints and judge each one.

## Not for the reader

**Notes to the next editor go in frontmatter**, as `auth.md`'s `working_agreement` block
already does. ADR-016 carries *"That wording is deliberate — it cannot go stale…"* in its
body, which the reader has no use for.

**Dated build status goes in the task file.** ADR-016's *"✅ Resources is conformant as of
2026-08-20"* is what `docs/adr/README.md` § *Forward-facing discipline* already forbids:
an ADR reads as if written fresh for the current design.

## The budgets

Every number below is set at what the hand-written reference for that genre actually
measures, so a file within budget is no worse than Larry's own. All three references pass.

| Budget | Gate | Where the number comes from |
|---|---|---|
| Longest bullet | ≤ 150 (ADR, vision) · ≤ 185 (task, rule) | `auth.md` 112, ADR-015 145, invite pass-1 178. ADR-016 has four above 150, longest 230. |
| Average sentence | ≤ 22 (ADR, vision) · ≤ 27 (task, rule) | `auth.md` 20.0, ADR-015 19.3, invite pass-1 25.5 · ADR-016 24.6. |
| Bare abstract subjects | < 4, or ≤ 0.30/KB | **The one that matters most** — it measures the defect directly, and the cheap way to satisfy it (name the concrete thing) *is* the repair. Holds across all three genres: ADR-015 0.09/KB, `auth.md` 0.12, invite pass-1 0.24 · ADR-016 0.57, ADR-019 0.87. Target 0.15. ⓘ It counts a *mention* as a use, so a file quoting these phrases as counter-examples — this one does, above — reads high for a fair reason. |
| ADR body | ≤ 13KB | `docs/adr/README.md` says "about one page"; 13KB is ADR-015's size. |

The ⚠️ count is **reported but never gated** — read it as a description of what a file is
about, not as a score. Header fields (`**Date**`, `**Status**`, `**Deciders**`,
`**Evidence**`) are excluded from every measurement and reported separately.

```sh
node scripts/check-prose.mjs <file>...    # gate: exits non-zero over budget
npm run audit:prose                       # whole-tree report
```

**You MUST run the gate on the prose files your own diff touches, and MUST bring each one
within budget before reporting the work done.** It is diff-scoped on purpose. Most of the
repo predates this file — 50 of 97 governed files are over budget as of 2026-08-20 — so a
whole-tree gate would fail on day one and be switched off. You cannot
make a file worse without the gate catching you, and what you touch, you fix.

## What the budgets cannot see

They count symptoms. They cannot tell whether an example is a good one, whether the
opening claim survives its own paragraph, or whether a reader is being led somewhere.
A file inside every budget can still be abstract and hard to follow. Read your draft
against a section of the reference for its genre before you call it done.
