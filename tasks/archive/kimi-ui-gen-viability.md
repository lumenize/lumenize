# Kimi UI-Gen Viability (Studio generation gate)

**Status**: Active — the generation-viability gate; a prerequisite to planning Studio. This is an exploratory spike — expect the approach to deviate as we learn; not for hand-review.

**Context**: the generation-viability de-risk for Studio, with the chosen model (Kimi 2.7 via Workers AI — `tasks/nebula-studio-llm-strategy.md`). The Think-vs-CMA bake-off proved **ontology + typed-data** generation only; **UI generation was the explicitly-deferred gate** ("when the SFC substrate ships"). That substrate is now near (frontend merged; files-as-resources + SFC compile = build-seq #1 in `tasks/nebula-studio.md`).

## Progress

**Stage A — compile mechanism: DONE + verified 2026-06-16.** The SFC→runnable-ESM pipeline (the spike's documented gap) works: `@vue/compiler-sfc` macro resolution → `typescript` TS-strip → non-inline module assembly. Code: `apps/nebula/spike/sfc-devstar-loop/src/compile-module.ts` (pure `compileSFCToModule`); test: `test-node/compile-module.test.ts` (4 tests, **mutation-checked** — disabling the transpile correctly fails the residual-TS assertion). Full spike suite green (10 tests).
- ⚠️ **Finding: raw `import ts from 'typescript'` crashes the workerd isolate** ("Worker exited unexpectedly") — verified. So the transpile can't live in the DO module as-is; for the spike it runs in **Node**. When this pipeline moves into the DevStar (build-seq #1), tsc must be **bundled for workerd** via the validator's proven `packages/ts-runtime-parser-validator/scripts/bundle-tsc.mjs` pattern. The transpile+assembly logic is identical regardless of where tsc runs.
- **Deferred:** T3 "runs/reacts" (needs the real reactive `store` proxy from the frontend factory) — a green Stage A means "Kimi's SFC+`.d.ts` compiles to a structurally-valid module," not "runs in preview."

**Stage B — one-shot Kimi generation: DONE 2026-06-16. Strong green.** Probe: `apps/nebula/spike/sfc-devstar-loop/probes/kimi-gen-probe.ts` (Node; Workers AI REST via the account global key → `compile-module.ts`). Given a condensed-but-faithful `coding-your-ui.md` system prompt + "build a todo app," Kimi 2.7 produced a **well-formed, compilable** `App.vue` + `ontology.d.ts` on the first shot — **compiled clean** through the Stage-A pipeline (1763-char script → 4738-char assembled ESM).
- **Model slug confirmed: `@cf/moonshotai/kimi-k2.7-code`** works on Workers AI; returns the **OpenAI-style shape** (`result.choices[0].message.content`, not `result.response`).
- **What Kimi got right (unprompted on specifics):** `store.resources.<rt>[id].value` auto-subscribe paths; `import { store, client } from './nebula'`; `client.claims.sub` per-user keying; container-resource list pattern (`items: string[]` of ids); **v-model guarded by `v-if`** (the documented requirement); client-side `computed` for the open-count aggregate (exactly as the doc steers); atomic create-todo-+-append-to-list in one `transaction`; DaisyUI classes throughout.
- **The one real bug the experiment surfaced:** Kimi invented `op: 'set'` for transaction ops — the real vocabulary is `'create'` / `'put'`. **Compile can't catch this** (it's a runtime API contract, not syntax) — exactly the class of error the **error-tail/self-correction loop** (and feeding the real Nebula API `.d.ts` as context, per nebula-studio.md § "Nebula API types as LLM context") is for. Not a capability gap; a prompt-completeness gap.
- **Caveat:** single run (Kimi varies run-to-run — an earlier run wired a `newTitle` input + form; this one hardcoded the title). Directional, not statistical. Verdict: **Kimi UI-gen is viable**; the remaining work is API-vocabulary precision (prompt/few-shot + the iterate-on-errors loop), not raw generation ability.

**Stage C — thin iterate-on-errors loop (no Think): DONE 2026-06-16. Green.** Probe: `probes/kimi-loop-probe.ts` (~50-line Node loop; check = Stage-A compile + an API-op lint standing in for platform transaction validation). Round 1 reproduced the `op:'set'` bug; fed the error back; Kimi **self-corrected** to `create`/`put`; round 2 clean — **converged in 2 rounds**. (One earlier run produced unparseable free-form output — motivating structured tool-calling over regex-on-prose.)

**Substrate verifications (2026-06-16):**
- **Native tool-calling works** on `kimi-k2.7-code` (`finish_reason: tool_calls`, structured call) — the robust loop uses tool-calls, not prose parsing. No Think needed.
- **`@cloudflare/codemode` is standalone** (no Think dep; core = `DynamicWorkerExecutor` + a `LOADER` binding) but its tool bridge is **JSON-only** — an ADR-002 violation, so **dropped**. Its MCP→TS layer is real but redundant (we hand the agent our `.d.ts` directly).
- **DO facets are independent of dynamic workers** (proven by `packages/ts-runtime-parser-validator/src/facet-helper.ts` + the agents SDK's static-class facets) — a loader is needed only for a *runtime-generated* facet class; co-location gives the latency win regardless. A Nebula-owned static-class facet = isolated, eyeball-local agent home, no loader.

**Decided stack:** Kimi 2.7 (Workers AI, binding mode) + thin native-tool-calling loop + Galaxy memory + Mesh WS streaming (later) + agent-home in a Nebula-owned facet. **No Think, no codemode.** Path 2 (script-per-step in a facet sandbox with a mesh/full-type bridge) is a pocketed cost/latency optimization — and the substrate for the post-Studio in-app RAG chat feature.

## Goal

Find out whether Kimi 2.7, given `website/docs/nebula/coding-your-ui.md` + the current ontology + the Nebula API `.d.ts` as context, can generate **working `.vue` SFCs + `.d.ts` ontology** that:
- compile in the dev Star (`DevStar.compileSFC`),
- run in preview,
- with reactivity and access control intact.

This is the single biggest "is Studio even viable" question. If Kimi can reliably produce working ontology + UI against the live platform, Studio is a wrapper around a proven loop. If it can't, no chat-UI polish saves it.

## Loose approach (will evolve)

- Drive Kimi through the three small apps already named as the stop-point (todo / kanban / simple CRM), UI + ontology, via the proven in-DO shim / Think harness (or a thinner harness if that's faster to iterate).
- Run the iteration loop, not just cold-gen: add a field, change behavior, an ontology edit, a deliberately-broken step.
- **Fold in a real error tail** — wire `get_recent_errors` / the debug-tail (`tasks/nebula-studio.md` § Remote Debug Tail); the bake-off had nothing for the agent to read. See whether Kimi self-corrects from it.

## Dependencies / sequencing

Needs build-seq #1 (files-as-resources + SFC compile in `DevStar`). Can start **thin** against the existing spike (`apps/nebula/spike/sfc-devstar-loop/`) before the full pipeline lands.

## Thin-probe scope (spike + harness recon, 2026-06-16)

**Spike compile state** (`apps/nebula/spike/sfc-devstar-loop/src/galaxy.ts:12-70`): `compileSFC` is a 3-call `@vue/compiler-sfc` wrapper (`parse` → `compileScript` → `compileTemplate` + `compileStyle`) returning `{script, template, styles[], errors[]}` as **separate strings**. Two gaps before it yields runnable JS:
1. **No TS→JS transpile** — `@vue/compiler-sfc` resolves Vue macros but leaves non-macro TS (`interface`, `: T`) in `script` (proven by `test/kill-criterion.test.ts:91-97`, `RESULTS.md:42-54`).
2. **No module assembly** — the blocks aren't stitched into one importable ESM (script default export + render fn + scoped-style injection).

**The fix is small:** add a `ts.transpileModule(...)` stage (~15 lines, `target: ESNext`) after `compileScript`. `typescript@5.9.3` is already a spike devDep. Precedent that the TS compiler runs inside a workerd DO: `packages/ts-runtime-parser-validator` (full Program API; `scripts/bundle-tsc.mjs` is the escape hatch if standalone `transpileModule` needs bundling). `transpileModule` is a lighter subset → likely runs with no bundling.

**Stub file-writing — do NOT build files-as-resources.** Cheapest stand-in: an in-DO `Map<path,string>` + a `write_file({path,content})` tool. The `.d.ts` feeds the **existing** `register_ontology_version` tool (already takes a `.d.ts` string — `shared/tool-surface.ts:92-107`; the eager validator compile is a real signal); the `.vue` feeds a new `compile_app()` tool over `compileSFC`.

**Verification tiers** (pick by time-box): **T1 compiles** (`errors.length===0` + no residual TS) — cheapest real signal; **T2 assembles** into a loadable ESM (parse via `import()` of a data: URL); **T3 runs/reacts** — needs the real reactive `store` proxy (lives in the frontend factory, not the spike) → **defer** (preview-serving is out of scope, `RESULTS.md:97-101`). **Recommend T1+T2** — a green probe means "Kimi produces compilable SFC + `.d.ts`," not "the app runs in preview."

**Harness** (ports ~1:1 from the bake-off worktree `.claude/worktrees/think-vs-cma/experiments/think-vs-cma/`): reuse `think/src/studio-think-agent.ts` (`StudioThinkAgent extends Think<Env>`, Kimi via `createWorkersAI({binding:env.AI, gateway:{id:'think-vs-cma'}})`) + `think/src/in-do-executor.ts` (in-DO NebulaClient over the `fetch-ws` shim) + `shared/tool-surface.ts`. Changes: **(a)** bump the model const `@cf/moonshotai/kimi-k2.5` → the Kimi 2.7 slug (confirm the exact `@cf/moonshotai/...` id on Workers AI — the one model-wiring unknown); **(b)** swap the codemode system prompt for one handing the model `coding-your-ui.md` patterns + the current ontology (the agent already injects the ontology each turn); **(c)** add `write_file` + `compile_app` tool specs (the loop turns any spec into an AI-SDK tool generically). The **WS shim is droppable** if the probe only compiles locally; **keep it** if you want the `.d.ts` to actually round-trip ontology registration. First-signal minimum: one app (todo), one cold-generate step.

## Open questions (resolve by doing)

- Prompt shape + how much hand-holding Kimi needs for SFCs vs. the (already-good) ontology gen.
- Does codemode generalize from data ops to UI gen, or does UI want a different tool surface?
- Is the error-tail signal good enough for self-correction, or does it drown the model?
- Quality bar: "compiles + runs + feature present + access control enforced" as the completed-gate (not a quality score).
