---
name: nightly-pass
description: Manually-invoked bedtime self-improvement pass (v0, thin). Picks ONE easy-to-review candidate from tasks/nightly/backlog.md, does a small findings-only review, and writes a triage-optimized morning digest to tasks/nightly/<date>.md. Invoke EXPLICITLY at bedtime via /nightly-pass — never auto-trigger.
---

# Nightly Pass (v0 — thin driver)

The bedtime ritual: like turning off the lights and checking the locks. Invoked **manually** in an interactive session (so it runs on the interactive budget, not the headless Agent SDK credit). It does **one small, findings-only review** and leaves a short digest to read over coffee. Full design + rationale: [tasks/nebula-nightly-loop.md](../../../tasks/nebula-nightly-loop.md).

**v0 is deliberately minimal** — one candidate, one focused pass, one short digest. The select→validate→work→chain machinery, APPLY mode, and the cron path all come later. Expect little usefulness until the kinks shake out; the point now is to close the loop and learn.

## The governing rule: optimize for LARRY'S MORNING ATTENTION, not tokens

The scarce resource is the few minutes Larry has at 8am before real work. **Every step biases toward output he can accept/reject in a glance.** A small, decidable result beats a thorough sprawling one. If the digest is long, the candidate was too big — that's the signal to pick smaller next time.

## Usage
`/nightly-pass` — no args. Run it at bedtime. (Don't start after ~3am if you want a fully fresh interactive window at 8am — see the spec.)

## Procedure

### 1. Pre-flight (record, never mutate)
- `git rev-parse HEAD` and `git status --porcelain`. A dirty tree is fine — v0 is **findings-only** regardless (no branch ops, no repo writes except the digest + ledger under `tasks/nightly/`).
- Known-RED allowlist — do **not** cry wolf on these pre-existing failures: `drop-on-failed-broadcast subscriber cleanup` (`nebula-client-disconnect-cleanup.test.ts`, `task_3e018327`). v0 does **not** run the full suite (keeps it cheap); only run a test if a specific candidate needs it.
- Confirm `tasks/nightly/backlog.md` exists. If not, stop and say so.

### 2. Select — REVIEW-COST first (this is the whole game)
Read `tasks/nightly/backlog.md` (Review-eligible table only — never the Parked table) and skim recent `tasks/nightly/*.md` digests + `tasks/nightly/ledger.md` to skip anything reviewed in the last ~3 nights.

Score each eligible candidate by **predicted review-cost to Larry (PRIMARY, lower = better)**: will the *result* be something he can decide on in ≤2 minutes?
- **Favor**: one file / one invariant / one spec-vs-test check / a decidable yes-no / a small self-contained diff.
- **Penalize hard**: sprawling multi-file audits, "review the whole Phase-A spec," anything that yields a long list.

Tiebreak by **leverage** (HIGH > MEDIUM > LOW), then **timeliness** (active critical path beats on-hold). Pick **one** candidate. If even the best is big, narrow it to a single sub-aspect rather than picking a sprawling pass. Record the top ~3 considered and why the winner won (goes in the digest).

### 3. Validate (cheap, ≤2 min)
Confirm the candidate's cited files/specs actually exist and still say what the backlog claims (citations are Sonnet-mined and may be stale). If the target is gone / moved / already-resolved → mark **validated-empty**, note it, and either pick the next candidate or stop for the night. Don't sink the pass into a dud.

### 4. Work (small, findings-only)
Do **one focused review** of the selected target against its referenced spec/rule — inline, or with at most 1–2 `Task` agents. **Not** a mega-round. Aim for a **decidable verdict + the smallest actionable unit**:
- either **✅ clean — no action**, or
- **⚠️ a few specific findings**, each with its one-line fix or the capable-of-failing test it implies.
If a fix is small and safe, you MAY include it as a **diff in the digest as TEXT** (v0 applies nothing — no worktree writes). Keep it short; brevity is the feature.

### 5. Write the digest → `tasks/nightly/<YYYY-MM-DD>.md`
Write-once (if today's file exists, append a `## Run N` section). Format for a 2-minute triage:

```
# Nightly digest — <date>

**Verdict:** <one sentence, lead with ✅ or ⚠️>
**Reviewed:** <candidate> — <source link> (mode: findings-only)

## Findings
- <problem> → <the one-line action> (or "none — target is clean")

## Your move
<explicit: "nothing" | "apply this small diff" | "decide X">

## Considered, not picked
- <runner-up> — <why not> (promote in backlog if you disagree)

---
Time: <wall-clock>. Baseline known-RED: disconnect-cleanup (allowlisted). Backlog item to mark done: #<n>.
```

Keep the whole thing short. A long digest means the candidate was mis-sized.

### 6. Ledger
Append one line to `tasks/nightly/ledger.md` (create if missing): `- <date> · backlog #<n> <title> · <✅clean | ⚠️N findings | validated-empty>`. This is the v0 cooldown record so the same target isn't re-picked next night.

## Out of scope for v0 (do NOT do)
- No APPLY mode / worktree / branch / commit. Findings-only.
- No deploys, no `experiments/` runs, no benchmarks, no full test suite.
- Never touch a Parked backlog item. Never edit source under `packages/`, `apps/`, or `website/` — only `tasks/nightly/`.
