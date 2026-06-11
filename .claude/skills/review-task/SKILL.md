---
name: review-task
description: Fan out a panel of specialized reviewers over a task file BEFORE implementation — architecture/mesh, security, test-strategy, and product lenses, each checking against the relevant .claude/rules/; an adversarial pass then refutes weak findings before they're synthesized into one ranked list. Use when a task file is ready for design review, when the user says "review the X task", or before saying "go" on implementation.
---

# Review Task

Replaces the expensive serial "run the task file through fresh contexts repeatedly" loop with **one parallel pass** of specialized reviewers, followed by an **adversarial verify pass** that kills false positives before you ever see them. This is the highest-leverage fan-out in the docs-first cycle — catching design drift here is what makes implementation near-transcription. It **reduces** review loops (~5–8 → ~1–2), it doesn't replace them: expect 1–2 fresh human-led passes after to catch what anchored reviewers miss.

## Usage
`/review-task <path-to-task-file>` (defaults to the active task file if omitted).

## Procedure

### 1. Scout the spec (inline, before any fan-out)
Read the task file **and everything it depends on**: linked sub-task files, referenced `/website/docs/*` pages, and any pseudo-code/interface it cites. Concatenate into one spec string. Reviewers can't review what they can't see, and a fan-out over a half-read spec wastes agents.

Also read `docs/adr/*.md` (architecture commitments) and append them to the spec under an `ADRs:` heading. Design review is where ADR conflicts get caught — `/build-task` deliberately does not re-check them. A design that conflicts with an ADR is a blocker unless the task file explicitly proposes superseding that ADR.

If the user pasted "already caught" findings from a prior loop, collect them as `priorFindings` so reviewers don't repeat them.

### 2. Run the review panel (Workflow)
Author and run this Workflow (adapt the lenses to the task — drop `security` for a pure refactor; for raw-DO-infrastructure tasks swap the architecture lens's `mesh.md` for `raw-comm.md`, per the layer map in `workers-projects.md`; etc.). Each lens is handed its rule file as the checklist, so the rules are the single source of truth. Three phases: **Review** (one reviewer per lens) → **Verify** (a skeptic tries to refute each finding, dropping false positives and correcting severities) → **Synthesize** (dedup + rank the survivors). Review→Verify is a pipeline — a lens's findings get refuted the moment that lens finishes, so a slow lens never blocks a fast one's verification. The verify pass is tuned to err toward *keeping* (it only drops clear false positives), and every dropped finding is reported back so you can veto an over-eager refutation. Pass `args` as `{ taskFile, spec, priorFindings }` — the script normalizes it whether the harness delivers an object or a JSON-encoded string.

```javascript
export const meta = {
  name: 'review-task',
  description: 'Fan out specialized reviewers over a task file before implementation',
  phases: [
    { title: 'Review', detail: 'one reviewer per lens, each with its rules as checklist' },
    { title: 'Verify', detail: 'skeptic refutes each finding; drop false positives, correct severities' },
    { title: 'Synthesize', detail: 'dedup + rank the surviving findings' },
  ],
}

// args may arrive JSON-encoded as a string (harness serialization) — normalize before use.
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {})
const TASK_FILE = A.taskFile
const SPEC = A.spec                  // task file + linked sub-tasks + docs, pre-read in step 1
const PRIOR = A.priorFindings ?? ''  // findings already caught in earlier loops

const LENSES = [
  { key: 'architecture', rules: '.claude/rules/mesh.md + .claude/rules/durable-objects.md',
    lens: 'Mesh-pattern + DO-architecture review. Flag pseudo-code that drops to raw Workers RPC instead of lmz.call/ctn; async in business logic; mutable instance-variable state; cross-package dependency pointing "up" (mesh → nebula); and feasibility ("this needs async in a sync method — won\'t work").' },
  { key: 'security', rules: '.claude/rules/security.md',
    lens: 'Lumenize-specific security (not generic OWASP). Missing JWT/scope checks, resource operations with no DAG permission check, sandbox-escape via the proposed API, test-mode flags reachable in prod, trust-boundary crossings where the receiver does not re-validate.' },
  { key: 'test-strategy', rules: '.claude/rules/testing.md',
    lens: 'WHAT to test, not whether tests follow patterns. Are success criteria testable? for-docs mini-app vs isolated test? Untestable claims in pseudo-code? Missing scenarios the task file omits: error paths, concurrent access, eviction recovery.' },
  { key: 'product', rules: 'CLAUDE.md (repo root — project intro/principles) + tasks/README.md',
    lens: 'Nebula vision & ergonomics for user-developers. Walled-garden violations (escape hatches, more than one right way, footguns left in), API-surface ergonomics, scope creep / premature generalization, task-file template conformance, phases that are step-lists instead of goals + success criteria.' },
]

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['severity', 'category', 'location', 'finding', 'suggestion'],
    properties: {
      severity: { enum: ['blocker', 'major', 'minor', 'nit'] },
      category: { type: 'string' },
      location: { type: 'string' },   // section/heading in the task file
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
    `The spec ends with the repo's ADRs (architecture commitments) — flag any conflict with an ADR as a ` +
    `blocker unless the task file explicitly proposes superseding it.\n` +
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
      `out of scope for this task, or not actually a rules violation. If it is real, set stands=true and ` +
      `optionally correct its severity via adjustedSeverity. Do NOT drop a finding merely because you are ` +
      `unsure — err toward keeping. One-line rationale.\n\nSPEC:\n${SPEC}`,
      { label: `verify:${l.key}`, phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, lens: l.key, verdict: v })))))

// Barrier: dedup + rank needs ALL surviving findings together.
const all = reviewed.flat().filter(Boolean)
const survivors = all.filter(f => f.verdict?.stands)
  .map(f => ({ ...f, severity: f.verdict.adjustedSeverity ?? f.severity }))
const dropped = all.filter(f => !f.verdict?.stands)

phase('Synthesize')
const synthesis = await agent(
  `Synthesize these ${survivors.length} verified design-review findings into ONE ranked list. ` +
  `Dedup near-identical items across lenses, group by severity (blocker → nit), keep location + suggestion for each, ` +
  `and end with a 2–3 line "biggest risks" summary.\n\n${JSON.stringify(survivors, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize' })

return {
  byLens: LENSES.map(l => ({ lens: l.key, n: all.filter(f => f.lens === l.key).length })),
  raised: all.length,
  survived: survivors.length,
  dropped: dropped.map(f => ({ lens: f.lens, location: f.location, finding: f.finding, why: f.verdict?.rationale })),
  synthesis,
}
```

### 3. Resolve in conversation
Present the synthesized list. Also surface the `dropped` list briefly — the verify pass errs toward keeping, so anything it dropped was a clear false positive, but a quick scan lets the user veto an over-eager refutation. Work through blockers/majors with the user, propose task-file edits, and re-run a tighter panel (or a fresh human pass) if the design shifted materially. Findings are structured so a follow-up fresh-context pass can quickly see "here's what the panel caught — focus on what they missed."

## When NOT to use
- The spec is still fuzzy/exploratory — fan-out amplifies ambiguity; pin the design first.
- Tiny task files — a single inline read is cheaper than spinning up agents.

## Calibration
The first time, run it against a *completed* task file where you remember what the loops found — confirm it surfaces the same issues. If a lens returns only generic advice, sharpen its `lens` prompt or its rule checklist. Tracked in `tasks/on-hold/task-review-panel.md`.
