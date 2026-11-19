---
name: build-task
description: The "go" procedure — implement a reviewed task file phase-by-phase, then fan out adversarial verifiers that check each phase against its own success criteria + .claude/rules/ (which /code-review can't do because it doesn't know the task file). Use when the user says "go"/"implement"/"build" on a task file that has already been through /review-task (or equivalent design review).
---

# Build Task

The procedure at "go". By the time a task file has been through review, implementing it is mostly transcription, so this skill spends its effort on checking: each phase is checked by its builder before its commit, and a panel of verifiers reads every phase against the task file's success criteria once the last one is in.

Phases are built one at a time in the current branch, never in parallel or in worktrees (`workflow.md` § *Sequential implementation*).

> ⏳ **TEMPORARY — remove when pre-alpha ships.** Until pre-alpha ships there is **one wipe+redeploy gate at the very end**, not a per-task one (see the `task-files-neednt-be-deployable` memory). So do **not** fail a phase or task for leaving the system non-deployable, or for depending on a later pre-alpha task file. We still test our work — but **testing may be staged across files**: a file may land most of its coverage and defer the rest to a later (still pre-alpha) file, **provided that later file carries explicit acceptance criteria for the deferred coverage** (an `it.skip` + pointer, or a named criterion there). When pre-alpha ships, delete this block and restore full per-task deployable-and-tested expectations.

## Usage
`/build-task <path-to-task-file>` (defaults to the active task file).

## Procedure

### 1. Read the task file
Read the task file, its linked sub-tasks, the docs it references and the relevant `.claude/rules/`. Enumerate the phases as `{ id, goal, successCriteria }` from the task file's own phase structure. Where a criterion ends in an "Also assert…" clause, give that clause a checklist line of its own: a tail stated in the same sentence as its headline is dropped without anyone noticing (2026-08-18).

**Exploratory phases.** Most phases transcribe a pinned design. A few are empirical: a real-infrastructure harness, browser or WebSocket tooling, a simulated network failure, where the mechanism is learned only by running it. The task file tags such a phase exploratory (`tasks/README.md` § *Multi-version (vN) phases*). Its deliverable is capable-of-failing tests for the behaviour found, and a findings note recording the mechanism that worked and the alternatives that failed, kept in a reference memory or the right rule. A phase with only "works"-grade bullets that is neither pinned nor tagged is a gap in the spec: flag it before building. If it is built anyway, treat it as exploratory, since a verifier holding it to criteria it lacks can only approve it.

### 2. Implement, one phase at a time
Follow `.claude/rules/`; the path-scoped ones load as you touch files. While a phase is in progress, run the narrowest type-check and tests for the files you touched. When reality diverges from the plan, update the task file.

**A phase ends with the steps below, in this order.** The first three can change source, and the sweep has to run on the tree the phase commits.

#### 2a. Mutation-check every new test

🛑 **A phase is not done until every new test has been mutation-checked.** The phase's report is blocked on it. `testing.md` § *Tests must be capable of failing* has the mechanics; use `scripts/mutate.mjs`, run from the package under test.

- **Mutate each new assertion's target and confirm that test reds.** A mutation that reds everything only broke construction, so narrow it until exactly the intended test fails. Mutate each operand of a compound condition on its own.
- **Read a batch of new tests passing on first write as a warning.** On 2026-07-30 a phase passed 8 of 8 on first write and three of the eight asserted nothing.
- **Grep every non-standard symbol a new test touches** (`git grep -c '\bsymbolName\b'`). A test behind `as any` can call a method that does not exist: an optional call on `undefined` does nothing, and the type-checker cannot see it.
- **When a mutation does not red, ask first whether the code should exist.** The causes are a fixture in the safe shape, an assertion that checks nothing, or code nothing depends on, and for code you just wrote the last is the likely one. Delete such a line; a test written to cover it would keep it. In the personas build (2026-11-14) this removed code in five of its eight phases.
- **When the fixture is the cause, build the dangerous shape the design names** before concluding "this cannot be tested here": one subject at two scopes where the fixture had two subjects, say.

Mutation shows an assertion can fail, not that what it asserts against resembles production. A `/live` scenario shows that (`live.md`), and both are required.

#### 2b. Walk your own diff

The panel in step 3 checks a phase against its success criteria, and a confidently worded false claim satisfies those. These reads are the builder's, and each is scoped to the diff.

- **Every line asserting something about existing code**, in a JSDoc, a comment, the task file or standing guidance: cite the check you ran, or run it now. Measured 2026-07-30: every claim checked with a targeted tool call was right, and every claim inferred from nearby context was wrong. "I already read that file" is not the check; ask what the read implies for this claim. The task file is not evidence for itself either: a line it determines is verified, not inherited, and its `✅ Checkable` marks a claim shaped to be checked, not one somebody ran. Standing guidance is where this matters most, since no test reds a wrong rule and every later session loads it.
- **A runtime fact you record**, in a memory, a rule or a test's header, owes the probe that rules out its nearest rival explanation. Name the rival and make the one change that tells them apart. Bit 2026-10-09: a registry read `undefined` in a test, and the build recorded that the test held a separate copy of the module, when the Worker's entry had not run yet.
- **A task-file handle in source.** `D12`, `Q3` or `Phase 3` in a changed source file becomes an ADR, a rule or a clause of prose now; `workflow.md` § *Referring to things across files* has the grep.
- **What the phase displaced.** When it adopts a package, a mechanism, a schema shape or a predicate, list what that touches and ask of each what it is still for. A green test answers only whether it still works (`calibration.md` §2).
- **The deleted lines, as closely as the added ones.** A deletion the task file did not ask for is a finding, and a patch carried over from another branch or a reverted build is where one hides. Bit 2026-11-14: such a patch deleted Studio's Wipe button.
- **What the phase replaced and never touched.** A superseded route, read or helper sits beside its successor, green and referenced by nothing new, until the next task trips on it. For each one still there: delete it now if the task file names its retirement, and otherwise propose the removal to the human. When a task file's design visibly supersedes shipped code, write it a "nothing replaced survives in parallel" criterion that names the known retirements as a floor, not a cap.
- **What a retirement left one level down.** A function the retired caller reached keeps the parameters only that caller supplied. Grep the bare function name across `src/` and read every hit, since a default value or a `?` hides the answer. Ask whether any live caller supplies each parameter, and drop a dead one at every level it is threaded through. When you keep something a retirement touched, open the caller you cite and confirm it reaches this code, or write that the thing is unexplained. Bit 2026-09-02: a comment invented a caller, and read as a decision until someone traced it.
- **A retired name in every lane that carries the same prose.** A grep for it MUST cover `test/`, `harness/` and `website/docs` as well as `src/`: nothing compiles a comment, and the copy that survives is the one no grep was pointed at (2026-09-08, and `auth-flows.md` on 2026-11-14).
- **Text the phase made false without touching it.** When the phase completes something an ADR or a rule tracks as pending, grep that document for its own status language (`not conformant|not yet|interim|Today's code differs`) and put it in the present tense. When the phase moves what a rule describes to another file, read that rule's `paths:` frontmatter too: a glob still naming the old home loads the rule where it no longer applies (2026-09-05).
- **A signal the phase turned into a gate.** List what the gate reads, and run what the docs and the platform guidance teach users to write through it before the phase closes. A false positive cost nothing while the signal only advised (2026-10-15: a type check that began holding builds back refused three things the docs teach).
- **Any command the phase wrote into a rule, a criterion, a task file or a comment.** Run it, and make it print something before trusting an empty result (`testing.md` § *Tests must be capable of failing*, the paragraph on instruments).

#### 2c. Run the whole suite of each package the phase touched
The narrow runs above are for iterating. Bit 2026-11-14: a phase was committed with three surface inventories red, because only the touched files had been run.

#### 2d. Sweep the `/live` registry
**Sweep when the phase changed what a sweep's passes are evidence about**: the code the stack runs (`apps/nebula/src`, `apps/nebula/container`, any `packages/*/src`, Studio's source) or the harness's own code (`harness/lib`, `apps/nebula/test/lib`, `apps/nebula/scripts`). `drive.ts` and `harness/lib/sweep-record.ts` hold the lists. A phase of prose, or of vitest tests outside `test/lib`, needs no sweep, and a phase that only adds a scenario runs that scenario. `live.md` requires one after changing anything a scenario you did not write depends on, and a phase cannot tell which scenarios those are. Bit 2026-11-14: two phases each broke a scenario the build had not written, and both waited for the last phase's sweep.

- **Run the whole registry**, `npx tsx apps/nebula/harness/drive.ts all`, and not `--fast`: the container scenarios are where a Studio change shows. It took 43 minutes locally on 2026-11-15.
- **Check first for a stack someone is driving by hand** (`pgrep -fl 'wrangler dev'`). A sweep kills this checkout's workerd, so ask before taking a hand-driven stack down.
- **Run it in the background, and edit no source until it ends.** An edit under it taints every scenario after, and the sweep then exits non-zero. The two steps after this one touch no source, so do them while it runs.
- **After a failure and its fix, run `drive.ts all --rerun`**, which counts as a sweep. The fix is an edit like any other: mutation-check what it added and run its package's suite first. A scenario that fails and then passes with nothing changed is a flake: name it as one in the build notes and in the closing report, and never let the rerun stand as a pass that cancels it.

#### 2e. Write the phase's build notes
Into the task file's § *Build notes*, created after the phases on first use:

- **For the human:** every question or decision that arose and needs them, with its source quoted, and anything the phase changed that the task file had decided.
- **Retro notes:** what the phase taught, what was hard, what failed unexpectedly and why.
- **Close-out notes:** what the phase closed or made obsolete, such as a backlog row, a sibling task file's line or a sentence of standing guidance.
- **The mutations run**, one line each, since the panel reads them and runs none.

A long unattended run spans several compactions, and a compaction keeps only a summary. The hand-off works from these notes, so nothing deferred may live only in the transcript.

#### 2f. Run the prose gate
`node scripts/check-prose.mjs <files>` on each `docs/adr/`, `docs/vision/`, `tasks/`, `.claude/rules/`, `.claude/skills/` or `CLAUDE.md` file the phase touched, the task file with its new notes included (`prose-voice.md`). Bring what you wrote within budget and leave the file no further over than you found it. The notes are prose about existing code as well, so the first read of 2b applies to them.

#### 2g. Commit, and say where the phase ended
Once the sweep has passed, where the phase owed one, commit the phase with its notes by explicit path (`git commit -m … -- <paths>`, never `-A`). Pushing stays gated.

**Phase gating.** Ask "Ready to proceed with [next phase]?" after each phase, unless the user authorized running unattended through several, which they do about half the time. Honour that for the phases it covers, and still post a brief status between phases. The authorization does not carry over to the next task.

### 3. Verify, once the last phase is in

Do these in order. The panel reads code and runs no suite, so everything that has to execute happens around it.

- **Run each affected package's full suite once, inline.** A green suite is a success criterion for most phases, and verifiers cannot catch a runtime regression. Never run suites inside the fan-out: concurrent vitest runs in one working tree thrash.
- **Re-run every completeness instrument a phase wrote, against the final tree.** Where a phase edited a list whose value is that it is exhaustive, such as a reader list or a call-site table, a later phase can add a member and falsify it (2026-07-28). Grep the task file for a phase that edits such a list in a rule, an ADR or a README, and run its stated command last. Run it as `grep -r` before the commit, since `git grep` cannot see a file the build created.
- **Make each instrument print before trusting an empty result.** A malformed command returns nothing and reads as a conformant tree (2026-08-16). A task file's evidence table gives a known hit for every row: run each row against the commit before the task (`git grep <pattern> <base>`) and confirm it prints the table's *Today* value. A sentence that names examples of an instrument's output is part of the instrument, so check each example against a fresh run.
- **For a phase that touches the UI, drive the running app** (`/live`) and keep the evidence. A green suite and a code-reading verifier cannot see a capability present in code and never wired into the page.
- **Fan out the panel**, below, and fix what it finds.
- **Hold the closing suites, the closing sweep and the deployed pass for step 4**, after the decisions the hand-off tees up. An answer that changes source makes every result before it stale. Bit 2026-11-19: four answers taken after the closing sweep each changed source, and each took a sweep of its own, about an hour apiece.

**The panel is one adversarial verifier per phase, reading the current working tree.** It checks whether the code satisfies this task file's success criteria, which `/code-review` cannot, since it does not know the task. Pass the task file's path as `taskPath` and not its text: each verifier reads it from disk, and a pasted copy is paid for once per phase. Put the linked sub-tasks and docs a verifier needs in `alsoRead`, as paths with what to check at each. For an exploratory phase (step 1) set `exploratory: true` and name its findings note's path in `alsoRead`; the verifier then checks that the tests and the note landed.

```javascript
export const meta = {
  name: 'build-task-verify',
  description: 'Verify each implemented phase against its task-file success criteria + rules',
  phases: [{ title: 'Verify' }],
}
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {})   // args may arrive JSON-encoded
const TASK_PATH = A.taskPath   // the task file, read from disk by each verifier
if (typeof TASK_PATH !== 'string' || !TASK_PATH) throw new Error('build-task-verify: pass { taskPath, phases, alsoRead? }; the task file is read from disk, never pasted')
const ALSO_READ = A.alsoRead ?? ''  // optional: other paths, and what to check at each
const PHASES = A.phases        // [{ id, goal, successCriteria, exploratory? }]
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
    `Read the task file at ${TASK_PATH} from disk first: its design intent, its decisions, this phase, and this phase's entry under "Build notes", which records the mutations the builder ran. ${ALSO_READ} ` +
    `READ ONLY: do NOT run tests and do NOT edit/mutate any source. The fan-out shares ONE working tree, so ` +
    `concurrent test runs and source edits thrash each other and can leave the file under test transiently ` +
    `broken for sibling verifiers. The parent already ran the suites green before this fan-out; assess ` +
    `capable-of-failing and correctness by READING the code (and the recorded mutation results in ` +
    `the task file), not by executing. If a criterion is only confirmable by execution, say so in your verdict. ` +
    `⚠️ For code that runs work concurrently, such as queues, a catch-up racing an event, or retries, model one interleaving the tests do not arrange: copy the commit outside the tree with "git archive <sha>", write a script there that feeds that order by hand, and run it with node. That runs no suite and edits nothing in the tree, so it stays within READ ONLY. ` +
    (p.exploratory
      ? `This phase is EXPLORATORY: it was not a transcription of a pinned design. Pass ONLY if it landed capable-of-failing tests for the behaviour it found, and a findings note recording the mechanism that worked and the alternatives that failed; the note's path is named above, and a note you cannot open is a finding. Hold it to these criteria too, where it has any: ${p.successCriteria ?? 'none'}. `
      : `Pass ONLY if it satisfies its success criteria: ${p.successCriteria}. `) +
    `⚠️ Hunt specifically for NEW assertions that CANNOT FAIL — the two classes with no mutation ritual attached, which you can assess by reading: (a) any INSTRUMENT the phase documents (a grep in a rule, criterion or comment) — read the command and ask whether it could produce output at all, since a malformed one returns empty and reads as conformant; (b) any MULTI-LIMB /live scenario — it reddens on its FIRST failing limb, which hides every later limb, so ask per limb whether that limb could fail on its own and whether it calls something actually reachable. Read every limb that uses an ENVIRONMENT capability (the stack's stdio, Docker, a mailbox) against the other venue too: every scenario runs unchanged locally and deployed. ⚠️ Hunt STATE WITH A LIFETIME too: for every record that expires, is evicted, or is recreated by a late event (a grace period, a cache, an in-memory map, a socket attachment, a note one party keeps about another), ask what the invariant does at each of those moments. ⚠️ Hunt TEXT OUTSIDE THE DIFF that the phase made false: a JSDoc, rule, ADR or doc page that still describes what the phase retired. Also flag any .claude/rules/ violations ` +
    `and any divergence from the task file. ⏳ PRE-ALPHA EXCEPTION: do NOT flag the phase for leaving the system non-deployable, for depending on a later pre-alpha task file, or for coverage deliberately deferred to a later file that carries acceptance criteria for it — those conform. Default conforms=false if uncertain.\n\nPhase goal: ${p.goal}`,
    { label: `verify:${p.id}`, phase: 'Verify', schema: VERDICT }).then(v => ({ phase: p.id, verdict: v }))))
return {
  verdicts: verdicts.filter(Boolean),
  failed: verdicts.filter(Boolean).filter(r => !r.verdict.conforms).map(r => r.phase),
}
```

### 4. Hand off: report, retro, decisions
1. **Report** which phases conformed and which failed verification, with their issues, and fix the blockers.
2. **Post-process § *Build notes*:** merge duplicates, drop what a later phase settled, and order what remains by dependency, then risk.
3. **Tee up every open decision** per `workflow.md` § *Teeing up decisions for Larry*, one per turn, and apply each answer as it lands.
4. **Run the closing suites and the closing sweep after the last edit**, every fix the panel prompted and every answer from item 3 included. A result is true only of the tree that produced it. Report the number that run printed, and check the totals moved by the number of tests you added (`testing.md`, the paragraph on a suite baseline). Bit 2026-08-28: a criterion carried a count from before the panel's fixes added nine tests. Do not edit source or kill workerd under a running suite; its output then belongs to no tree.
5. **End with a deployed pass of the build's own scenarios when its change can only show deployed** (`live.md` § *Two venues, one registry*): `apps/nebula/scripts/deploy-test.sh`, the scenarios the build wrote or touched, then the target's Workers Issues since the pass began.
6. **Close out** (step 5) once those pass. The retro comes last, inside it.

### 5. Close out
From the close-out notes, then by checking:

- **Fix what the build's own verification found when it is small, whatever its age.** A bug older than the task is still this build's finding, and deferring it past the archive leaves it only in the transcript. (2026-10-07: a stale-KV refusal the deployed pass exposed was first offered as a follow-up "after close-out"; Larry asked why not as part of it, and there was no reason.)
- **Delete every backlog row the work closed or made obsolete**, as `tasks/README.md` § *Backlog* requires, and update any row whose status it changed.
- **Update every active file that names the task**, the master plan and sibling task files included: the pointer, and the status beside it.
- **Tell any session waiting on the work.**
- **Answer § *Phase Retro*, then walk Larry through it, before the archive move.** Fold in what the hand-off and the close-out found, since the move freezes the file. (2026-10-07: a retro written during the last phase missed the close-out's most user-facing finding, and the file was archived before anyone read it.)
- **Archive the task file** per `tasks/README.md` § *Archive is frozen*: the move, its own relative links, a dated block for anything now known false, and the inbound references.
- **Commit by explicit path.**

## Phase Retro

At the close-out (step 5), just before the archive move, from the per-phase retro notes in § *Build notes* and what the hand-off and close-out found, briefly answer:
1. **What did we learn?** (surprising discoveries, undocumented behavior, patterns worth capturing)
2. **What did we struggle with?** (implementation friction, confusing APIs, wrong assumptions)
3. **Did any tests fail unexpectedly?** (root cause, not just the fix)
4. **Impact on follow-on work?** (does this change later phases or later task files, create new backlog items, or simplify/complicate the plan? Rows the work closed are step 5's.)
5. **Process changes?** (rules, conventions, or skill updates that would have prevented this work's friction or caught it earlier — propose **concrete edits** to `CLAUDE.md`, `.claude/rules/`, skill files, or `tasks/README.md`. If nothing comes to mind, say so explicitly — don't pad.)

Question 5 is about how we work, not what we work on next. Resist the urge to roll process insights into question 4 — they belong here, where the prompt forces a concrete edit proposal.

Capture anything reusable (patterns, conventions, gotchas) in the appropriate place: `.claude/rules/`, `CLAUDE.md`, skill files, or `backlog.md`. Don't let hard-won knowledge stay only in the conversation transcript.

## When NOT to use
- Design isn't pinned yet — run `/review-task` first; `/build-task` assumes a reviewed task file.
- Trivial single-file changes — just make the edit (and skip the verifier fan-out).

## Calibration
The record of what each real build taught about this skill is [history.md](history.md), beside this file. It is not loaded when the skill runs. Read it when tuning the skill, and add a data point there after a build whose panel or retro says something about the skill itself. Tune the panel's strictness against real builds: `tasks/backlog.md` § *Testing & Quality* tracks the open calibration item, and the design record `tasks/archive/task-review-panel.md` is frozen. Each instruction above keeps the date of the failure behind it and at most a sentence about it.
