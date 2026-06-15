---
name: build-task
description: The "go" procedure — implement a reviewed task file phase-by-phase, then fan out adversarial verifiers that check each phase against its own success criteria + .claude/rules/ (which /code-review can't do because it doesn't know the task file). Use when the user says "go"/"implement"/"build" on a task file that has already been through /review-task (or equivalent design review).
---

# Build Task

The fan-out at "go". Its reliable win is **verification**, not parallelizing the build — by the time a task file has been through deep review, implementation is usually minutes of transcription. So: implement phase-by-phase (sequentially, in the current branch, following the rules), then fan out verifiers that confirm each phase actually meets the task file's success criteria.

**No parallel implementation, no worktrees.** An earlier draft offered worktree-isolated parallel implementation for "independent" phases. Deliberately removed: in this repo's solo, long-running-branch workflow, merge/conflict cost exceeds any transcription speedup. Don't reintroduce it. (Worktree isolation remains fine for self-contained *experiments* whose results are captured in documents and won't have conflicts if merged — see `workflow.md` § Experiments.)

## Usage
`/build-task <path-to-task-file>` (defaults to the active task file).

## Procedure

### 1. Read the task file
Read the task file + linked sub-tasks + referenced docs + the relevant `.claude/rules/`. Enumerate the phases as `{ id, goal, successCriteria }` from the task file's own phase structure.

**Exploratory phases.** Most phases are transcription of a pinned design — they carry decisions + concrete, testable success criteria, and the verifier checks conformance to them. But some phases are inherently *empirical*: real-infra harnesses, browser/WS tooling, network-failure simulation — work whose mechanism you can only learn by running it (the §5.3.7-v4 WS-disconnect tooling took three tries: `ws.close()` hangs through the http-proxy → CDP offline hangs the whole vitest-browser run → synthetic `CloseEvent` works; none of that was pin-able in advance). Such a phase should be **explicitly tagged exploratory** in the task file (per `tasks/README.md`). When a phase has only `"works"`-grade bullets and no pinned decisions, do NOT silently hold it to transcription-grade conformance — that degrades its verifier to a rubber stamp. Instead treat it as exploratory: its deliverable is **(a)** capable-of-failing tests for the discovered behavior and **(b)** a captured findings note recording the mechanism that worked *and the alternatives that failed* (harvest it into a reference memory or the right rule — v4's findings became the `vitest-browser-ws-disconnect` memory). If a phase is thin and is *neither* tagged exploratory nor pinned, that's a spec gap — flag it before building, don't paper over it.

### 2. Implement
Phase by phase, sequentially, in the current branch, following `.claude/rules/` (path-scoped rules auto-load as you touch files). After each phase, run the narrowest type-check / tests for the files you touched. Update the task file as you go when reality diverges from the plan. Don't commit.

**Phase gating**: default to asking "Ready to proceed with [next phase]?" after each phase — but roughly half the time the user authorizes running unattended through multiple phases up front (more likely for experiments, isolated changes, or when they're away from the desk but reachable). Honor that for the phases it covers; between phases, still post a brief status so the transcript shows where each phase ended. The authorization doesn't carry over to the next task.

### 3. Verify (the always-worth-it fan-out)
First run the affected packages' full test suites once, inline — verifiers *read* code, they don't run it, so runtime regressions must be caught here (and a green suite is itself a success criterion for most phases). Don't push test runs into the parallel verifiers: concurrent vitest runs in one working tree thrash.

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
    `Pass ONLY if it satisfies its success criteria: ${p.successCriteria}. Also flag any .claude/rules/ violations ` +
    `and any divergence from the task file. Default conforms=false if uncertain.\n\nPhase goal: ${p.goal}\n\n` +
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

**Data point — §5.3.7 Nebula-frontend (v1–v5, the largest single-batch build, 2026-06-15 retro).** The build validated the skill's core premise: after deep review, implementation was near-transcription — **~0.46 mid-build design decisions per phase, zero behavior churn, one structural reversal** (a separate-package → subpath repackaging caught during scaffolding). The verifier fan-out earned its keep beyond rubber-stamping at least once: a P9 verify panel surfaced an unguarded HTTP-403 operand that became a permanent rule (`testing.md` "mutation-check each operand of a compound condition"). Friction was NOT in task-writing — it was empirical test-infra discovery in the thin-spec **v4** phase (WS-disconnect tooling took 3 tries). See the exploratory-phase handling below.
