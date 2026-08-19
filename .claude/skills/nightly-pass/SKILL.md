---
name: nightly-pass
description: Manually-invoked bedtime quality/security audit pass (v1). Runs a FIXED, hard-coded audit menu — fast whole-repo tripwires + one rotating backfill campaign (mutation-audit) — adversarially verifies each finding before reporting, and writes a triage-optimized morning digest to tasks/nightly/<date>.md. Invoke EXPLICITLY at bedtime via /nightly-pass — never auto-trigger.
---

# Nightly Pass (v1 — hard-coded audits)

The bedtime ritual: like checking the locks. Invoked **manually** in an interactive session — which (a) runs it on the interactive budget, not the headless Agent SDK credit, and (b) *is* the reminder to plug the laptop into power and leave the lid open. It runs a **fixed set of audits** and leaves a short digest to read over coffee. **Findings-only**: it never fixes, commits, or proposes source edits.

**Why hard-coded audits, not candidate selection:** the v0 approach picked a nightly target by mining `tasks/nightly/backlog.md` (itself mined from task files). The one v0 run proved that rots — task-file-derived targets go stale (its target's source files are now in `archive/`), and an agent can't tell a live obligation from a stale note by reading a drifting task file. The audits below are grounded in `.claude/rules/` + ADRs + source — artifacts that are always present and don't drift — so **there is no "what should I work on tonight?" judgment.** Superseded design + full pivot rationale: [tasks/archive/nebula-nightly-loop.md](../../../tasks/archive/nebula-nightly-loop.md) (retained for its safety-model reasoning only).

## Governing rule: optimize for LARRY'S MORNING ATTENTION, not tokens
The scarce resource is the few minutes Larry has at 8am before real work. **Every step biases toward a digest he can triage in a glance.** Cap it, rank it, dedup it. A long digest means the pass over-reported — tighten the cap, not the discipline.

## The non-negotiable: find → verify → report (never find → report)
Each candidate finding is **adversarially self-verified before it reaches the digest.** An unverified finding is noise, and noise is what kills an audit tool — one plausible-but-wrong finding and the digest stops getting read. The verify step differs per audit (below); for mutation-audit it's mechanical ("did the test actually go red"), for tripwires it's "is this hit real and reachable, not a false pattern-match." Report only survivors.

## What it runs (the menu is FIXED — no selection)
Two tiers, in order:

1. **Tripwire preamble** — fast, whole-repo, **every launch**, ~zero false-positive. Cheap enough to always run; these never decay. Report only **new** violations (dedup vs the known-findings set).
2. **Rotating campaign** — a **finite backfill** that advances a persisted cursor and burns the remaining budget. **v1 = mutation-audit** the test corpus.

**Explicitly NOT in v1** (cut or parked — do not reintroduce): task-file candidate selection (retired v0); APPLY/diff/worktree/commit; cron/auto-trigger; meta-retro; a standalone parameterized-SQL sweep (**folded into the raw-`.exec()` tripwire** — value-injection is structurally prevented by the `sql` tagged-template wrapper; the real SQL-*identifier* audit is armed only when the ORM/queries layer lands — see [tasks/on-hold/nebula-orm-and-queries.md](../../../tasks/on-hold/nebula-orm-and-queries.md) § Dynamic-identifier safety).

## Cadence (keep it honest)
This is **finite backfill campaigns + a thin steady-state watchdog**, not a forever-at-full-intensity engine. Cadence should **decay** as the campaign burns down — **2–3×/week may beat nightly** once the corpus is covered. The 5-hour window **resets** (it does not hard-stop); a mid-sweep budget-cap hit is fine because the cursor checkpoints per-file. Don't *start* after ~3am if you want a fresh 8am window; don't sit down before ~6:30am or you share the depleted overnight window.

---

## Procedure

### 1. Pre-flight (record, never mutate)
- `git rev-parse HEAD` and `git status --porcelain`. A dirty tree is fine — findings-only. **Record the porcelain baseline**; you will assert the tree is byte-identical after any mutation-audit step (below).
- Read `tasks/nightly/audit-state.md` (per-audit **cursors** + **known-findings** dedup sets). Create it if missing (template at the bottom of this file).
- Known-RED allowlist — do **not** cry wolf on pre-existing failures: `drop-on-failed-broadcast subscriber cleanup` (`nebula-client-disconnect-cleanup.test.ts`, `task_3e018327`).

### 2. Tripwire preamble (fast, whole-repo, every run)
Run each. Each is **grep-first, then verify** the hit is real before it counts. Report only violations **not** already in the known-findings set. Expected steady-state result: **all clear** (these have near-zero surface on this repo), so any hit is high-signal — surface it prominently.

- **Secrets & config-hygiene** (`critical.md`, `security.md`): a committed `.dev.vars` (`git ls-files | rg '\.dev\.vars$'` — only `.dev.vars.example` is allowed); a test-mode flag in a `wrangler.jsonc` `vars` block (`rg -n 'TEST_MODE' --glob '**/wrangler.jsonc'` → they belong in vitest `miniflare.bindings`, never `vars`); an obvious secret literal (`apiKey`/`secret`/`token = "…"`) in source/`wrangler.jsonc`/`tsconfig`. **Verify**: the `TEST_MODE` hit is a `"vars"` key (bad), not a DO binding `"name"` like `…_TEST_DO` (fine — that FP is why the pattern is `TEST_MODE`, not `_TEST_`); a real secret vs a `.example` placeholder.
- **Sync-storage-only** (`critical.md`): the legacy async API on `ctx.storage` directly, in **production `src/`** — `rg -nP 'await\s+[\w.]*ctx\.storage\.(get|put|delete|list)\b' -g '**/src/**' -g '!**/*.d.ts' packages apps --type ts | rg -v ':\d+:\s*(//|\*)'` (the trailing filter drops comment/JSDoc lines — a `// await ctx.storage.put` note is not a violation). **Verify**: it's `ctx.storage.get/put/…` (bad), not `ctx.storage.kv.*` / `ctx.storage.sql.*` (fine). **Known carve-out**: `packages/{testing,rpc}` *test fixtures* deliberately exercise the async API to test raw RPC/storage — out of scope for this tripwire (their `test/**` DOs aren't shipped).
- **Generated-`Env` only** (`critical.md`): a hand-written top-level `Env` — `rg -nP '^\s*(export\s+)?(interface|type)\s+Env\b' packages apps --type ts -g '!**/*.d.ts'` (match **exactly `Env`**, not `\w*Env`; exclude `.d.ts`, where augmentations legitimately live), plus the named-alias anti-pattern `rg -nP '(interface|type)\s+(MyEnv|AuthEnv)\b' packages apps --type ts`. **Verify** — discard these ALLOWED forms (all seen in the 07-15 shakeout): `declare namespace Cloudflare { interface Env … }` / `declare global` augmentation; `interface ProvidedEnv extends Env` (the `cloudflare:test` pattern); `Env & { … }` widening; a narrow local subset shape in a cross-package library (e.g. `EmailSelectionEnv` — a function's env-access shape, not a shadow of the global). The violation is a **fresh bare `interface Env {` / `type Env =`** shadowing the generated global.
- **`TODO` in a `for-docs/` test** (`testing.md` § `for-docs/` tests are mini-apps): a deferral marker inside a doc-backing mini-app, where the doc block it was meant to back is already published behind a green `@check-example` — `rg -nP '(//|/\*|^\s*\*)\s*TODO\b|\bTODO:' -g '**/test/for-docs/**' packages apps --type ts`. **Currently zero hits.** **Verify**: it's a comment marker (bad), not a `Todo`-domain identifier — `TODO_TYPES`, `const TODO = \`interface Todo …\``, which the fixtures use heavily and which the pattern is shaped to exclude. The remedy is never "delete the comment": either write the test or convert it to an `it.skip` carrying the real assertions.
- **Raw-`.exec()` interpolation** (the demoted SQL check): a query string built by interpolation and handed to raw `.exec()` — `rg -nP '\.exec\(\s*\x60[^\x60]*\$\{' packages apps --type ts`, plus the variable-built form (a SQL template literal assigned then `.exec()`'d). **Currently zero hits.** **Verify**: an interpolated *value* that should have used the `svc.sql` tag (bad) vs a constant/allowlisted identifier. (Dynamic identifiers from user input are a *different*, parked audit — see the ORM task file.)

*(Patterns tuned in a 2026-07-15 shakeout — production `src/` came back all-clear on all four tripwires; the false-positive classes each pattern's Verify step must discard are named inline.)*

### 3. Campaign slice — mutation-audit (burns the remaining budget)
Retroactively confirm the **capable-of-failing** discipline (`testing.md` § "Tests must be capable of failing") over the test corpus — the pre-discipline and added-during-a-port tests are the likely vacuous ones.

- **Load the cursor** from `audit-state.md` (which test files are done). Walk test files in a **stable order** (e.g. sorted path); don't try to guess pre/post-discipline — uniform coverage is the cheapest signal.
- **For each target test**, mutation-check it:
  1. Identify the **exact code path** the test claims to cover.
  2. Apply **one targeted mutation** to *that path* (comment it out / invert the condition / change the returned value). For a **compound condition** (`a || b`, a multi-status check), **mutate each operand independently** — toggling the whole branch only proves one operand is covered.
  3. Run **just that test, UNDER ITS CORRECT PROJECT** (`--project <name>`). ⚠️ Running a test under a catch-all project's *wrong bindings* manufactures a false red (`testing.md` § Test organization) — verify the project before trusting the result.
  4. **Capable-of-failing** = the test went **red**. **Vacuous** = it stayed **green** under mutation → a finding (name the test, the mutation applied, and why it survived).
  5. **RESTORE the source and verify `git status --porcelain` is byte-identical to the pre-flight baseline** before moving on. This is a hard gate (see § Bounded source-write exception).
- **Checkpoint the cursor per-file** so a budget-cap hit mid-sweep never strands a mutation or loses progress.
- **Dedup** findings vs the known-findings set; **cap** the digest at the top ~5 by confidence, and **backlog the rest** into `audit-state.md`.
- **Advance the cursor**; log coverage (`audited N / total test files`).

### 4. Write the digest → `tasks/nightly/<YYYY-MM-DD>.md`
Write-once (append a `## Run N` section if today's file exists). Format for a 2-minute triage:

```
# Nightly digest — <date>

**Verdict:** <one sentence, lead with ✅ or ⚠️>

## Tripwires
- <✅ all clear> | <⚠️ NEW: file:line — what — the one-line action>

## Mutation-audit (campaign)
- Progress: audited <N>/<total> test files (this run: <k> checked).
- Findings (capped, top <=5): <test> can't fail — <the mutation that survived> → <the fix or the assertion it needs>
- (or "✅ none — every test checked this run went red under mutation")

## Your move
<explicit per item: "nothing" | "fix test X" | "look at file:line">

## Deferred to backlog
- <count> lower-confidence findings parked in audit-state.md
---
Time: <wall-clock>. HEAD <sha>. Baseline known-RED: disconnect-cleanup (allowlisted).
```

Keep it short. A long digest means the cap was too loose.

### 5. Update state
- **`tasks/nightly/audit-state.md`** — advance cursors; add reported + deferred findings to the known-findings set (so they don't re-surface nightly).
- **`tasks/nightly/ledger.md`** — one line: `- <date> · tripwires <✅|⚠️N> · mutation-audit <k checked, m findings> · <total audited>/<corpus>`.

---

## Bounded source-write exception (mutation-audit ONLY)
Findings-only means the digest never *proposes* a source edit. Mutation-audit is the **one** process that *transiently* modifies source — to run the red-check — and it MUST **mutate → run → restore → verify-clean** within the same step, leaving **zero net change**. The verify gate is `git status --porcelain` byte-identical to the pre-flight baseline. **If a restore can't be verified clean, STOP the campaign immediately and report it loudly at the top of the digest** — a stranded mutation is a repo-integrity problem, not a finding. Never batch mutations across files without restoring between them.

## Out of scope for v1 (do NOT do)
- No fix / APPLY / worktree / branch / commit. Findings-only.
- No task-file candidate selection (retired v0). Never read `tasks/nightly/backlog.md` (retired).
- No deploys, `experiments/` runs, benchmarks, or full-suite runs — only the **targeted per-test** runs mutation-audit needs.
- No cron / auto-trigger — manual bedtime launch only.
- Never leave a net source change. The only source touch is mutation-audit's restore-verified transient mutation.

## `audit-state.md` template (create on first run)
```
# Nightly audit state (cursors + dedup)

## mutation-audit
Cursor (last completed, stable path order): <none yet>
Corpus size: <total test files>
Known findings (dedup — do not re-report):
- <none yet>

## tripwires
Known/acknowledged violations (dedup — do not re-report):
- <none yet>
```
