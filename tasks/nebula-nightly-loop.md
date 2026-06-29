# Nightly self-improvement loop for Lumenize

Status: DESIGN — ready for `/review-task` round 2, then `/build-task`
Owner: Larry (solo; one long-running branch, sequential implementation)
Created: 2026-06-14
Supersedes the original design-under-review (corrected after adversarial verification on-disk).

## Goal

A nightly autonomous "overnight pass" that runs **sense → propose → (human gate) → act**, under the governing principle:

> **AUTOMATE THE LOOP, HUMAN-HOLD THE CRITERIA** (the definition of "better").

The loop hands Larry, at his ~8am start, **one artifact he reads** (a morning digest) plus, on nights that warrant it, a **reviewable proposed diff** he accepts or tosses. It never autonomously changes the long-running branch and never moves a metric it also reports.

## Context (verified on-disk 2026-06-14)

- Solo project, one long-running branch (`feat/nebula-studio`), sequential implementation.
- Existing scaffolding the loop REUSES rather than reinvents: `.claude/rules/`, ADRs, task files, retros, `/review-task` (reviewer panels + adversarial verify + survivors/dropped finding records), `/build-task` (phase verifiers), the file-based memory system, MEMORY.md, and the round-N **findings-JSON chaining** (`priorFindings`).
- A per-phase retro already PROPOSES process changes (human-gated) but never edits its own governing rules.
- **The overnight unit is CODE & DESIGN OPTIMIZATION passes** — the same work as a live `/review-task` or `/code-review` over a spec/doc/source file (e.g. a review of `coding-your-ui.md`). It is **NOT** evals/bake-offs/experiments (those run later on a separate metered API like Kimi/Think). So the pass is **Claude-authored on Larry's subscription — ONE token meter, shared with daytime work.**

### Verified environment facts the design must honor
- **No native window-reset source.** Nothing under `~/.claude` persists window/limit/reset state (no usage/limit/window/ratelimit/quota file). `stats-cache.json` is stale (Feb 23, day-aggregated, `costUSD:0`). There is no `claude usage` subcommand. `settings.json` has **no `hooks` block** today.
- `~/.claude/sessions/<pid>.json` has `startedAt` in **epoch-ms** (UTC-safe) and `kind:"interactive"` — but this is **process start, not the token-window first-message anchor**.
- Timezone is **America/New_York** (DST transitions twice/year).
- The working tree is **routinely dirty** (verified: 6 modified + 2 untracked right now; MEMORY notes rounds "NOT committed yet").
- The baseline is **already RED** on this branch (`drop-on-failed-broadcast subscriber cleanup`, `task_3e018327`, fix DEFERRED).
- Commit cadence is **bursty**: ~7 of the last 14 days had commits, clustered with multi-day gaps.
- MEMORY.md is **over its 24.4KB limit** (28.5KB) and loads only partially.
- `tasks/backlog.md` is dominated by investigate/build/measure items that need deploys or experiments; only a couple of items are review-shaped.

---

## Hard output contract (the safety model)

Because this work touches real files (no `experiments/` sandbox), safety comes from the OUTPUT and from gates, not from the area being "safe":

1. **Never an autonomous commit to the long-running branch** (`feat/nebula-studio` or any). The pass emits FINDINGS + a PROPOSED DIFF on a dedicated worktree branch; Larry wakes to a reviewable diff and accepts/tosses.
2. **The dirty working tree is the real collision surface, not HEAD.** See the pre-flight gate below — a dirty tree forces FINDINGS-ONLY for the whole night.
3. **Two modes**, but mode is GATED, not merely chosen by the agent (see Mode selection):
   - **APPLY** (draft a diff) — only for a stabilized area on a provably clean tree with no live session.
   - **FINDINGS-ONLY** (zero file writes to the repo) — for actively-churning / dirty / live-session / ambiguous cases. This is the **default and the floor**.
4. **Isolation mechanism = a dedicated fixed-path worktree** at `.claude/worktrees/nightly`, cut from a CLEAN base at `HEAD`, reset/deleted each night. Larry applies accepted diffs himself in his primary tree (cherry-pick / `format-patch`); the worktree branch never mechanically merges back. This honors the repo's worktree rule ("never merges back" mechanically) and its no-concurrent-WRITE rationale (the pass is temporally exclusive from daytime work — Larry is asleep).
5. **Criteria-change diffs are quarantined.** Any diff touching `.claude/rules/`, `CLAUDE.md`, `docs/adr/`, `.claude/skills/`, or guardrail-pin sections of MEMORY.md goes on a **separate** worktree branch from code/spec diffs and into its OWN digest section, so a wholesale morning merge of a code branch cannot smuggle in a rule edit. Rule/skill proposals stay as diff TEXT; they are never written into the governing files even on a scratch branch.
6. **No build in the dev loop.** The APPLY-mode health check uses `vitest` + `tsc --noEmit` ONLY — never a package build or `dist` step.

---

## Token-window engine (simplified — fixed 12:30am start)

> **⚠️ Metering update — verified 2026-06-14 (official), effective June 15 2026.** Anthropic split the meters: **interactive** Claude Code (human at the keyboard — desktop/terminal/web/IDE/Cowork, incl. subagents/workflows spawned inside an interactive session) draws on the **subscription usage limits**; **headless `claude -p` / Agent SDK** draws on a **separate new monthly Agent SDK credit** (Pro $20 / Max5× $100 / Max20× $200; no rollover; overage at API rates only if usage-credits enabled, else requests stop). **Consequence — the engine below only governs the MANUAL-INTERACTIVE path:** a **bedtime manual kickoff** from an interactive session runs on the comfortable interactive budget, so timing only needs bedtime < ~3am to keep the 8am window fresh. A **headless cron** run instead lands on the separate Agent-SDK-credit meter — it can NEVER touch the 8am window, but the governor becomes **monthly dollars** (a 31-agent mega-round ≈ $5–15, so size/frequency dominate). **Near-term operating mode = manual bedtime kickoff** (interactive meter); cron/headless deferred pending real post-June-15 numbers.

Claude usage runs on **5-hour rolling windows anchored to the FIRST message**; after 5h the next message opens a fresh full-budget window. Larry wants a **fresh full window at his ~8am start** (M = 8am). A **fixed 12:30am start dissolves the morning-protection problem entirely** — no decision table, no `E_close` sensing, no heartbeat hook:

- A window opened at 12:30 closes at **5:30am**, always before M, so **8am is always fresh** (holds as long as Larry's morning start is after ~5:30am, which 8am comfortably clears).
- The only way to break the guarantee is the pass running past 5:30 and opening a *second* window. A single review pass completes in **minutes of wall-clock** (the design-review that produced this spec: ~9 min / 31 agents), so this is structurally near-impossible; a hard wall-clock kill at **5:15am** is belt-and-suspenders.
- **Jitter is irrelevant** — 12:30 has 2.5h of slack before the old 3am open-by deadline. This is why the earlier ε/DST/`E_close` machinery is deleted: none of it is load-bearing once the start is fixed early. The verified "no native window-reset source" fact (see Context) **no longer blocks anything** — we don't need the reset instant.

### The one residual: budget, not timing
Remaining budget is not readable programmatically (no native source). On a night Larry worked late enough that an evening window is **still open at 12:30**, the pass shares that window's leftover. But a pass costs only **~10–40% of a full window** (measured), so leftover is almost always enough. If it isn't, the pass **hits the rate limit and truncates** — checkpoint-per-phase persistence (see Resilience) writes partial findings and the digest reports "truncated." Self-healing and low-cost, so **no budget prediction is attempted**: the loop just starts at 12:30 and runs.

### Invariants that survive
- **One subscription-metered Claude session per night = the review PASS.** The 12:30 trigger must be **token-free w.r.t. the subscription** (a plain cron/script, or a cloud trigger on a separate meter) so it doesn't anchor a window before the pass opens one.
- **Per-stage model:** trigger + selector scoring + digest assembly → cheap fast model (Sonnet/Haiku class); the PASS → Opus 4.8; meta-retro → Opus 4.8 (rare).
- **Sizing:** the PASS runs on **Opus 4.8**, never Fable+ultracode (the one config that exceeds a window, +~$50); a full mega-round is affordable in one window.
- **Trigger = local cron (DECIDED 2026-06-14).** Larry leaves the machine running overnight. Cloud is deferred — it can't run the test suite yet (someday). The ~8am dead-man's-switch (see Resilience) still catches a night the machine was off.

---

## Pre-flight gate (planner's FIRST step — record, don't mutate)

Run before anything else, in order:
1. **Dirty-tree check.** `git status --porcelain`. **Non-empty ⇒ the night degrades to FINDINGS-ONLY** (zero branch ops, zero repo writes), regardless of per-target churn. **APPLY requires an empty porcelain.** Larry is **not required to clean his tree** — a dirty night still produces a useful findings list, just not a ready-to-merge diff; committing before bed is the habit that *unlocks* APPLY. Because the pass works in a worktree cut from HEAD, **Larry's uncommitted files are never touched in either mode** — this gate exists to avoid reviewing a stale base / proposing a colliding diff, not to protect his files. Never `git stash`/`git checkout .`/pop on Larry's tree.
2. **Session-liveness interlock** (hard, branch-level). Session is LIVE if the most-recent transcript/commit mtime is within N minutes (an mtime check — no hook needed). At 12:30am Larry is normally asleep, so this rarely fires; if liveness **cannot be ruled out ⇒ drop APPLY to FINDINGS-ONLY** (default-safe). Being inside a budget window does NOT by itself license APPLY — **APPLY only when the session is provably idle.**
3. **Baseline capture.** Record `git rev-parse HEAD`, `git status --porcelain`, and a baseline `npm run test:code` result. Maintain a named **KNOWN-RED ALLOWLIST** (today: `drop-on-failed-broadcast subscriber cleanup` in `nebula-client-disconnect-cleanup.test.ts`, `task_3e018327`). **Only NEW failures in the BASELINE** (before the pass touches anything) downgrade the night to digest-only; a diff that introduces a new failure is *surfaced* in the proposal, not aborted.
4. **Memory budget check.** If MEMORY.md is over its limit at run time, skip the MEMORY source (or abort to digest-only) with a logged note, rather than mining a truncated, partially-loaded file. (Pre-flight remedy: run `/consolidate-memory` before the loop ships.)

---

## Three-source candidate selector (runs INSIDE the cheap planner tick, before opening the expensive run)

Mine candidates from:
- **(A) REACT** — recent commits + active task-file Decisions/Open-gates/Deferred + findings JSONs + MEMORY, scanned for markers (`verify/assume/open gate/ship-blocker/revisit/deferred`). Keep the keyword scan; the NO-GO bar and tractability axis handle resolved-context noise (no Probe swap — Probe is the code-semantic tool, not the open-vs-resolved classifier). **Add the Health signal as a first-class source-A input:** a failing/flaky test or coverage below 80%/90% is a candidate (APPLY if stabilized, FINDINGS-ONLY if churning) — this closes the gap where the RED disconnect-cleanup test (untagged, "pre-existing") could never be selected. Optionally feed round-N findings-JSON open-vs-resolved verdicts into the selector so keyword hits inherit a resolution status.
- **(B) ANTICIPATE** — pre-review next-phase specs before building.
- **(C) the review-shaped SUBSET of the backlog** — NOT "the backlog". See eligibility gate; most of `backlog.md` fails it, so source C runs dry fast and the NO-GO bar fires often.

### Hard eligibility predicate (BEFORE scoring)
A candidate must be reducible to **"review file(s) X against rules/spec Y and emit findings+diff"** with **no deploy, no live metric, no `experiments/` run**, AND **must produce a proposal/diff, never a commit**. Tag each source-C backlog item with this predicate at curation time.

### Scoring axes (no finding-yield incentive)
- **review-cost (PRIMARY — added 2026-06-14)** — how cheaply Larry can evaluate the *result* at 8am. His scarce resource is **morning attention, not tokens**: a pass whose output he can't accept/reject in ≤2 min costs him the start of his real workday. LOW review-cost wins — one file / one invariant / a decidable yes-no / a small self-contained diff; penalize sprawling multi-file audits and open-ended "review the whole spec" passes that yield a long list. **This axis dominates; the rest are tiebreakers.** It also shapes the *output* (small, decidable digest) and the pass *size* (one focused review, not a mega-round).
- **leverage** (unblocks how much) — floor: must clear "unblocks a current critical-path item OR fixes a RED signal". *(Now a tiebreaker under review-cost.)*
- **timeliness** (recent/imminent beats stale) **minus a signed recency-of-prior-review PENALTY**: a target panel-reviewed (a `/review-task` / `/code-review` findings JSON) within N days is de-prioritized hard unless it has churned since (read the JSON `date`/`scope`).
- **cost-fit** (fits the night's window).
- **tractable / well-scoped** (clarity of the review; floor: must name the exact file+rule it checks against). *Renamed from "verdict-clarity = will produce actionable findings" to remove the finding-yield incentive.*

### Dedup at the RIGHT granularity (per-finding, not per-target)
- Gate on **MARGINAL YIELD = (new surface since last review) / (findings already on record)**, not raw timeliness.
- Maintain a **per-target review ledger** in `tasks/nightly/` (last `runId`, last scope, resolved+rejected finding ids), reusing `/review-task`'s **survivors/dropped finding records** (rank/title/location/finding) as the identity unit. Feed it to the night's pass as `priorFindings` / do-not-re-report — identical to existing round-N chaining.
- **Cooldown:** a target reviewed in the last K nights with `< X%` new surface is INELIGIBLE regardless of score.
- **Persist the digest's "considered-but-not-run" list** so the same skipped candidate isn't re-pitched nightly.

### NO-GO bar (absolute, not best-of-night)
An **ABSOLUTE** threshold with the per-axis floors above. **No-go IS the expected, successful outcome on most quiet nights** — state this plainly so the bar is never pressured downward. The selector runs in the cheap tick; concluding "skip" is cheap.

### Within-night control loop (fixed 12:30am start, chain until 2:30am)
At 12:30 the loop runs SELECT once, then walks the ranked list, validating each candidate cheaply before committing the expensive pass:

1. **SELECT** (~5 min wall-clock kill, cheap model): rank candidates from all three sources (REACT + ANTICIPATE + backlog — a zero-commit night can still have a newly-stabilized spec, so detection stays full-scope), apply the NO-GO bar → an ordered list, or **"none — reason" → digest-only, done.**
2. **For each candidate, in rank order, while now < 2:30am:**
   a. **VALIDATE** (~15 min kill, a cheap scout — one agent reading the target + its prior-findings ledger): real review surface, in scope, marginal yield above threshold? **No → record "validated-empty" in the ledger** (never re-picked) **and fall through to the next candidate.** The cheap probe that stops the night sinking budget into a dud.
   b. **WORK** (Opus 4.8 review panel): the full pass → findings (+ proposed diff if APPLY-eligible). Record result + survivors/dropped in the ledger.
3. **No-new-start cutoff = 2:30am.** Never *begin* a candidate (validate or work) after 2:30. One already in-flight finishes (~≤1hr → ~3:30am worst case, comfortably inside the 12:30–5:30 window — nothing opens a second window).
4. **How many per night:** unbounded — governed only by list-exhaustion and the 2:30 cutoff. Typically 0–3.

**Why 2:30, not later:** the 12:30 window closes at 5:30am, and *that close* is what protects the 8am window — not the 2:30 cutoff. 2:30 is a deliberately conservative no-new-start so a candidate running 2–3× past the ~1hr estimate still finishes well before 5:30. It's a safety margin against the fuzzy "under an hour or so," not a budget constraint.

**The 8am budget is never touched.** The loop spends inside the 12:30–5:30 *rolling window*; the window Larry opens at 8am is a different, fresh one (the 12:30 window expired at 5:30). As long as the loop stops by 5:30 (guaranteed by the 2:30 cutoff + 5:15 kill), 8am opens at full budget. The only thing that accumulates across nights is total plan consumption if the plan has a weekly cap — a cost concern, not a morning-freshness one.

---

## Mode selection (gated, not freely chosen)

A path is **APPLY-eligible only if ALL hold**: clean-vs-HEAD AND last commit past the stabilization window AND no active-session signal touches it AND the whole tree is clean (pre-flight #1) AND the session is provably idle (pre-flight #2). **ANY of: dirty / recent-commit / live-session / under an in-flight task file's Decisions·Open-gates·Deferred ⇒ FINDINGS-ONLY**, regardless of mtime (this covers `coding-your-ui.md`, which is "done" but feeds the live v3 build). Default to FINDINGS-ONLY on any ambiguity. **Log the verdict and the driving signals in the digest** so Larry can audit and veto a too-eager "stabilized" call.

---

## Resilience (unattended operation)

- **Durable cloud trigger** runs the planner so it survives a closed laptop and has real wall-clock. It operates on **pushed remote state** (consistent with the pushed-diff output contract), not the local dirty tree.
- **Dead-man's-switch (~8am, cloud-side):** asserts a remote heartbeat/artifact dated today exists (a pushed scratch branch or a planner-written heartbeat commit — NOT the local `tasks/nightly/<date>.md`, which is unrunnable when the laptop is closed). If absent, push **"OVERNIGHT PASS DID NOT RUN"** with the last planner timestamp.
- **Heartbeat breadcrumb:** the planner's first act writes a cloud-visible status (`"planner-fired, run scheduled HH:MM"`) so a crash between planner and run is detectable.
- **Checkpoint-per-phase persistence:** after each reviewer batch, append to the findings JSON and write a `"phase N of M complete"` marker on the worktree branch (reuses `/review-task`/`/build-task` batch/phase structure). A mid-pass crash leaves a resumable / at-least-reportable artifact; the digest reports "crashed after phase 2, partial findings attached" instead of silence.

---

## Morning digest (the one artifact Larry reads)

Write-once to a dated `tasks/nightly/<date>.md` (never edit a prior night's digest) + a push notification. Sections:
1. **Health (baseline-delta).** NEW failures vs PRE-EXISTING (allowlisted) failures reported **separately**, allowlist named inline (e.g. "1 pre-existing failure [disconnect-cleanup, task_3e018327, allowlisted]; 0 new"). Plus `tsc --noEmit` and coverage delta vs the 80%/90% targets. **`vitest` + `tsc --noEmit` only — never a build.**
2. **What changed overnight** — invariant: only the worktree branch + this digest, never the long-running branch, never Larry's primary tree, never user auto-memory in place.
3. **Overnight-pass result** — what was reviewed; **survived/raised RATIO + the dropped-as-false-positive list** (from `/review-task`'s schema), NOT a raw findings count (a 12-raised/10-refuted night reads as worse, not better); proposed-diff link or findings-only; what it informs; or "**none — reason**" (an explicit, non-apologetic outcome).
4. **Ranked proposals** (process / refactor / tech-debt / standing-intent) — as PROPOSALS, not applied. **CRITERIA-CHANGE proposals appear in their OWN section** (never bundled with code/spec diffs).
5. **Suggested first task + candidates considered-but-not-run** (persisted to the selector ledger).
6. **Prior-night disposition feedback** — accepted / tossed / ignored for each prior proposed diff (feeds accept-rate to the meta-retro as a proposal-only bar-adjustment input).
7. **Token accounting** — window used, open/close times (epoch + local), spend, confirmation the window reset before the M guard.

---

## Meta-retro (let the agent improve its own standing intent — bounded)

Periodically an agent reviews the retros + outcomes and PROPOSES diffs to rules/skills (the retro improving the retro). **Always proposal-only** — the Goodhart guard against an optimizer loosening its own success criteria. Proposal-only alone guards a single bad jump, not drift, so add the trajectory controls:
1. **CRITERIA-CHANGE class** (diffs to `.claude/rules/`, `CLAUDE.md`, `docs/adr/`, `.claude/skills/`, guardrail-pin MEMORY sections): own digest section, separate worktree branch.
2. **Append-only changelog** of accepted criteria-changes (git is the substrate); periodically (~monthly) the digest presents a **cumulative diff-against-baseline** so Larry reviews the trajectory, not just the nightly delta.
3. **Cooling-off:** once Larry defers/declines a criteria-change, suppress its "deferred/revisit" marker from re-selection for N nights — kills the re-suggest-until-approved ratchet.
4. Governing files remain proposal-eligible (a proposed branch diff is the safety model; `/build-task` Q5 expects retro edit proposals to exactly these files) — the guard is the cumulative-drift view + quarantine, not a ban. The loop **never writes user auto-memory in place** (it emits proposals, not memory edits).

---

## Repo constraints the design respects
- Sequential implementation; never parallelize code-WRITING. Parallel agents are read/verify only. The pass is temporally exclusive from daytime work; the liveness interlock enforces non-overlap.
- No autonomous commits to the long-running branch. Security-by-default. Coverage targets (branch > 80%, statement > 90%) are thresholds, not optimization goals — the loop must not chase coverage delta.
- No build step in the dev loop (`vitest` + `tsc --noEmit` only). `experiments/` are disposable and out of scope for the pass.

---

## Phases & success criteria

### Phase 0 — Pre-flight foundations (no autonomous behavior yet)
- [ ] Run `/consolidate-memory` to get MEMORY.md under its 24.4KB limit.
- **Success:** MEMORY.md loads fully (under limit). *(The reset-boundary empirical check and the Stop/SessionStart heartbeat hook from the earlier design are **no longer needed** — the fixed-12:30 start removes any dependency on the exact window-reset instant.)*

### Phase 1 — Trigger + pre-flight (token-free script)
- [ ] A **fixed 12:30am** trigger (plain local cron, or a cloud trigger if nights-with-laptop-closed must run) that is token-free w.r.t. the subscription and dispatches the pass. No `E_close` computation, no decision table.
- [ ] Pre-flight gate (dirty-tree → findings-only, liveness mtime-check → APPLY-gate, baseline capture + KNOWN-RED allowlist, memory budget).
- [ ] Hard wall-clock kill at 5:15am (belt-and-suspenders; a real pass finishes in minutes).
- **Success:** a dirty tree degrades to FINDINGS-ONLY; recent activity within N min drops APPLY; the trigger fires without opening a subscription window before the pass.

### Phase 2 — Within-night loop + digest, FINDINGS-ONLY (APPLY opt-in)
- [ ] The within-night control loop: SELECT (≤5 min) → per-candidate VALIDATE (≤15 min) → WORK → chain, no-new-start at 2:30am.
- [ ] Three-source selector with the eligibility predicate, scoring axes (incl. recency-of-prior-review penalty), marginal-yield dedup + per-target ledger, absolute NO-GO bar.
- [ ] Morning digest (all 7 sections), write-once, baseline-delta Health, push notification.
- [ ] Checkpoint-per-phase persistence; 5:15am hard wall-clock kill; ~8am dead-man's-switch (push "did not run" if no dated artifact).
- [ ] **APPLY stays OFF until Larry flips it on** — no fixed shadow period; FINDINGS-ONLY (also forced by the dirty-tree/liveness gates most nights) means early selection mistakes cost only a skimmed findings list, not a wrongly-drafted diff. *(Learning by doing — calibration constants are starting guesses, tuned as the loop runs.)*
- **Success:** the loop validates-then-works ≥1 real candidate end-to-end; a dud is dropped at VALIDATE (no full pass) and recorded so it is not re-picked; a forced mid-pass crash leaves a resumable partial artifact reported in the digest; the digest never cries wolf on the allowlisted RED test; "none — reason" appears on no-candidate nights; nothing starts after 2:30am.

### Phase 3 — Enable APPLY (diff-drafting) mode (gated, opt-in)
- [ ] Dedicated `.claude/worktrees/nightly` worktree cut from clean HEAD; criteria-change diffs on a separate branch; reset/deleted each night; never mechanically merged.
- [ ] Full mode-selection gate; APPLY only on clean tree + idle session + stabilized target; FINDINGS-ONLY on any ambiguity; log the verdict's driving signals for Larry to veto.
- **Success:** a dirty-tree night produces zero repo writes; an APPLY diff for an unrelated stabilized file never includes the working tree's uncommitted edits (cut from clean HEAD).

### Phase 4 — Meta-retro + trajectory controls
- [ ] CRITERIA-CHANGE quarantine, append-only changelog, monthly cumulative-drift digest, cooling-off on declined proposals.
- **Success:** a criteria-change proposal never appears bundled with code diffs; a declined proposal is not re-surfaced for N nights; the monthly view shows cumulative drift against baseline.

## Decisions & calibration (2026-06-14)

**Resolved this session:**
- **Fixed 12:30am start** — reset-boundary second, E_close anchoring, heartbeat hook, and jitter/ε are all moot.
- **Trigger = local cron** — Larry leaves the machine on overnight; cloud deferred until it can run the test suite.
- **No calendar shadow period** — APPLY is opt-in (off until Larry flips it); the loop runs FINDINGS-ONLY meanwhile (also forced by the dirty-tree/liveness gates), so trust is built by watching it run, not by a fixed 1–2 week digest-only phase.
- **Within-night loop** — SELECT (~5 min) → per-candidate VALIDATE (~15 min) → WORK → chain; **no new candidate after 2:30am**; count is unbounded (list-exhaustion + cutoff), typically 0–3.

**Calibration — starting defaults, tuned by doing (this process is itself an experiment that evolves as we exercise it):**

| Constant | Starting value |
|---|---|
| SELECT wall-clock kill | 5 min |
| VALIDATE wall-clock kill | 15 min |
| No-new-start cutoff | 2:30am |
| Hard window kill | 5:15am |
| Marginal-yield threshold (X%) | 20% new surface |
| Per-target cooldown (K) | 3 nights |
| APPLY stabilization window | no commit touching target in 48h |
| Criteria-change cooling-off (N) | 7 nights |
| NO-GO leverage floor | unblocks a current critical-path item OR fixes a RED signal |
