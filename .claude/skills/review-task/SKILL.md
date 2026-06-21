---
name: review-task
description: Two-stage panel review of a task file BEFORE implementation. Stage 1 (framing & scope — archaeology/altitude, YAGNI + intermediate-goal scoping, product vision) is resolved and the file edited FIRST; Stage 2 (conformance — architecture/mesh, security, test-strategy) then reviews the cleaned file. Each stage adversarially verifies findings before you see them. Use when a task file is ready for design review, when the user says "review the X task", or before saying "go" on implementation.
---

# Review Task

Replaces the expensive serial "run the task file through fresh contexts repeatedly" loop with **two parallel passes** of specialized reviewers, each followed by an **adversarial verify pass** that kills false positives before you see them. This is the highest-leverage fan-out in the docs-first cycle — catching design drift here is what makes implementation near-transcription. It **reduces** review loops (~5–8 → ~2), it doesn't replace them: expect a fresh human-led pass after to catch what anchored reviewers miss.

**Why two stages.** Don't run detailed mesh/security/test checks against prose you're about to delete. A single combined pass anchors low-level findings to text that a framing fix is about to rewrite — wasted agents, and findings that clash with a reviewer (human or model) whose head is still at altitude. So **Stage 1 settles *what the file should be* (shape, scope, framing) and the file is edited, *then* Stage 2 checks *whether its lines follow the rules*.** Altitude before detail.

## Usage
`/review-task <path-to-task-file>` (defaults to the active task file if omitted).

## Procedure

### 1. Scout the spec (inline, before any fan-out)
Read the task file **and everything it depends on**: linked sub-task files, referenced `/website/docs/*` pages, and any pseudo-code/interface it cites. Concatenate into one spec string. Reviewers can't review what they can't see, and a fan-out over a half-read spec wastes agents.

Also read `docs/adr/*.md` (architecture commitments) and append them to the spec under an `ADRs:` heading. Design review is where ADR conflicts get caught — `/build-task` deliberately does not re-check them. A design that conflicts with an ADR is a blocker unless the task file explicitly proposes superseding that ADR.

Also read `docs/vision/*.md` (product strategy — `strategy.md` is the canonical positioning + strategic guardrails; siblings like `enterprise.md` add segment-specific lenses) and append them under a `Product strategy:` heading. The Stage-1 product-vision lens checks the task against these guardrails; like ADRs, `/build-task` does not re-check them. A design that violates a strategy guardrail is a framing blocker unless the task explicitly argues for changing the strategy.

If the user pasted "already caught" findings from a prior loop, collect them as `priorFindings` so reviewers don't repeat them.

### 2. Stage 1 — Framing & scope (Workflow), resolved BEFORE conformance
Run the Workflow below with `args.stage = 'framing'`. This is the altitude pass: **spec-hygiene** (write-for-a-cold-implementer; reversed-decision archaeology → positive rewrite; goals-not-step-lists; spec-density; single-source-of-truth), **scope-discipline** (YAGNI / premature generalization; intermediate-goal alignment; correct deferral; build-order / prerequisites), and **product-vision** (walled-garden, footguns, ergonomics). Its output is dominated by **structural** findings — "rewrite this section/file positively", "cut or defer this scope" — not line-nits.

### 3. Gate — resolve Stage 1 and edit the file (this is the cure, not the catch-net)
Present the Stage-1 synthesis. Work through it with the user and **make the edits**: positive rewrites, scope-cuts, deferrals to on-hold files with a one-line pointer left behind. The file should leave this gate clean and correctly scoped. If Stage 1 surfaced nothing structural, say so and proceed.

**Then decide whether the file needs Stage 1 *again* before Stage 2 — by HOW MUCH it changed, not just that it changed:**
- **Light fix-application edits** (you applied Stage-1's suggestions roughly as given — a rewrite here, a deferral there, within the same shape) → **RE-SCOUT** (step 1; the spec string is now stale) and proceed to **Stage 2** on the revised file.
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
  { key: 'scope-discipline', rules: 'CLAUDE.md (repo root) + tasks/README.md',
    lens: 'Is this scoped to what we actually need NOW? Flag YAGNI / premature generalization — a general mechanism built for a hypothetical future, especially machinery whose only consumer is a test fixture or "some future X". Flag INTERMEDIATE-GOAL ALIGNMENT — work exceeding what the current milestone (e.g. the demo) needs, or milestone-critical work conflated with post-milestone work. Flag CORRECT DEFERRAL — post-goal work entangled in the active path instead of split to an on-hold file with a pointer. Flag BUILD-ORDER / PREREQUISITES — is the file sequenced right against its dependencies, are blockers named and ordering correct (a prerequisite task that must ship first). The fix is usually a scope-cut or a deferral, not more spec.' },
  { key: 'product-vision', rules: 'docs/vision/strategy.md + docs/vision/enterprise.md + CLAUDE.md (repo root) + tasks/README.md',
    lens: 'Nebula product strategy & ergonomics for user-developers. Check the task against the STRATEGIC GUARDRAILS in docs/vision/strategy.md (and enterprise.md): trades away security defaults for speed/flexibility; optimizes a vanity metric (forks/trending) or builds density-dependent features before single-player value exists; assumes multi-user/collaboration as a primary persona (it is ~90% solo); weakens the "get-paid" path; erodes deployment homogeneity (escape hatches, "deploy elsewhere", per-app infra divergence); treats discovery as a someday problem (no anti-slop story); builds enterprise-governance surface (SSO/audit/admin/org controls) before the self-serve wedge is proven. PLUS the classic walled-garden/ergonomics checks: footguns left in rather than removed, more-than-one-right-way, API-surface ergonomics, task-file template conformance. A design that violates a strategy guardrail is a framing blocker unless the task explicitly argues for changing the strategy. Guard against footguns by removing them, not documenting them.' },
]

// Stage 2 — conformance: check the cleaned file against the rules (rules = source of truth).
// For raw-DO-infrastructure tasks, swap the architecture lens's mesh.md for raw-comm.md
// (per the layer map in workers-projects.md); drop security for a pure refactor; etc.
const CONFORMANCE_LENSES = [
  { key: 'architecture', rules: '.claude/rules/mesh.md + .claude/rules/durable-objects.md',
    lens: 'Mesh-pattern + DO-architecture review. Flag pseudo-code that drops to raw Workers RPC instead of lmz.call/ctn; async in business logic; mutable instance-variable state; cross-package dependency pointing "up" (mesh → nebula); and feasibility ("this needs async in a sync method — won\'t work").' },
  { key: 'security', rules: '.claude/rules/security.md',
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
        `blocker unless the task file explicitly proposes superseding it.\n`
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

### 5. Resolve in conversation
Present each stage's synthesized list as it lands (Stage 1 at the gate, Stage 2 at the end). Also surface the `dropped` list briefly — the verify pass errs toward keeping, so anything it dropped was a clear false positive, but a quick scan lets the user veto an over-eager refutation. Work through blockers/majors with the user, propose task-file edits, and re-run a tighter panel (or a fresh human pass) if the design shifted materially. Findings are structured so a follow-up fresh-context pass can quickly see "here's what the panel caught — focus on what they missed."

## When NOT to use
- The spec is still fuzzy/exploratory — fan-out amplifies ambiguity; pin the design first.
- Tiny task files — a single inline read is cheaper than spinning up agents.
- An already-clean, correctly-scoped file — Stage 1 may return nothing structural; say so and go straight to Stage 2. Don't manufacture a rewrite that isn't warranted.

## Calibration
The first time, run it against a *completed* task file where you remember what the loops found — confirm it surfaces the same issues, and that Stage 1 catches the "wait, what are we doing here" framing problems before Stage 2 ever runs. If a lens returns only generic advice, sharpen its `lens` prompt or its rule checklist. Tracked in `tasks/backlog.md` § Testing & Quality (the design record `tasks/archive/task-review-panel.md` is frozen — don't write there).
