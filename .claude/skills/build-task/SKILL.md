---
name: build-task
description: The "go" procedure — implement a reviewed task file phase-by-phase, then fan out adversarial verifiers that check each phase against its own success criteria + .claude/rules/ (which /code-review can't do because it doesn't know the task file). Use when the user says "go"/"implement"/"build" on a task file that has already been through /review-task (or equivalent design review).
---

# Build Task

The fan-out at "go". Its reliable win is **verification**, not parallelizing the build — by the time a task file has been through deep review, implementation is usually minutes of transcription. So: implement phase-by-phase (sequentially, in the current branch, following the rules), then fan out verifiers that confirm each phase actually meets the task file's success criteria.

**No parallel implementation, no worktrees.** An earlier draft offered worktree-isolated parallel implementation for "independent" phases. Deliberately removed: in this repo's solo, long-running-branch workflow, merge/conflict cost exceeds any transcription speedup. Don't reintroduce it. (Worktree isolation remains fine for self-contained *experiments* whose results are captured in documents and won't have conflicts if merged — see `workflow.md` § Experiments.)

> ⏳ **TEMPORARY — remove when pre-alpha ships.** Until pre-alpha ships there is **one wipe+redeploy gate at the very end**, not a per-task one (see the `task-files-neednt-be-deployable` memory). So do **not** fail a phase or task for leaving the system non-deployable, or for depending on a later pre-alpha task file. We still test our work — but **testing may be staged across files**: a file may land most of its coverage and defer the rest to a later (still pre-alpha) file, **provided that later file carries explicit acceptance criteria for the deferred coverage** (an `it.skip` + pointer, or a named criterion there). When pre-alpha ships, delete this block and restore full per-task deployable-and-tested expectations.

## Usage
`/build-task <path-to-task-file>` (defaults to the active task file).

## Procedure

### 1. Read the task file
Read the task file + linked sub-tasks + referenced docs + the relevant `.claude/rules/`. Enumerate the phases as `{ id, goal, successCriteria }` from the task file's own phase structure.

**Exploratory phases.** Most phases are transcription of a pinned design — they carry decisions + concrete, testable success criteria, and the verifier checks conformance to them. But some phases are inherently *empirical*: real-infra harnesses, browser/WS tooling, network-failure simulation — work whose mechanism you can only learn by running it (the §5.3.7-v4 WS-disconnect tooling took three tries: `ws.close()` hangs through the http-proxy → CDP offline hangs the whole vitest-browser run → synthetic `CloseEvent` works; none of that was pin-able in advance). Such a phase should be **explicitly tagged exploratory** in the task file (per `tasks/README.md`). When a phase has only `"works"`-grade bullets and no pinned decisions, do NOT silently hold it to transcription-grade conformance — that degrades its verifier to a rubber stamp. Instead treat it as exploratory: its deliverable is **(a)** capable-of-failing tests for the discovered behavior and **(b)** a captured findings note recording the mechanism that worked *and the alternatives that failed* (harvest it into a reference memory or the right rule — v4's findings became the `vitest-browser-ws-disconnect` memory). If a phase is thin and is *neither* tagged exploratory nor pinned, that's a spec gap — flag it before building, don't paper over it.

### 2. Implement
Phase by phase, sequentially, in the current branch, following `.claude/rules/` (path-scoped rules auto-load as you touch files). After each phase, run the narrowest type-check / tests for the files you touched. Update the task file as you go when reality diverges from the plan. Don't commit.

⚠️ **At each phase end, walk your own DIFF before you report the phase done.** For every line you wrote that **asserts something about existing code** — a JSDoc claim, a code comment, an edit to a task file or to standing guidance (`.claude/rules/`, an ADR, `backlog.md`) — either cite the check you ran or run it now. Diff-scoped, so it costs a dozen lines.

**Prose files in the diff get the voice gate.** Any `docs/adr/`, `docs/vision/`, `tasks/`,
`.claude/rules/` or `CLAUDE.md` file the phase touched must pass
`node scripts/check-prose.mjs <those files>` before the phase is done — see
`.claude/rules/prose-voice.md`. Diff-scoped: bring the file no further over budget than you
found it, and bring what you wrote within it.

**Why this and not the verifier panel:** the panel in step 3 checks each phase against its *success criteria*, and a confidently-worded false claim satisfies those. The discriminator is mechanical and was measured (2026-07-30, `nebula-impersonation-client` review): **every claim verified with a targeted tool call was right; every claim inferred from adjacent context was wrong** — five in one sitting. ⚠️ **"I already read that file" is NOT the check** — in the worst instance the disproving line was in the session's own earlier tool output, so the failure was not looking but failing to ask what the read implied. Per-*claim*, not per-file.

⚠️ **This bites hardest on the standing-guidance edits**, which are the ones no test can red: they ship always-loaded, and a wrong one misleads every future session. The task file is **not evidence for itself** — when a line you are writing is determined by a claim the task file already makes, verify that claim rather than inheriting it. (`✅ Checkable` in a task file means the claim was *shaped* to be falsifiable, **not** that anyone ran it; two such claims shipped false through several review passes precisely because the marker implied otherwise.)

**The diff-walk is structurally blind to the text your work FALSIFIES without touching.** When a phase completes something an ADR or rule tracks as pending — retires an interim, closes a "not yet" — grep that document for its own pending-status language (`not conformant|not yet|interim|Today's code differs`) and retense what the build just made true. Bit 2026-08-20 (wipe item 6): the build retired the narrow-`changedBy` interim while ADR-016's own Corollary still declared *"Resources is not conformant yet"* and quoted the deleted compare verbatim — outside the diff, so the phase-end walk never saw it; only the verifier panel caught it.

🛑 **A phase is not done until every new test has been mutation-checked.** Not "you should"; the
phase report is blocked on it. Four mechanical checks, in order — they cost minutes and they are the
only things that have ever caught this class:

1. **Mutate every new assertion.** Break the code it targets, confirm THAT test reds, restore with a
   reverse `Edit`. ⚠️ A mutation that reds EVERYTHING proves nothing — it just broke construction.
   Narrow it until exactly the intended test fails.
2. **Treat first-run-green as a SIGNAL, not a result.** A batch of new tests passing on first write
   is the strongest available predictor that some of them assert nothing. Measured 2026-07-30: a
   phase passed 8/8 on first write and three of the eight were vacuous.
3. **Grep every non-standard symbol a new test touches** (`git grep -c '\bsymbolName\b'`). Three
   vacuous tests in that build asserted against methods that DO NOT EXIST — `lmzTestDropSocket`,
   `__onLoginRequiredProbe`, `lmzTestAccessToken`. Each was a silent no-op: an optional call on
   `undefined` does nothing, assigning an unread property always succeeds, reading a missing field
   yields `undefined`. Type-checking cannot help — the access is behind `as any` — and neither can
   a different runtime, since all three are no-ops everywhere.
4. **When a mutation does NOT red, there are THREE causes — and for code you just wrote, the third
   is the likely one.** (a) The fixture is the safe shape. (b) The assertion is vacuous. (c) **The
   code is unnecessary** — you cannot red a line nothing depends on. Measured 2026-08-13: a route
   runner normalised both the table's HTTP method and the *request's*; removing the request half
   reddened nothing, which is what exposed it as dead code rather than untested code (the platform
   already uppercases standard verbs, and HTTP methods are case-sensitive, so it was inventing
   lenient matching). ⚠️ The reflex is to write a test for the un-redded line; ask first whether the
   line should exist. A test written to cover unnecessary code ossifies it.
5. **When (a) is the cause, suspect the FIXTURE before the mutation.** Twice in that build the
   conclusion "this cannot be tested here" was wrong; the truth was "my fixture is the safe shape."
   Both times the fix was to construct the *dangerous* shape the design docs already named — one
   subject at two scopes rather than two subjects; an admin logged in AT the scope they impersonate
   into rather than above it.

⚠️ **Mutation is necessary and NOT sufficient** — it proves an assertion CAN fail, never that the
thing asserted against resembles production. It is structurally blind to fidelity: mutate the code
and an unfaithful fixture still reds, because it faithfully reports the mutated wrong behaviour. That
is what `/live` is for, and why both are required rather than either.

**Phase gating**: default to asking "Ready to proceed with [next phase]?" after each phase — but roughly half the time the user authorizes running unattended through multiple phases up front (more likely for experiments, isolated changes, or when they're away from the desk but reachable). Honor that for the phases it covers; between phases, still post a brief status so the transcript shows where each phase ended. The authorization doesn't carry over to the next task.

### 3. Verify (the always-worth-it fan-out)
First run the affected packages' full test suites once, inline — verifiers *read* code, they don't run it, so runtime regressions must be caught here (and a green suite is itself a success criterion for most phases). Don't push test runs into the parallel verifiers: concurrent vitest runs in one working tree thrash.

**For a UI-touching phase, also drive the running app** (`/live`) before the fan-out — a green suite and a code-reading verifier are necessary-not-sufficient for what a user *sees*, and neither catches a code-vs-runtime divergence (a capability present in code but never wired into the UI). Non-UI phases skip this.

**Before the fan-out, re-run any COMPLETENESS INSTRUMENT a phase wrote — against the FINAL tree, not the tree that phase left.** When a phase edits an enumeration whose whole value is that it is exhaustive (a reader list, a call-site table, a "these are the N sites" claim) and states the command that checks it, a *later* phase in the same task can add a member and silently falsify it. The list is then wrong in exactly the way it was written to stop being wrong. This is `calibration.md` §4 with the clock sped up — the justification expires before the task ships — so the usual "re-derive when the reason dies" reflex never fires. Bit 2026-07-28 on `/mint-narrower-token`: Phase 3 wrote *"one CONTENTS reader"* into always-loaded `security.md` and Phase 4 added the second; the suite was green and only a verifier caught it. **Cheap rule: grep the task file for a phase that edits a rule/ADR/README enumeration, and re-run its own stated command last.**

⚠️ **Re-running is NOT enough — an instrument can be incapable of running at all, and its failure mode is SILENCE.** Bit 2026-08-16: a phase committed its conformance grep into a JSDoc header, escaping the `*/` with an HTML entity; the surviving `&` backgrounded the grep and commented out the rest, so it returned **zero stdout, zero stderr, exit 0** — reporting a conformant tree whatever the tree held. Re-running it "passed". ⇒ **For any command a phase writes into a rule, a criterion, a task file or a comment: run it, and confirm it can PRODUCE OUTPUT before trusting an empty result.** Point it at a known hit, or drop a filter, then narrow. (`testing.md` § *Tests must be capable of failing* carries the durable form — but that rule is path-scoped to test files, so a phase that writes an instrument into `src/` will not have loaded it.)

Then fan out one adversarial verifier per phase against the **current working tree**. This checks **task-conformance** — does the code satisfy *this task file's* success criteria — which `/code-review` cannot, since it doesn't know the task. For an **exploratory phase** (step 1), the verifier's bar shifts: rather than conformance to a (nonexistent) pinned spec, it confirms the empirical deliverables landed — capable-of-failing tests for the discovered behavior plus a captured findings note (the mechanism that worked + the alternatives that failed). Pass a phase's `exploratory: true` into its verifier so it applies the right bar instead of failing on missing pinned criteria.

```javascript
export const meta = {
  name: 'build-task-verify',
  description: 'Verify each implemented phase against its task-file success criteria + rules',
  phases: [{ title: 'Verify' }],
}
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {})   // args may arrive JSON-encoded
const TASK = A.task     // task file + linked sub-tasks/docs, pre-read in step 1
const PHASES = A.phases // [{ id, goal, successCriteria }]
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['conforms', 'issues'],
  properties: {
    conforms: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['severity', 'detail'],
      properties: { severity: { enum: ['blocker', 'major', 'minor'] }, detail: { type: 'string' } } } },
    summary: { type: 'string' },
  },
}
const verdicts = await parallel(PHASES.map(p => () =>
  agent(
    `Adversarially verify phase "${p.id}" against the CURRENT working tree — read the files it touched. ` +
    `READ ONLY: do NOT run tests and do NOT edit/mutate any source. The fan-out shares ONE working tree, so ` +
    `concurrent test runs and source edits thrash each other and can leave the file under test transiently ` +
    `broken for sibling verifiers. The parent already ran the suites green before this fan-out; assess ` +
    `capable-of-failing and correctness by READING the code (and the recorded mutation-validation results in ` +
    `the task file), not by executing. If a criterion is only confirmable by execution, say so in your verdict. ` +
    `Pass ONLY if it satisfies its success criteria: ${p.successCriteria}. ⚠️ Hunt specifically for NEW assertions that CANNOT FAIL — the two classes with no mutation ritual attached, which you can assess by reading: (a) any INSTRUMENT the phase documents (a grep in a rule, criterion or comment) — read the command and ask whether it could produce output at all, since a malformed one returns empty and reads as conformant; (b) any MULTI-LIMB /live scenario — it reddens on its FIRST failing limb, which hides every later limb, so ask per limb whether that limb could fail on its own and whether it calls something actually reachable. Also flag any .claude/rules/ violations ` +
    `and any divergence from the task file. ⏳ PRE-ALPHA EXCEPTION: do NOT flag the phase for leaving the system non-deployable, for depending on a later pre-alpha task file, or for coverage deliberately deferred to a later file that carries acceptance criteria for it — those conform. Default conforms=false if uncertain.\n\nPhase goal: ${p.goal}\n\n` +
    `TASK FILE (+ linked docs):\n${TASK}`,
    { label: `verify:${p.id}`, phase: 'Verify', schema: VERDICT }).then(v => ({ phase: p.id, verdict: v }))))
return {
  verdicts: verdicts.filter(Boolean),
  failed: verdicts.filter(Boolean).filter(r => !r.verdict.conforms).map(r => r.phase),
}
```

### 4. Report & hand off
Summarize: which phases conformed, which failed verification (with their issues), and what needs human attention. Fix blockers, then leave everything in the working tree for review; **don't commit** unless the user asks.

## Phase Retro

At least once per task file (at completion if nowhere else), and after any phase that was large or hit lots of problems, briefly answer:
1. **What did we learn?** (surprising discoveries, undocumented behavior, patterns worth capturing)
2. **What did we struggle with?** (implementation friction, confusing APIs, wrong assumptions)
3. **Did any tests fail unexpectedly?** (root cause, not just the fix)
4. **Impact on follow-on work?** (does this change later phases, create new backlog items, or simplify/complicate the plan?)
5. **Process changes?** (rules, conventions, or skill updates that would have prevented this work's friction or caught it earlier — propose **concrete edits** to `CLAUDE.md`, `.claude/rules/`, skill files, or `tasks/README.md`. If nothing comes to mind, say so explicitly — don't pad.)

Question 5 is about how we work, not what we work on next. Resist the urge to roll process insights into question 4 — they belong here, where the prompt forces a concrete edit proposal.

Capture anything reusable (patterns, conventions, gotchas) in the appropriate place: `.claude/rules/`, `CLAUDE.md`, skill files, or `backlog.md`. Don't let hard-won knowledge stay only in the conversation transcript.

## When NOT to use
- Design isn't pinned yet — run `/review-task` first; `/build-task` assumes a reviewed task file.
- Trivial single-file changes — just make the edit (and skip the verifier fan-out).

## Calibration
Tracked in `tasks/backlog.md` § Testing & Quality (the design record `tasks/archive/task-review-panel.md` is frozen — don't write there). Tune verifier strictness against real builds.

**Data point — two panels in one day (profile-gate + actingToken, 3 phases each, 2026-08-20), and together they locate the panel's residual value precisely: TEXT OUTSIDE THE DIFF.** Both builds ran the full in-skill discipline — every operand mutation-isolated (10 in-lane cycles + a live per-limb red between them), every instrument executed against a known hit — and every finding that survived was prose the diff never touched. The profile-gate panel found a **half-repointed JSDoc block** (line 7 of a header still citing a dead path while line 11 of the same block had been fixed — a diff-scoped sweep sees only the edited line). The actingToken panel found **ADR-016 itself still declaring "Resources is not conformant yet" and quoting the deleted coalesce compare verbatim** — the highest-traffic wrong copy available, since ADRs load in full at every `/review-task`, and the exact verbatim-quotation rot `workflow.md` § *Referring to things across files* names. ⇒ The falsified-text grep now in § 2 (pending-status language in any ADR/rule the work completes) is this data point's rule; the panels also priced the repair: every finding, majors included, was fixed pre-commit within the hour, so catching this class late is cheap — *shipping* it is what compounds.

**Data point — registry route-guards (3 phases, 2026-08-18), confirming the 2026-08-16/17 entry and adding one shape.** The builder mutation-checked every recognized test per limb (≈15 mutation cycles, two of them against live `/live` runs) and the panel still found four real things: a **missing criterion limb** — the criterion's trailing *"⚠️ Also assert…"* clause (a platform subject un-impersonable at the endpoint) was never written, because a multi-limb criterion stated as one sentence lets the tail drop silently while the headline limb passes; a **sweep limb incapable of failing** (a `not.toBe(turnstile_required)` on bodyless GET rows, where the mutated path can only ever produce a different error — `testing.md`'s vacuous-negative class, found by reading); and two **stale-symbol citations** in prose that the diff-scoped phase-end sweep structurally cannot see (a deleted function cited in a JSDoc security argument, and a README sentence contradicting two sibling lines edited in the same file). ⇒ When transcribing criteria into phase work, split each *"Also assert"* tail into its own checklist line — the tail is where this build's only conformance failure lived.

**Data point — passage/dominion spine (4 phases, 2026-08-16/17 retro), and it argues the panel is worth MORE than the 2026-06-15 entry suggests.** Implementation was again near-transcription: the task file's per-site conversion tables held, and the single deliberate verdict change had been pinned in advance. The panel's value was **not** rubber-stamping and **not** correctness of the shipped behaviour — every phase's code was right. It was **coverage**: four verifiers found **three assertions that could not fail**, all authored in the same build by a builder who had mutation-checked everything he recognised as a test — a documented conformance grep that returned empty on any tree, the mint's one verdict case with no other backstop, and both verdicts having no direct unit test at all. It also found **three false supporting premises under correct conclusions** (`calibration.md` §7), the sharpest being a security rationale that was checkable and wrong.

⇒ **Two tuning lessons.** (1) The bar that pays is *"what did this phase add that cannot fail?"*, not *"is the code right?"* — hence the explicit hunt now in the verifier prompt. (2) The classes that escape a builder's own mutation discipline are the ones with **no ritual attached**: an instrument is not obviously a test, and a multi-limb `/live` scenario reddens as a whole while any single limb rots. Both now have rules (`testing.md`, `live.md`) *and* a prompt clause, deliberately — the rules are path-scoped and a verifier may not load them.

**Data point — §5.3.7 Nebula-frontend (v1–v5, the largest single-batch build, 2026-06-15 retro).** The build validated the skill's core premise: after deep review, implementation was near-transcription — **~0.46 mid-build design decisions per phase, zero behavior churn, one structural reversal** (a separate-package → subpath repackaging caught during scaffolding). The verifier fan-out earned its keep beyond rubber-stamping at least once: a P9 verify panel surfaced an unguarded HTTP-403 operand that became a permanent rule (`testing.md` "mutation-check each operand of a compound condition"). Friction was NOT in task-writing — it was empirical test-infra discovery in the thin-spec **v4** phase (WS-disconnect tooling took 3 tries). See the exploratory-phase handling below.
