# Nebula Studio Code-Gen Eval Suite

**Status**: On hold — design captured, **not started**. Parked until the resumption trigger below.
**Origin**: Brainstorm session 2026-06-18 (Larry + Claude). No code written; this file is the decision capture.

## Why parked / resumption trigger

The point of an eval suite is **regression detection when the system prompt and/or the generator model change** — not a one-shot decision (that was the [think-vs-cma bake-off](../archive/think-vs-cma-bakeoff.md), already done and archived). Ad-hoc/live-use evaluation is fine *today* because Studio is a solo-dev tool and "live use IS the eval" (see [[kimi-k27-adoption]]). The inflection where that stops paying — and this suite earns its keep — is:

**Un-park when Studio's generation target is real** — i.e. the §5.3.7 SFC substrate (files-as-resources + SFC compile + preview serving) has landed, so the deterministic gates ("compiles / runs in preview") can actually be satisfied, and we start churning the system prompt / bumping the generator model (Kimi K2.x line) / bumping the Think SDK. At that point regressions can silently reach user-developers, and live-use no longer scales (multi-tenant; can't "just use" everyone's apps). That is the safety net live-use can't be.

Until then: deterministic gates can't all be satisfied (no compile/preview), and there's nothing churning to regress against. Don't start early.

## Objective

A standing, all-Cloudflare, **no-Anthropic-per-token** regression suite that gates changes to Studio's code-generation loop (system prompt, generator model, harness/SDK). Deterministic checks do the heavy lifting; an LLM-judge covers only the genuinely-fuzzy "does the generated UI match intent" gate.

## Decisions (pinned in the brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Tool | Evaluate **`vitest-evals`** (+ `@vitest-evals/harness-ai-sdk`) | Slots into our vitest stack; gives reporter + CI summary + tool **record/replay** + inspection UI. Adopt it for the *plumbing*, NOT for the LLM-judge as the headline. |
| Core of the suite | **Deterministic gates first** | Most gates (ontology validates, transaction commits, SFC compiles, feature present) are deterministic state read-back → plain `expect()` assertions, **no model involved**. This is the part the bake-off already hand-rolled as `rubric.ts`. Keep the model-judged surface as small as possible. |
| Where the LLM-judge applies | **Only** the fuzzy "generated UI matches intent" gate | The one deferred quality gate from the bake-off (Kimi UI-gen quality). Everything else stays deterministic. |
| Judge provider path | **Workers AI via `workers-ai-provider` → AI Gateway**, Node-side (`{ accountId, apiKey }`, not a binding) | Eval driver runs Node-side vitest (mirrors `apps/nebula/test/browser/smoke.test.ts`). Routes through our existing AI Gateway for caching / spend caps / cost observability. |
| Judge model | **GLM-5.2** — `@cf/zai-org/glm-5.2`, **pinned**, `temperature: 0` | Different lab/lineage from the Kimi generator (Zhipu vs Moonshot) → breaks "grades its own homework." Capable evaluator (~Opus-4.8 on FrontierSWE; beats GPT-5.5 on SWE-bench Pro) with reasoning modes. Landed on Workers AI 2026-06-16. |
| Generator under test | **Kimi K2.7** (current Studio engine, [[kimi-k27-adoption]]) | The thing being graded. Judge ≠ generator (see invariants). |
| Billing stance | All judging on **Workers AI (Cloudflare bills)**; zero Anthropic per-token | Hard constraint. **AI Gateway is a proxy/observability layer, not a billing route** — routing *to* Anthropic through it is still Anthropic per-token. The no-per-token route = a Workers AI *destination* model. There is **no flat "Claude SDK credits" judge path** (Anthropic API is per-token; the Pro/Max subscription exposes no eval-callable API) — confirmed, don't go looking for it. |
| Cost / determinism in CI | Tool **record/replay** (`VITEST_EVALS_REPLAY_MODE=auto`) | CI reuses recorded outputs instead of paying for inference every run. |

## Invariants (the judge is a fixed ruler)

The suite measures whether the *system under test* moved. That only holds if the judge is held constant:

1. **Pin the judge** — model (`@cf/zai-org/glm-5.2`) + `temperature: 0`. Change it rarely and deliberately; when you do, **re-baseline the whole suite** (a judge change makes old scores incomparable).
2. **Judge ≠ generator, per row.** GLM-as-judge is clean while the generator is Kimi. The moment we A/B **GLM as a *generation* engine**, those rows need a *different* judge (back to self-judging otherwise).
3. **Golden-set canary for judge drift.** Workers AI slugs aren't finely versioned and GLM-5.2 is brand-new (launched at 262k context "with plans to increase" → Cloudflare may swap weights/config under the stable slug). Keep ~5–10 fixed `(output, known-correct-score)` pairs and re-run them every CI pass. If canary scores move, the **judge** drifted (not our system) → re-baseline. Cheap eval-of-the-eval insurance for an un-versioned hosted model.
4. **Decorrelation is partial, not independence.** GLM vs Kimi reduces correlated blind spots; it does not eliminate them (both open-weight frontier models, overlapping benchmark/training pressures). Treat as *less correlated*, not independent.

## Prior art to lift (don't rebuild)

From the bake-off (`experiments/think-vs-cma/`, branch `feat/think-vs-cma-bakeoff` — recover from git history if the worktree was pruned):
- `shared/benchmark-suite.ts` — the 3-app × 5-step scripts as **cases-as-data** (todo / kanban / CRM; cold-gen → add field → change behavior → migration → debug-recover).
- `shared/rubric.ts` — the **deterministic** pass/fail gate. This becomes the `expect()`-based core; no model.
- `shared/cost.ts` — per-turn USD math (note: vitest-evals captures token usage in `task.meta` but the USD/AI-Gateway specifics we still wire ourselves).

Reuse `apps/nebula/test/browser/smoke.test.ts`'s Node-side bootstrap (`bootstrapAdmin` → `HarnessNebulaClient` → `appendOntologyVersion` + `resources.transaction`) as the harness that drives a `.dev` Star.

## What vitest-evals does NOT give us (so we don't expect it)

- **No N-run statistical distributions.** Replay makes runs *deterministic by freezing them* — the opposite of measuring variance. If we ever need "is K2.8 more *reliable* than K2.7" (variance, not regression), that's a separate N-run harness we build ourselves (the bake-off's optional Phase 5 shape). Regression-gating uses thresholds + replay; variance measurement does not.
- **No USD math / CMA / AI-Gateway cost specifics** — usage tokens only.

## Phase sketch (when un-parked)

### Phase 0 — Dependency + provider spike
**Success**: `vitest-evals` + `@vitest-evals/harness-ai-sdk` installed (ask-before-install; verify license is permissive + transitive footprint is Workers-friendly — `ai` and `workers-ai-provider` already present). A trivial `FactualityJudge({ judgeHarness })` runs Node-side against `@cf/zai-org/glm-5.2` through the AI Gateway and returns a score. CF token in `.dev.vars` (never committed), per critical rules.

### Phase 1 — Deterministic gate suite (no model)
**Success**: bake-off `benchmark-suite.ts` cases ported; `rubric.ts` gates expressed as plain `expect()` assertions over a `.dev` Star (ontology validates, transaction commits, SFC compiles, feature present). Green on the current Studio loop. This is the bulk of the value.

### Phase 2 — LLM-judged UI-quality gate **(Exploratory — judge calibration is empirically discoverable)**
**Success**: GLM-5.2 judge scores "UI matches intent" on a small case set; `judgeThreshold` chosen from observed score separation between known-good and known-bad outputs; golden-set canary established. Deliverable includes a captured findings note (chosen threshold, canary set, judge-prompt that worked). Tag matches the §5.3.7 lesson on exploratory phases.

### Phase 3 — CI wiring
**Success**: reporter emits pass/fail to `GITHUB_STEP_SUMMARY`; replay mode keeps CI cost bounded; canary runs every pass; threshold breach fails the check.

## Open questions
- Is GLM-5.2 reliable enough as a *judge* (vs as a coder) at our thresholds? Phase 2 calibration answers this.
- Run the eval Node-side (REST through AI Gateway) vs inside vitest-pool-workers (binding)? Node-side mirrors the proven bake-off driver; default there unless a binding buys something.
- Does `@vitest-evals/harness-ai-sdk`'s harness abstraction map onto our in-workerd / CMA / Think loops, or do we write a custom `createJudgeHarness`/harness adapter? (Likely a thin custom adapter for the *system-under-test* harness; the *judge* harness is standard AI-SDK.)

## Related
- [think-vs-cma bake-off](../archive/think-vs-cma-bakeoff.md) — the one-shot cost decision this suite is **not** (different axis: cost-decision spike vs quality-regression harness).
- Studio master plan / §5.3.7 SFC substrate (the resumption trigger).
- [[kimi-k27-adoption]], [[studio-uibuild-pivot]].
