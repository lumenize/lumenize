# Nebula — Offline prompt harness

**Status**: **DRAFT** (2026-06-22) — needs `/review-task` before `/build-task`. The roadmap's
`⬅ NEXT` after the self-correcting codegen loop (now archived,
[`archive/nebula-codegen-loop.md`](archive/nebula-codegen-loop.md)). Engine roadmap home:
[`nebula-agentic-development-engine.md`](nebula-agentic-development-engine.md) § *Offline prompt harness*.

## Objective

Re-run a codegen turn — `(systemPrompt, message, currentSource[, ontology]) → model → output` —
**independently of the browser/Studio**, replay **recorded turns** as fixtures, and **score** the
output with the **container-free Rung-1 gate** (the standalone `codegen-gate.ts`). The point is a
**fast, independent iterate loop on the data-bound prompt** — the original motivation for the
recorder. It is *not* the regression suite (that's the parked eval suite, which shares this
schema); this is the exploratory bench.

Two capabilities, separable:
1. **Turn extraction** — pull recorded `TurnRecord`s out of the running dev Galaxy into a local,
   inspectable form. *This is also the answer to "can we see the turn logs?"* — the user asked for
   exactly this, and it's the harness's input. **Build this first.**
2. **Offline replay + score** — given a turn (or a hand-authored `(prompt, message, source)`), call
   the model, run the gate, and surface output + compile pass/fail (+ a diff vs the recorded output).

## Settled substrate (what already exists to reuse — do NOT re-derive)

- **Recorder**: `Galaxy.recordTurn`/`getTurns` over the Galaxy DO SQLite `Turns` table; the full
  `TurnRecord` (JSON `payload`) **is** the fixture schema (`systemPrompt`, `userMessage`,
  `currentSource`, `output`, `reasoning`, `toolCalls` incl. each `write_file`'s `{path,content}`,
  `applied`, `error`, `validate`). [galaxy.ts](../apps/nebula/src/galaxy.ts).
- **The gate (the factor-out hook)**: `compileSource(path, content)` in
  [codegen-gate.ts](../apps/nebula/src/codegen-gate.ts) — standalone, pure, container-free, runs
  under vitest-pool-workers (or anywhere with `nodejs_compat` + the bundled tsc). **Import it; never
  re-derive the gate.** (`checkTypeScript` in `@lumenize/ts-runtime-parser-validator` underneath.)
- **The loop driver**: `runCodegenLoop` in [codegen-loop.ts](../apps/nebula/src/codegen-loop.ts) —
  standalone, dependency-injected (`callModel` / `writeFile` / `validateToolArgs`). The harness can
  reuse it with a real-model `callModel`, an in-memory `writeFile`, and the gate — OR run a simpler
  single-shot path for non-loop prompts. Decide in review.
- **Prompt assembly**: `assembleCodegenPrompt` (codegen-loop.ts) — same layered prompt the live loop
  builds, so replays match production.
- **Harness precedent**: `spawnWranglerDev` ([packages/testing/src/spawn-wrangler-dev.ts](../packages/testing/src/spawn-wrangler-dev.ts))
  + the `browser` project's `global-setup.ts` (spawn `wrangler dev`, talk over the network); the
  `createTestRefreshFunction` integration path (mint an admin JWT) is the auth-over-network pattern.

## Open questions — resolve in `/review-task`

| # | Question | Options / lean |
|---|---|---|
| Q1 | **Turn extraction transport** (the empirical unknown) | (a) a **dev-only admin route** on the worker that returns `getTurns` JSON (smallest; needs a dev-gate so it can't ship); (b) **mint an admin JWT over the network** (`createTestRefreshFunction`) + call `getTurns` through the Gateway (reuses the `browser`/`studio-e2e` auth pattern — heavier but no new surface); (c) a **Studio UI "Turns" panel** (product-y, but UI work). *Lean: (b) for the harness proper; (a) as a quick dev affordance if we just want eyes on the corpus now.* |
| Q2 | **Model access** | (a) **Workers AI REST API** directly from Node (CLOUDFLARE_* creds already in `.dev.vars`) — no DO, no wrangler-dev, truly offline; (b) the **`AI` binding under `wrangler dev`**. *Lean: (a) — the harness should not need a running worker just to call the model.* |
| Q3 | **Where fixtures live** | gitignored scratch dir vs a small committed **golden set** (a few representative turns for the eval-suite seed). *Lean: both — scratch for iteration, a curated golden set committed.* |
| Q4 | **Replay shape** | reuse `runCodegenLoop` (full loop, self-correction) vs a **single-inference** replay (one model call, gate once). *Lean: support both — single-inference for prompt A/B, full-loop for end-to-end.* |
| Q5 | **Determinism** | runs vary run-to-run (recorder note); the harness is **directional**, not assertion-grade — scoring = compile pass/fail + a human/diff read, NOT brittle equality. The eval suite (parked) owns regression + the LLM-judge. Confirm the boundary so we don't rebuild the eval suite here. |
| Q6 | **Node script vs vitest project** | a standalone `scripts/` Node tool vs a `--project offline-harness` vitest project. *Lean: script — it's a bench, not a test; but reuse `@lumenize/testing` helpers.* |

## Phases (provisional — finalize in review)

### Phase 1 — Turn extraction (the "see the turn logs" slice)
**Goal**: Pull recorded `TurnRecord`s out of the running dev Galaxy into local JSON (list + by-id),
so the corpus is inspectable (by a human AND by an assistant reading the file).
**Success criteria** (draft): list turns for a `{u}.{g}` galaxy with `since`/`limit`; dump a turn's
full record incl. each `write_file`'s content; round-trips the recorder schema unchanged; the
transport (Q1) carries an admin identity (no prod backdoor — security.md).

### Phase 2 — Offline replay + gate score
**Goal**: Given a turn or a hand-authored input, re-assemble the prompt, call the model (Q2), run
`compileSource` on the output, and emit `{ output, reasoning, gate: {ok, errorTail} }`.
**Success criteria** (draft): a recorded turn replays to a fresh model output that the gate scores;
re-uses `assembleCodegenPrompt` + `compileSource` (no re-derivation); works with no running worker
(if Q2=REST); a known-bad replay (seeded broken source) scores `ok:false` with the actionable tail.

### Phase 3 — Iterate UX + diff
**Goal**: Make it a fast bench: swap a system-prompt bundle, replay a set, see compile pass-rate +
diffs vs recorded output. Grows toward the eval suite (shared schema).
**Success criteria** (draft): run N turns against a candidate prompt, report compile pass/fail per
turn + a unified diff vs the recorded output; the golden set (Q3) is the seed.

## Out of scope / forward-pointers
- **The eval suite** (regression gates + LLM-judge, GLM-5.2) — parked
  [`on-hold/nebula-studio-eval-suite.md`](on-hold/nebula-studio-eval-suite.md); shares this schema,
  un-park when the prompt stabilizes.
- **Data-bound generation prompt content** — the *consumer* of this bench (exploratory); not built here.
- **Rung-2 runtime signal** — the gate here is Rung-1 (compile) only, same as the loop.

## Notes
- The user explicitly asked for turn-log visibility (2026-06-22) — Phase 1 *is* that. It also
  closes the "thinner thought process" gap (the full generated code lives in `toolCalls`, viewable
  via an extracted turn even when the live thought panel summarizes).
- Auth-over-network (Q1) is the one empirical unknown — tag Phase 1 **exploratory** if it needs
  spiking (mirrors the loop's §v4 WS-disconnect tooling).
