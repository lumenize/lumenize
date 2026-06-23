# Nebula — Offline prompt harness (replay bench) — ON HOLD

**Status**: **ON HOLD** (parked 2026-06-23). Designed, partially reviewed (`/review-task` Stage 1 run
2026-06-22), deferred. **Un-park trigger:** the **data-bound generation** work
([`../nebula-pre-alpha.md`](../nebula-pre-alpha.md) Wave 2) is churning and hand-driven / local prompt
iteration has become too slow — then this offline replay bench is the accelerator. Master home:
[`../nebula-pre-alpha.md`](../nebula-pre-alpha.md).

> **Split note (2026-06-23):** this file used to bundle two capabilities. **Turn extraction** ("see the
> turn logs") moved UP into the pre-alpha program as the cross-tenant **turn-log inspection instrument**
> (registry-resolve → super-admin token → fanout `Galaxy.getTurns` → local corpus). What remains here is
> the **offline replay bench** only.

## Objective

Re-run a recorded codegen turn — `(systemPrompt, message, currentSource[, ontology]) → model → output` —
**independently of the browser/Studio**, and **score** the output with the container-free Rung-1 gate
(`compileSource` in `apps/nebula/src/codegen-gate.ts`). A fast, **directional** iterate loop on the
**data-bound** prompt. It is **NOT** the regression suite (that's the parked eval suite,
[`nebula-studio-eval-suite.md`](nebula-studio-eval-suite.md) — shares the `TurnRecord` fixture schema);
this is the exploratory bench.

**Replay is side-effect-free over a frozen fixture** — the `TurnRecord` already carries its own
`currentSource`, so there is **no live state, no git commit/stash/hash, no DO branching**. The gate is a
pure function; `writeFile` is an in-memory Map.

## Settled substrate (reuse — do NOT re-derive)

- **The gate:** `compileSource(path, content)` (`codegen-gate.ts`) — pure, path-dispatched Rung-1 compile
  (`*.d.ts` → ontology gate; `*.vue` → two-pass SFC gate; else write-only).
- **Loop driver + prompt assembly:** `runCodegenLoop` / `assembleCodegenPrompt` (`codegen-loop.ts`) —
  dependency-injected (`callModel` / `writeFile` / `validateToolArgs`); `parseModelTurn` is defensive
  about both the OpenAI `tool_calls` and the `{response}` shapes.
- **The fixture:** the `TurnRecord` (Galaxy `Turns` table) — already replayable; carries `systemPrompt`,
  `userMessage`, `currentSource`, `output`, `reasoning`, `toolCalls`, `error`, `validate`.

## Resolved by the `/review-task` Stage-1 pass (2026-06-22) — fold these in when un-parking

- **S1 [runtime, was BLOCKER]:** the "truly offline / plain-Node `scripts/` tool" premise is
  **verified-false** — `compileSource` → `./galaxy` → `@lumenize/mesh` → `cloudflare:workers`, and
  `codegen-loop.ts` imports `assertSafeRelPath` (a DO file). The gate is standalone *within
  workerd/pool-workers*, NOT plain Node. **Resolution:** the harness is a **vitest-pool-workers project**
  that imports the gate unchanged; the model call is a **real external `fetch` to the Workers AI REST
  API** (pool-workers supports real external fetch) — fully automated, no `wrangler dev`. ("Offline"
  means *browser/Studio-independent*, not *workerd-independent*.)
- **S2 [YAGNI]:** support **single-inference replay only** (one model call, gate once). **Drop full-loop
  replay** — re-running the loop's own already-shipped self-correction stacks non-determinism for no
  decision the bench makes. Fixtures live in a **gitignored scratch dir**; the committed golden set is
  the eval suite's job, not this bench's.
- **M5 [fidelity]:** the harness `callModel` MUST send the identical `CODEGEN_TOOLS` array and parse via
  the same `parseModelTurn`, asserted against a recorded turn's known output shape — else the bench
  measures different model behavior than production. Verify once that the Workers AI **REST** tool-calling
  envelope matches the **AI binding**'s (if it doesn't, that's the fidelity argument to run the model
  call via the binding under `wrangler dev` instead).

## Phases (finalize at un-park)

- **Phase A — single-inference replay:** assemble the prompt from a `TurnRecord` → REST `callModel` →
  `compileSource` on the output → emit `{ output, reasoning, gate:{ok, errorTail} }` + a diff vs the
  recorded output. A known-bad seed (broken source) scores `ok:false` with the actionable tail.
- **Phase B — iterate UX:** swap a system-prompt bundle, replay a set, report compile pass-rate + diffs.
  **Hard boundary:** N-turn pass-rate *gating* belongs to the eval suite (parked), not here — keep this a
  directional read (one candidate, eyeball pass/fail + diff).

## Out of scope

- **Turn extraction** → moved up to the pre-alpha program (the cross-tenant inspection instrument).
- **Regression gates + LLM-judge** → the parked eval suite (`nebula-studio-eval-suite.md`).
- **Rung-2 runtime signal** → when the container path is on the critical path.
