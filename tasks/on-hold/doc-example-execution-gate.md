# Every published code example is proof that the code it teaches runs

**Status:** ⏸️ **ON HOLD — design intent only** (`/write-task` pass 1), written 2026-07-31 on
`pre-alpha`, paused before the hand read. No phases and no mechanism are chosen; resuming means
reading the intent below, settling the two open questions, then `/review-task` Stage 1 → phases.

Prompted by a defect found during `/build-task` on
[nebula-auth-decouple-from-auth.md](../archive/nebula-auth-decouple-from-auth.md): `mesh/test/for-docs/security/`
sat at 60% function coverage with four doc-taught functions at **zero hits**, three of them behind
green `@check-example` blocks. Fixed for that one mini-app in `6df027b`; the class is untouched.

**Objective — a `@check-example` annotation carries execution evidence, and CI fails when it carries
none.**

## Context and current state

**Built already:**

- **`@lumenize/docusaurus-plugin-check-examples`** (`tooling/check-examples/src/index.js`, 591 lines,
  one file) reads the annotated file, normalizes both sides, and asserts the doc block appears as a
  substring. Its `parseAnnotation` already resolves the target path, and it has a `--report` mode.
- **233 `@check-example` annotations** across **62 unique targets** — 209 pointing into `packages/`,
  24 into `apps/nebula` (backing `website/docs/nebula/`).
- **CI runs coverage** for all packages + apps (`ci.yml` § `run-packages-tests-with-coverage` →
  `test-code.sh --coverage`), uploading `packages/*/coverage/lcov.info` to SonarCloud.
- **Coverage over decorated for-docs fixtures now works** (`9fa9e54`) — `unplugin-swc`'s default
  filter `/\.m?[jt]sx?$/` is end-anchored and skipped the query-suffixed ids coverage's uncovered-file
  pass requests, so the `@mesh()` decorator reached istanbul's Babel instrumenter and killed the run.
  ⚠️ **Fixed in `packages/mesh/vitest.config.js` only.** Any other package that widens coverage over
  decorated fixtures needs the same `include: /\.m?[jt]sx?(\?.*)?$/`, and its symptom is a run that
  dies rather than a number that looks wrong. Scope coverage with a `*.ts` glob, never `**`, which
  matches the `wrangler.jsonc` in the mini-app and fails with a misleading `Missing semicolon`.
- **Standing guidance** landed 2026-07-31: `documentation.md` § Skip-Check Annotations (which target
  kind to choose), `testing.md` § `for-docs/` tests are mini-apps (guard demos must drive the real
  mesh path; no `TODO` in a for-docs test), and the matching `/nightly-pass` tripwire.

**Missing:**

1. **The annotation and the execution evidence are produced by systems that never meet.** Coverage
   runs in one CI job; `check-examples` runs in none. Nothing consumes both.
2. **`check-examples` does not run in CI at all.** `ci.yml` § `run-doc-tests` iterates
   `doc-test/*/*/` — the *legacy* `@lumenize/doc-testing` packages — and never invokes the plugin. The
   plugin fires only from the Docusaurus `postBuild` hook or a local `cd website && npm run
   check-examples`, and no workflow builds the website. So even the text match is ungated on a PR.
3. **Every package's coverage `include` is `src/**`**, so the 53 fixture-targeted annotations across
   21 files are measured by nothing. Widening it has in-repo precedent — `auth`, `nebula-auth`, `rpc`,
   `testing` and `ts-runtime-parser-validator` already add a `test/**` entry to `include`. The
   sharpest illustration of the gap sits in a package that has not: `routing`'s include is `src/**`
   alone, while `packages/routing/test/integration/test-worker-and-dos.ts` carries four live
   annotations.
4. **The audit itself.** Part of one kind in one package has been measured — mesh's for-docs
   fixtures, where `calls` (76.7% funcs), `getting-started` (91.7%) and `alarms` (94.1%) hold twelve
   zero-hit functions between them. The remaining fixtures and the other three kinds are unmeasured
   across every package. That partial audit also surfaced the **inverse** defect, undecided and with
   no other home: `TeamDocDO.updateDocument` and its guard are exercised but no `@check-example`
   references them, and the fixture comment still calls it "block 3, second example" — a doc block
   was deleted and the fixture was not. It is worth re-adding rather than deleting, because
   `security.mdx`'s Method-Level section opens *"Guards receive the instance, providing access to
   instance state"* and its only example reads claims, never instance state. Either re-add the block
   or reword that sentence.
5. **A gate.** Nothing fails when a doc teaches code that never runs.

## Design intent, constraints, and future state

**The contract: every `@check-example` annotation has a mechanically-derivable answer to "what
executes this?", and CI fails when the answer is "nothing."**

The guarantee a reader takes from a documented example is that it works. Today that guarantee is
produced by no system — the text match proves the doc mirrors code that *exists*, which is a
different claim, and it is the only claim any tooling makes. The defect is structural rather than
local: a fixture whose sole purpose is to be exercised is the one place where dead code leaves no
trace, because nothing else references it and nothing measures it.

**Evidence is per target kind.** What counts as evidence differs by kind, so the contract is a split
rather than a single rule:

| Target kind | What "it executes" means | Where the evidence comes from | Count |
|---|---|---|---|
| **fixture** — a non-test file in a test tree, whether or not under `for-docs/` | the matched function is exercised by the mini-app's own test | function coverage on that file | 53 annotations, 21 files |
| **test** file | the matched block sits in a test that actually runs | the test is not `.skip`ped | 150, 26 files |
| executable **`src/`** | the taught symbol is exercised by the package suite | function coverage on that file | ≤30, ≤15 files |
| **type declaration** | nothing executes, and that is correct | none is required — the text match is the whole guarantee | ≥7 annotations |

⚠️ **The last two rows split on the CONTENT of the matched block, not on the path** — the first two do
split on path, and I originally asserted all four did. Seven annotations target a bare `types.ts`, but
a declaration also lives inside executable files (`ConnectionState` in `mesh/src/lumenize-client.ts`),
and a `types.ts` could in principle carry a runtime value. So the classifier reads the matched
region, which `check-examples` already holds at the point it resolves the target. Fixing the exact
`src/` split is *part of* the audit, not a precondition for it — but the design must not assume a
path-only classifier, because a path-only one silently files every declaration in an executable file
under "needs coverage" and then demands evidence that cannot exist.

**Three claims carry the design. Each is falsifiable, and review should try:**

1. **No new measurement infrastructure is required — only a classifier, a join, and a gate.** Coverage
   for `src/**` runs in CI today; fixture coverage needs an `include` widening with in-repo precedent;
   test-is-not-skipped is a parse. So this task builds a *consumer* of signals that already exist,
   and its cost is dominated by the audit and the repairs rather than by tooling.
2. **A gate finds existing instances and stops regressions; a rule does neither.** The `testing.md`
   guard rule added 2026-07-31 would not have caught the twelve zero-hit functions in `calls/`,
   `getting-started/` and `alarms/` — they predate it, and nothing re-reads old code against a new
   rule.
3. **The gate cannot express example quality, so the rule is not redundant.** A function-coverage
   floor is satisfied by *any* call to the function, including one that bypasses the very mechanism
   the example demonstrates. Calling a `@mesh` guard directly from a unit test greens the floor and
   proves nothing about the entry path — which is exactly the `requireSubscriber` defect, one layer
   up. The two mechanisms cover disjoint properties and the task delivers both.

**A gate that ships with its own failures excluded is an interim, and interims are the expensive
kind** (`workflow.md` § Evaluating alternatives). The end state is a gate with no allowlist. Where
that forces repair before enforcement, the repair is in scope; where a target genuinely cannot carry
coverage evidence, the *kind* is what changes, never the individual case.

**Constraints:**

- **Rules:** `documentation.md` § Skip-Check Annotations and § Code example validation;
  `testing.md` § `for-docs/` tests are mini-apps (the repair standard: real mesh path, both halves,
  mutation-checked) and § Tests must be capable of failing; `critical.md` (docs live in
  `/website/docs/`; no build in the dev loop, so the gate runs from source).
- **ADR-001** binds the type-declaration row: mirroring a TS declaration is the intended use of the
  mechanism, because the type *is* the schema and there is nothing to execute.
- **Coverage targets in CLAUDE.md** (Branch >80%, Statement >90%) are whole-package aggregates and
  answer a different question from "was this particular example exercised?" — a package can meet both
  while a fixture file sits at zero. Whatever per-example measure this settles on must not be
  conflated with them in either direction.
- **Some targets live in lanes that produce no coverage.** `apps/nebula/test/chromium/*-browser.test.ts`
  is a `@check-example` target today, and neither the browser nor the `wrangler dev` lane emits a
  coverage report (`live.md`, `testing.md` § What a skipped test needs to run). See the open questions.
- **`/nightly-pass`** already carries the `TODO`-in-for-docs tripwire, so the same defect must not
  surface twice under two names.

**Future state.** Knowing which files the docs depend on, joined to what actually ran, is the
substrate for anything later that wants to reason about documentation freshness — which page teaches
which symbol, what a rename breaks, which examples a release note must mention. Nothing here should
foreclose that by making the outcome a bare pass/fail with no readable record of what was classified
and why.

⚠️ **Design consideration — granularity.** Region-precise mapping (matched doc block → line range →
intersect with coverage) requires threading an offset map through normalization, which strips
comments and imports. File-and-function granularity is far cheaper and catches the same defects at
the sizes these fixtures actually are. Worth revisiting only if a fixture grows large enough that a
whole file passing stops implying the taught region ran.

⚠️ **Design consideration — orphan detection was measured and rejected.** Flagging fixture files no
doc block references sounds like the cheap inverse of this problem. It flags six files, four of which
are worker entries or client fixtures that correctly have no doc block, and it would not have caught
`updateDocument`, whose file *is* referenced. The useful version is method-level, which is the
region-precise problem above.

## What done looks like

Observable properties of the finished state — not steps, and deliberately silent on mechanism:

- **Every `@check-example` annotation in the repo has a known evidence kind**, recorded somewhere a
  person can read rather than inferred afresh each time someone asks.
- **No annotation whose kind requires execution evidence lacks it.** Concretely: no function a
  published doc teaches sits at zero hits.
- **Publishing an example with nothing behind it fails before merge**, with no human needing to
  notice. Today that is true of neither the execution claim nor the text match.
- **A failure names the annotation and the doc page it backs**, so the reader knows which published
  sentence is unsupported — not merely that some file's coverage dropped.
- **No allowlist of known-failing annotations exists.** A gate shipped with its own failures excluded
  is an interim, and interims are the expensive kind (`workflow.md` § Evaluating alternatives). Where
  that forces repair before enforcement, the repair is in scope; where a target genuinely cannot
  carry evidence, its *kind* is what changes, never the individual case.
- **The repairs meet the repair standard**, not merely the metric: a guard is demonstrated over the
  real mesh path with both halves asserted and the mutation named (`testing.md` § `for-docs/` tests
  are mini-apps). This is the half no gate can check, which is why claim 3 above matters.

**Open questions — decisions that must be made, each changing what "done" covers:**

1. **Does `apps/nebula` fall in scope?** Twenty-four of the 233 annotations back
   `website/docs/nebula/`, which is published on lumenize.com, but Nebula is `UNLICENSED` and is not a
   published package. The stated scope is "all published packages"; taken literally, a quarter of the
   public documentation surface keeps the guarantee it has today.
2. **Is "the test runs and isn't skipped" sufficient evidence for an example whose lane emits no
   coverage?** The browser and `wrangler dev` lanes produce none, and at least one `@check-example`
   target lives there. Either that weaker evidence is accepted for those examples — in which case the
   contract has a tier — or such examples must move to a lane that can carry the stronger evidence.

---

*Pass 2 (Decisions, Phases, Non-goals, Relationships) is unwritten, and deliberately so: per
`/write-task`, phases are written only after the intent above has had a hand read.*
