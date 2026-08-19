---
name: review-task
description: Two-stage panel review of a task file BEFORE implementation. Stage 1 (framing & scope — archaeology/altitude, YAGNI + intermediate-goal scoping, product vision) is resolved and the file edited FIRST; Stage 2 (conformance — architecture/mesh, security, test-strategy) then reviews the cleaned file. Each stage adversarially verifies findings before you see them. Use when a task file is ready for design review, when the user says "review the X task", or before saying "go" on implementation.
---

# Review Task

Replaces the expensive serial "run the task file through fresh contexts repeatedly" loop with **two parallel passes** of specialized reviewers, each followed by an **adversarial verify pass** that kills false positives before you see them. This is the highest-leverage fan-out in the docs-first cycle — catching design drift here is what makes implementation near-transcription. It **reduces** review loops (~5–8 → ~2), it doesn't replace them: expect a fresh human-led pass after to catch what anchored reviewers miss.

**Why two stages.** Don't run detailed mesh/security/test checks against prose you're about to delete. A single combined pass anchors low-level findings to text that a framing fix is about to rewrite — wasted agents, and findings that clash with a reviewer (human or model) whose head is still at altitude. So **Stage 1 settles *what the file should be* (shape, scope, framing) and the file is edited, *then* Stage 2 checks *whether its lines follow the rules*.** Altitude before detail.

> ⏳ **TEMPORARY — remove when pre-alpha ships.** Pre-alpha has **one wipe+redeploy gate at the end**, not a per-task one (see the `task-files-neednt-be-deployable` memory). During the Stage-1 gate and synthesis, do **not** treat "this task file isn't independently deployable" or "it's interdependent with a later pre-alpha file" as a finding — that is the intended workflow. Deferred testing is fine when the later (still pre-alpha) file carries explicit acceptance criteria for it. When pre-alpha ships, delete this block.

## Usage
`/review-task <path-to-task-file>` (defaults to the active task file if omitted).

## Procedure

### 1. Scout the spec (inline, before any fan-out)
Read the task file **and everything it depends on** yourself — linked sub-task files, referenced `/website/docs/*` pages, any pseudo-code/interface it cites, `docs/adr/*.md` (architecture commitments), `docs/vision/*.md` (product strategy). You need that context to write sharp lens prompts and to judge the findings when they come back. Design review is where ADR and strategy conflicts get caught — `/build-task` deliberately does not re-check either — so a design conflicting with an ADR is a blocker unless the task explicitly proposes superseding it, and one violating a strategy check is a framing blocker unless the task argues for changing the strategy.

⚠️ **`spec` is a READ MANIFEST, not concatenated content — never inline the corpus.** Agents have `Read`/`Bash` and the prompt already tells them to verify against disk, so pass **paths plus what to check at each**, and inline verbatim only the task file itself when it is small. Two reasons this is not a nicety:

- **Cost is `O(agents × spec)`, not `O(spec)`.** Every per-finding verifier carries the same string, so a 20-finding pass multiplies it ~24×. (The naive concat has been measured at **185 KB and then 193 KB** on two separate runs — ~120 KB of it ADR text — and it only grows as ADRs accumulate.)
- **Reading from disk is strictly better evidence.** A pasted excerpt is a snapshot the reviewer cannot re-check; a path makes them open the real file, which is what catches a task file's claims being wrong about its own repo.

A good manifest is numbered, says *why* each entry matters, and ends with the specific source files the task makes claims about. Mark superseded/icebox inputs as reference-only so nobody reports their staleness as a finding. Cap inlined ADRs at the `README.md` index plus the two or three plausibly in scope, and tell reviewers to open the rest from disk if they suspect a conflict.

If the user pasted "already caught" findings from a prior loop, collect them as `priorFindings` so reviewers don't repeat them.

### 1.5 Self-review before you spend the panel — especially after heavy edits

**Read the file yourself first, in one pass, hunting for internal inconsistency.** Late edits break
cross-references far faster than they break prose, and cross-references are what a builder follows:
a cut phase leaves stale references in criteria, a renumber leaves stale pointers, a restructure
leaves a paragraph arguing the previous design. In one instance a single self-review pass found seven
defects — **five of them introduced by that same session's edits**, including a success criterion
naming a site the cut phase had removed and a code change specified by line range that captured three
methods which must not be changed. Every one would have cost panel budget to rediscover.

Then **tell the panel what you did to the file.** If it has been heavily edited, say so in the
`spec`/`priorFindings` and instruct the lenses to **verify every cross-reference, count, phase number
and line reference against the code on disk** rather than trusting the prose. That instruction — not
the model, not the lens list — is what turns a design-level pass into a build-readiness pass, so use
it deliberately when the file is close to build and not before, when it would only produce nits.

### 1.6 After any cross-cutting reframe, re-sweep the Decisions table

When a review or a conversation changes the file's *organising idea*, walk **every** Decisions row and
ask: **did a LATER decision make this one moot?** Not "is its reasoning still true against reality" —
that is `calibration.md` §4 — but "has a sibling decision in this same file stranded it?"

A panel cannot catch this: each pass reviews a snapshot, and the defect lives in the **delta between
passes**. Bit 2026-07-28 on `/mint-narrower-token` — a `star.ts` guard row was written when the minted
token carried the *caller's* `admin` bit; a later decision made the token mirror the *subject's*,
which rendered the guard unreachable (any token that could trip it belonged to a subject whose own
token would trip it too). Three conformance passes missed it; the user asking *"is that still a valid
decision?"* found it, and a whole phase was cut.

⚠️ The same sweep applies to **enumerations and counts** the file states about itself ("the N sites",
"exactly one test breaks") — a cut or added phase falsifies them silently.

### 2. Stage 1 — Framing & scope (Workflow), resolved BEFORE conformance
Run the Workflow below with `args.stage = 'framing'`. This is the altitude pass: **spec-hygiene** (write-for-a-cold-implementer; reversed-decision archaeology → positive rewrite; goals-not-step-lists; spec-density; single-source-of-truth), **scope-discipline** (YAGNI / premature generalization; intermediate-goal alignment; correct deferral; build-order / prerequisites), and **product-vision** (walled-garden, footguns, ergonomics). Its output is dominated by **structural** findings — "rewrite this section/file positively", "cut or defer this scope" — not line-nits.

### 3. Gate — resolve Stage 1 and edit the file (this is the cure, not the catch-net)
Present the Stage-1 synthesis. Work through it with the user and **make the edits**: positive rewrites, scope-cuts, deferrals to on-hold files with a one-line pointer left behind. The file should leave this gate clean and correctly scoped. If Stage 1 surfaced nothing structural, say so and proceed.

⚠️ **Before moving on, walk your own DIFF the way you told the panel to walk the file.** Step 1.5 tells the lenses to *"verify every cited symbol's stated PROPERTY against disk, not merely that it exists"* — that instruction applies to the sentences **you just wrote**, and the asymmetry is a live defect, not a hypothetical one. Re-read the diff and, for **every new sentence asserting something about existing code**, either cite the check you ran or run it now. Diff-scoped, so it is a dozen lines and not a file.

**The discriminator is sharp enough to trust** (2026-07-30, `nebula-impersonation-client`): of the claims written at that gate, **every one verified with a targeted tool call was right, and every one inferred from adjacent context was wrong** — five of them, all caught later by Stage 2, one of which reintroduced *the exact defect class the file was in review for* (a criterion in a phase that cannot satisfy it). ⚠️ **"I already read that file" is NOT the check.** In the worst instance the disproving line (`const browserB = new Browser()` — a cookie-less browser under a claim about a refresh cookie) was **in the session's own earlier tool output**; the failure was not looking, it was not asking what the read implied for the claim being written. So the check is per-*claim*, not per-file.

⚠️ **A written-down claim is not evidence for itself, and this file's own conventions make unverified claims READ as verified** — heavy ⚠️ markers, confident assertions, and `✅ Checkable` labels. Two `✅ Checkable` claims shipped false through several passes *because* the marker implied someone had checked. When a proposed fix is **determined by a claim already in the file**, say the claim out loud and name the check — or admit you did not run one. Three times in that session the panel and the author both optimized inside a frame the file asserted (*"assert the server-side rows"*, an `authScope` pin, a TTL floor); each was caught only by the human asking a mechanism question, because **a panel structurally cannot catch it — it optimizes inside the frame it is handed.** Surfacing the frame is what gives the human something to challenge.

**Then decide whether the file needs Stage 1 *again* before Stage 2 — by HOW MUCH it changed, not just that it changed:**
- **Light fix-application edits** (you applied Stage-1's suggestions roughly as given — a rewrite here, a deferral there, within the same shape) → **RE-SCOUT** (step 1 — re-read the file yourself; the manifest usually still stands, but your own picture of the file does not) and proceed to **Stage 2** on the revised file.
- **A substantial reshape** (the gate turned into a design conversation that split the file, redesigned a subsystem, added whole sections, or moved the shape/scope/altitude) → **restart from Stage 1** on the revised file. Re-run framing; do **NOT** jump to Stage 2. The new text has never had a framing pass, and Stage 2 (conformance-to-rules) won't catch bloat, single-source-of-truth smearing, reversed-decision noise, or altitude problems in it.

**Why restarting matters: the cost of skipping it lands in `/build-task`.** Build deliberately does not re-check framing — so if the gate edits didn't fully capture the Stage-1 fixes, an un-reviewed reshape's gaps flow straight into implementation. Rule of thumb: *re-run Stage 1 when the shape/scope/altitude changed; go straight to Stage 2 when edits only filled in mechanism within an already-validated shape.* This is bounded — one fresh framing pass, not a loop; when it returns clean (or near-clean), proceed to Stage 2. (Empirically: a file that went gate → design-conversation → pins came back from a fresh Stage 1 with real cross-file drift the gate edits had introduced, which would otherwise have shipped into the build.)

### 4. Stage 2 — Conformance (Workflow), against the revised file
Run the **same** Workflow with `args.stage = 'conformance'` and the re-scouted spec. This is the technical trio — architecture/mesh+DO, security, test-strategy — each handed its rule file as the checklist (the rules are the single source of truth). Now they review clean, correctly-scoped prose: no findings anchored to text that was about to change.

Both stages share one Workflow body (Review → Verify → Synthesize) and are invoked separately because the human gate between them requires edits a workflow can't pause for. The verify pass is tuned to err toward *keeping* (it only drops clear false positives), and every dropped finding is reported back so you can veto an over-eager refutation. Pass `args` as `{ taskFile, spec, priorFindings, stage }` — the script normalizes it whether the harness delivers an object or a JSON-encoded string.

```javascript
export const meta = {
  name: 'review-task',
  description: 'One stage of the task-file review panel (framing or conformance)',
  phases: [
    { title: 'Review', detail: 'one reviewer per lens, each with its rules/checklist' },
    { title: 'Verify', detail: 'skeptic refutes each finding; drop false positives, correct severities' },
    { title: 'Synthesize', detail: 'dedup + rank the surviving findings' },
  ],
}

// args may arrive JSON-encoded as a string (harness serialization) — normalize before use.
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {})
const TASK_FILE = A.taskFile
const SPEC = A.spec                  // task file + linked sub-tasks + docs, pre-read in step 1
const PRIOR = A.priorFindings ?? ''  // findings already caught in earlier loops
const STAGE = A.stage === 'conformance' ? 'conformance' : 'framing'

// Stage 1 — altitude: settle what the file SHOULD be before checking its lines.
const FRAMING_LENSES = [
  { key: 'spec-hygiene', rules: 'CLAUDE.md (repo root) + tasks/README.md',
    lens: 'Is this a clean spec for someone implementing it COLD (often an LLM in a fresh session)? It should state what we decide NOW, not re-litigate how we got there. Flag REVERSED-DECISION ARCHAEOLOGY: "we used to plan X, now Y" framing, defensive "not-X" disclaimers repeated throughout, and "X impact: unchanged" sections that exist only as a mirror of an abandoned design — the fix is a big-picture POSITIVE REWRITE of the file or section as if the reversed decision never existed, keeping at most a one-line pointer to where the deferred capability now lives (the on-hold/archive file owns that history). Also flag: phases that are step-lists instead of goals + testable success criteria; SPEC-DENSITY (a phase, esp. a later vN, that is NEITHER pinned with decisions+criteria NOR tagged exploratory — make the author pin it or tag it exploratory); SINGLE-SOURCE-OF-TRUTH (one decision smeared across files instead of owned in one place). Prefer ONE structural finding (location = whole file or section; suggestion = "rewrite positively") over a scatter of nits. These are legitimate even when no rule is broken.' },
  { key: 'scope-discipline', rules: 'CLAUDE.md (repo root) + tasks/README.md + .claude/rules/workflow.md',
    lens: 'Is this scoped to what we actually need NOW? Flag YAGNI strictly per .claude/rules/workflow.md § "YAGNI gates capability, never generality" — READ that bullet and apply it as your checklist rather than from memory. It is the single source for: the present-consumer test (tests count as consumers), the capability-vs-shape distinction, and a COST TEST that REVERSES the default flag direction when the general form costs the same or less than the narrow one. Flag INTERIM-SCAFFOLD HARDENING — complexity (ESPECIALLY guard/security machinery) added to *defend or elaborate a known-temporary artifact* (a placeholder/test scope, a stub, a hardcoded fixture, a deferred-feature interim): ask whether the design would exist at all under the *real / near-term* model, or ONLY because of the throwaway scaffold — if the latter, the fix is to drop the scaffold, not harden it. (A panel optimizes within the frame it is handed; this is the lens that questions whether the frame is itself an artifact.) Flag INTERMEDIATE-GOAL ALIGNMENT — work exceeding what the current milestone (e.g. the demo) needs, or milestone-critical work conflated with post-milestone work. Flag CORRECT DEFERRAL — post-goal work entangled in the active path instead of split to an on-hold file with a pointer. Flag BUILD-ORDER / PREREQUISITES — is the file sequenced right against its dependencies, are blockers named and ordering correct (a prerequisite task that must ship first). The fix is usually a scope-cut or a deferral, not more spec. ⏳ PRE-ALPHA EXCEPTION (temporary — remove when pre-alpha ships): a task file need NOT be independently deployable, and interdependence with a later pre-alpha task file is the intended workflow — do NOT flag either as a scope/build-order problem; deferred testing is fine when the later pre-alpha file carries explicit acceptance criteria for it.' },
  { key: 'product-vision', rules: 'EVERY docs/vision/*.md carrying a `status:` field in its frontmatter (a file without one — e.g. deck-workplan.md — is not a vision doc; skip it) + docs/vision/_review-lens.md (internal-only checks the lens reads but the VC pitch ignores; it also defines the status convention) + CLAUDE.md (repo root) + tasks/README.md. READ each doc\'s `status` and weight it per _review-lens.md § "Status convention": `accepted` = a conflict is a blocker; `draft` = flag against it but say the status in the finding, and SUGGEST UPGRADES to the doc where the task shows it to be stale, vague or contradicted; `rough draft` = never a blocker, note the conflict so the doc can catch up.',
    lens: 'Nebula product strategy & ergonomics for user-developers. Check the task against the STRATEGIC CHECKS in docs/vision/strategy.md (and enterprise.md): trades away security defaults for speed/flexibility; optimizes a vanity metric (forks/trending) or builds density-dependent features before single-player value exists; assumes multi-user/collaboration as a primary persona (it is ~90% solo); weakens the "get-paid" path; erodes deployment homogeneity (escape hatches, "deploy elsewhere", per-app infra divergence); treats discovery as a someday problem (no anti-slop story); builds enterprise-governance surface (SSO/audit/admin/org controls) before the self-serve wedge is proven. PLUS the classic walled-garden/ergonomics checks: footguns left in rather than removed, more-than-one-right-way, API-surface ergonomics, task-file template conformance. A design that violates a strategy check is a framing blocker unless the task explicitly argues for changing the strategy. Guard against footguns by removing them, not documenting them. ALSO apply the internal checks in docs/vision/_review-lens.md: (1) security is the wedge BECAUSE it is frictionless — so flag bolted-on security/process FRICTION disproportionate to the real risk (especially friction fighting a core feature like self-provisioning), not just weakened defaults; (2) the interim-scaffold smell — machinery that only exists to defend a known-temporary artifact.' },
]

// Stage 2 — conformance: check the cleaned file against the rules (rules = source of truth).
// For raw-DO-infrastructure tasks, swap the architecture lens's mesh.md for raw-comm.md
// (per the layer map in workers-projects.md); drop security for a pure refactor; etc.
const CONFORMANCE_LENSES = [
  { key: 'architecture', rules: '.claude/rules/mesh.md + .claude/rules/durable-objects.md',
    lens: 'Mesh-pattern + DO-architecture review. Flag pseudo-code that drops to raw Workers RPC instead of lmz.call/ctn; async in business logic; mutable instance-variable state; cross-package dependency pointing "up" (mesh → nebula); and feasibility ("this needs async in a sync method — won\'t work").' },
  { key: 'security', rules: '.claude/rules/security.md + docs/vision/auth.md (the auth/access-control model this repo conforms to — a task CONTRADICTING it is a conformance finding here, not a product-strategy one; weight it by its frontmatter `status` per docs/vision/_review-lens.md)',
    lens: 'Lumenize-specific security (not generic OWASP). Missing JWT/scope checks, resource operations with no DAG permission check, sandbox-escape via the proposed API, test-mode flags reachable in prod, trust-boundary crossings where the receiver does not re-validate.' },
  { key: 'test-strategy', rules: '.claude/rules/testing.md',
    lens: 'WHAT to test, not whether tests follow patterns. Are success criteria testable? for-docs mini-app vs isolated test? Untestable claims in pseudo-code? Missing scenarios the task file omits: error paths, concurrent access, eviction recovery.' },
]

const LENSES = STAGE === 'conformance' ? CONFORMANCE_LENSES : FRAMING_LENSES
log(`Stage: ${STAGE} — ${LENSES.length} lenses (${LENSES.map(l => l.key).join(', ')})`)

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['severity', 'category', 'location', 'finding', 'suggestion'],
    properties: {
      severity: { enum: ['blocker', 'major', 'minor', 'nit'] },
      category: { type: 'string' },
      location: { type: 'string' },   // section/heading in the task file, or "whole file"
      finding: { type: 'string' },
      suggestion: { type: 'string' },
    } } } },
}

const VERDICT = {
  type: 'object', additionalProperties: false, required: ['stands', 'rationale'],
  properties: {
    stands: { type: 'boolean' },                                   // false = false positive, drop it
    adjustedSeverity: { enum: ['blocker', 'major', 'minor', 'nit'] },  // optional severity correction
    rationale: { type: 'string' },
  },
}

// Review → Verify as a pipeline: each lens's findings get refuted the moment that lens finishes
// (no barrier between lenses). A slow lens never blocks a fast one's verification.
const reviewed = await pipeline(
  LENSES,
  l => agent(
    `You are the ${l.key} reviewer for a Lumenize task file (design review, before implementation).\n` +
    `Read ${l.rules} and use it as your checklist. Your lens: ${l.lens}\n` +
    (STAGE === 'conformance'
      ? `The spec ends with the repo's ADRs (architecture commitments) — flag any conflict with an ADR as a ` +
        `blocker unless the task file explicitly proposes superseding it.\n` +
        `ALSO check STANDING-GUIDANCE SELF-CONSISTENCY ACROSS PHASES, which no single-phase reader catches: ` +
        `if any phase rewrites an ENUMERATION whose worth is that it is exhaustive (a reader list, a ` +
        `call-site table, "the N sites that do X", a stated grep/count) inside a rule / ADR / README, check ` +
        `whether a LATER phase in the same file adds a member to it. If so that is a MAJOR finding — the ` +
        `guidance ships wrong in exactly the way it was rewritten to stop being wrong, always-loaded, and no ` +
        `test can red it. Suggest either moving the edit to the last phase that changes what it counts, or ` +
        `restating the claim STRUCTURALLY ("every X site is on this list") instead of by count. Bit ` +
        `2026-07-28 on tasks/nebula-mint-narrower-token.md (Phase 3 wrote "one CONTENTS reader" into ` +
        `security.md; Phase 4 added the second).\n`
      : `This is the FRAMING stage — judge the file as an artifact: is it the right shape, the right scope, ` +
        `free of reversed-decision noise? Favor a few high-leverage structural findings over many nits.\n`) +
    `The LINKED SPEC below has the task file + key excerpts; ALSO read the cited source files from disk ` +
    `(the task references files with line numbers) to verify premises rather than trusting the summary.\n` +
    `Already caught in earlier loops — do NOT repeat: ${PRIOR || '(none)'}\n\n` +
    `TASK FILE (${TASK_FILE}) + LINKED SPEC:\n${SPEC}\n\n` +
    `Return only NEW, specific, actionable findings, each tied to a location in the task file. No generic advice.`,
    { label: `review:${l.key}`, phase: 'Review', schema: FINDINGS }),
  (review, l) => parallel((review?.findings ?? []).map(f => () =>
    agent(
      `You are a skeptical verifier for a Lumenize design review — refute this finding before the author sees it.\n` +
      `Read ${l.rules}, the spec below, and the cited source from disk to check the claim.\n\n` +
      `FINDING (${l.key} / ${f.severity}) @ ${f.location}: ${f.finding}\nSuggested fix: ${f.suggestion}\n\n` +
      `Drop it (stands=false) ONLY if it is a false positive: already handled in the spec, based on a misreading, ` +
      `out of scope for this task, or not actually a rules violation — but a framing/spec-quality finding ` +
      `(reversed-decision noise, scope creep, spec-density, YAGNI, template conformance) is legitimate even when ` +
      `it maps to no rule, so judge those on whether fixing them helps a cold implementer, not on rule-match. ` +
      `If it is real, set stands=true and optionally correct its severity via adjustedSeverity. Do NOT drop a ` +
      `finding merely because you are unsure — err toward keeping. One-line rationale.\n\nSPEC:\n${SPEC}`,
      { label: `verify:${l.key}`, phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, lens: l.key, verdict: v })))))

// Barrier: dedup + rank needs ALL surviving findings together.
const all = reviewed.flat().filter(Boolean)
const survivors = all.filter(f => f.verdict?.stands)
  .map(f => ({ ...f, severity: f.verdict.adjustedSeverity ?? f.severity }))
const dropped = all.filter(f => !f.verdict?.stands)

phase('Synthesize')
const synthesis = await agent(
  `Synthesize these ${survivors.length} verified ${STAGE} design-review findings into ONE ranked list. ` +
  `Dedup near-identical items across lenses, group by severity (blocker → nit), keep location + suggestion for each, ` +
  (STAGE === 'framing'
    ? `lead with any STRUCTURAL "rewrite/cut/defer" recommendation (the whole point of this stage), `
    : ``) +
  `and end with a 2–3 line "biggest risks" summary.\n\n${JSON.stringify(survivors, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize' })

return {
  stage: STAGE,
  byLens: LENSES.map(l => ({ lens: l.key, n: all.filter(f => f.lens === l.key).length })),
  raised: all.length,
  survived: survivors.length,
  dropped: dropped.map(f => ({ lens: f.lens, location: f.location, finding: f.finding, why: f.verdict?.rationale })),
  synthesis,
}
```

### 4.5 Read the SHAPE of the result set before you process it

A synthesis is not a work queue until you have asked what its shape says. Two cheap reads, both from
numbers the Workflow already returns:

- **Refutation rate is the FRAME signal — not the count.** `raised` vs `survived` is the diagnostic.
  A high drop rate (**~30%**) means the reviewers are guessing at a design they lack the frame for:
  **stop, fix the framing with the user, and re-run — do NOT work the findings one by one.** A low
  rate (**~5%**) means they verified against source, and the list is worth processing item by item.
  Empirically in one file: pass 1 dropped 9 of 30 and its surviving findings were mostly false
  premises about a design that then changed; pass 4 dropped 2 of 44 and every survivor was actionable.
- ⚠️ **FIRST check `byLens` for a zero — a lens can die and the panel still returns a confident-looking
  synthesis.** A reviewer agent that hits a terminal API error contributes nothing, and the surviving
  lenses fill the page, so the result *reads* complete. Bit 2026-07-31: `review:security` died mid-response
  on a task reshaping JWT claims; `byLens` showed `security: 0` while packaging and test-strategy returned
  25 findings between them. Presenting that as "the conformance review" would have shipped a claims-bag
  redesign of the access-control path with **no security review at all**. The task notification's
  `agents_error` count is the other tell. Re-run the dead lens before reading anything else.
  - **Re-running one lens costs the whole run.** Cached replay needs `(prompt, opts)` unchanged, and the
    args are embedded in every prompt — so editing `spec`/`priorFindings` to help the re-run invalidates
    every agent. That is not automatically bad: it buys a genuine *second independent pass* (in the same
    incident, pass 2 raised 21 and dropped 4, where pass 1 had dropped 0). Decide which you want, and
    keep args byte-identical if you only want the missing lens.
- **All-design findings with FEW mechanical ones usually means UNDER-SPECIFIED, not sound.** You
  cannot have a wrong line number until you have written a line number. A quiet mechanical layer in
  an early pass is not a clean bill — it is the absence of surface. Expect a second wave once the
  file gets precise, and do not let a low first count argue against re-reviewing later.

⚠️ **Raw count is nearly meaningless on its own.** It tracks the file's specification density and the
sharpness of your lens prompts, not its risk. A *rising* count across passes on a stabilising design
is normal and healthy.

### 4.6 RUN every command-shaped success criterion, and paste the output into the file

⚠️ **This is a mechanical gate, not a judgement call, and it is the single highest-yield step in this
skill per minute spent.** Before "go", take every success criterion in the file that *is* a command —
a `grep`, an `npm ls`, a `node -p`, a `--list`, a file-exists check — and **execute it against the
current tree**. Then either:

- it produces the expected output ⇒ paste the result inline as evidence, or
- it does not ⇒ **the criterion is broken; fix it now.** A criterion whose expected output is
  already false gates nothing, because the builder learns to read past its hits.

**A panel cannot do this for you.** Reviewers judge whether a criterion *reads* falsifiable, which is
a different question from whether it *is*. Both stages will happily approve a command nobody ran.

**Measured on `tasks/archive/nebula-auth-decouple-from-auth.md` (2026-07-31) — a file that had a hand review,
two Stage-1 passes and two Stage-2 passes: SIX of its success criteria could not fail**, all six found
only by executing them during `/build-task` (one by its verifier panel). The failure modes, so you know
what you are looking for:

- **Resolvable ≠ declared.** Two separate `npm ls <pkg> -w <consumer>` criteria, written to prove a
  manifest entry exists. `npm ls` still prints the package and **exits 0** when the entry is deleted,
  because it is reached transitively through a sibling; `--depth=0` does not help. Read the manifest
  with `node -p` instead. ⚠️ And check **both** `dependencies` and `devDependencies` — the first
  version of the fix checked only one, which would have passed while the hazard was restored.
- **A grep whose expected output is already non-empty.** *"`grep -nE 'as any|as unknown as' <file>`
  returns nothing"* — the file held two pre-existing casts unrelated to the thing being banned, so the
  criterion was never satisfiable. Scope the pattern to what you actually mean.
- **A grep that matches prose as well as code.** Fine as a one-time *triage* instruction; useless as a
  re-runnable tripwire. Say which one it is, and give the tripwire form separately.
- **Citing coverage that does not exist.** *"a nested bag would break the guards in `<dir>`"* — the
  guard existed, but the only test exercising it was an unimplemented `TODO`, and the one other
  candidate built its fixture by hand and never called the code under test. **Open the test and
  confirm it runs the path**, don't stop at "a test file mentions this".

Cheap heuristic for the whole step: **if a criterion contains a backtick-quoted command, run it. If it
names a test, open that test.** Anything you cannot run at review time (a `/live` scenario, a full
suite) is exempt — but say so explicitly in the file, so the builder knows which criteria arrive
pre-verified and which do not.

### 5. Resolve in conversation

⚠️ **A finding that the design contradicts the file's own recorded non-goals or prior framing may be evidence the FRAMING is stale, not that the design is wrong** — check the non-goal's date against the design's before treating it as a defect. Panels correctly enforce what a file records, which makes them amplifiers of stale fences: a Stage-2 pass once read a deliberate widening of `/invite` as "a collision to resolve — pick one owner" because the file's old framing invited exactly that reading (recorded in the replaced file; the widening was the goal). Surface such findings as *framing questions for the human*, not as design defects.

Present each stage's synthesized list as it lands (Stage 1 at the gate, Stage 2 at the end). Also surface the `dropped` list briefly — the verify pass errs toward keeping, so anything it dropped was a clear false positive, but a quick scan lets the user veto an over-eager refutation. Work through blockers/majors with the user, propose task-file edits, and re-run a tighter panel (or a fresh human pass) if the design shifted materially. Findings are structured so a follow-up fresh-context pass can quickly see "here's what the panel caught — focus on what they missed."

## When NOT to use
- The spec is still fuzzy/exploratory — fan-out amplifies ambiguity; pin the design first.
- Tiny task files — a single inline read is cheaper than spinning up agents.
- An already-clean, correctly-scoped file — Stage 1 may return nothing structural; say so and go straight to Stage 2. Don't manufacture a rewrite that isn't warranted.

## Calibration
The first time, run it against a *completed* task file where you remember what the loops found — confirm it surfaces the same issues, and that Stage 1 catches the "wait, what are we doing here" framing problems before Stage 2 ever runs. If a lens returns only generic advice, sharpen its `lens` prompt or its rule checklist. Tracked in `tasks/backlog.md` § Testing & Quality (the design record `tasks/archive/task-review-panel.md` is frozen — don't write there).
