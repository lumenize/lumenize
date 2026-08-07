# Nebula Studio Self-Improvement Loop

**Status**: DESIGN — captured, gated, **not started**. Larry's *primary* self-improvement track.
**Created**: 2026-07-05 (brainstorm: Ornith reframe → "self-improving *system*, not *model*").
**Absorbs**: the former `tasks/on-hold/nebula-studio-eval-suite.md` (deleted 2026-07-05) as its **reward-function core** — the deferred DevStar→Star@.dev / vite-build realignment is discharged here, not carried forward.
**Governing vision**: [`docs/vision/self-improving-platform.md`](../docs/vision/self-improving-platform.md) — the moat, the bounded claim, the timing gates. *This* file is the mechanics.

> **One-line frame.** Evolve Studio's *generation scaffold* (prompts, skills, exemplars, secure-default templates) from real-world **outcome signal**, using a **frozen** base model — no training, no GPU. A scorer (the eval, absorbed below) + an optimizer (scaffold evolution) + its own scheduled cadence.

---

## Relationship to `nebula-nightly-loop.md` — a DIFFERENT loop, kept separate

This is **not** the [`nebula-nightly-loop`](nebula-nightly-loop.md). They share a *pattern* and nothing else:

| | `nebula-nightly-loop` | **this file** |
|---|---|---|
| **Target** | Lumenize's *own source* (code/spec review) | *Studio's codegen scaffold* |
| **Reward** | Larry's judgment at 8am | the eval harness (below) + eventually economic signal |
| **Meter** | Larry's subscription | Workers AI (Cloudflare bills) |
| **Trust** | exercised once, not yet trusted | primary track, built fresh |
| **Safety model** | protect Larry's repo + token window | protect *user-developers* + tenant isolation |

Shared pattern only: **scheduled sense → propose → human-gate → act, human-hold-the-criteria, proposal-only by default.** Keep the two files separate; do not entangle this with the not-yet-trusted repo loop. "A nightly loop" is *one cadence of this pattern*, not that other file.

---

## The loop (Ornith at the orchestration layer)

Ornith co-evolves scaffold + solution inside model weights via RL. We lift that to orchestration and keep the model frozen:

1. **Generate** — Studio produces an app conditioned on the current *scaffold* + retrieved past winners.
2. **Score** — the eval harness (reward function, below) gates the result: deterministic checks + a fuzzy UI-intent judge.
3. **Attribute** — log `(task → scaffold-version → outcome)`; credit-assign via the non-destructive history substrate (ADR-004).
4. **Evolve** — promote scaffolds correlated with good outcomes; prune/mutate the losers. **Promotion is human-gated** and never reaches user-developers un-scored.

**What "the scaffold" is** (versioned units — granularity is an open question): the system prompt, the `SKILL.md` tier ([`nebula-skills.md`](nebula-skills.md)), retrieved few-shot exemplars, tool-call sequences, and the secure-default templates. The base model stays frozen and swappable (today a Kimi-class model via `env.AI`).

---

## Part A — The reward function (absorbed eval suite)

> A standing, **all-Cloudflare, no-Anthropic-per-token** harness. It is the *fixed ruler* the optimizer optimizes against — and, standalone, the **regression gate** for any change to the generation loop (system prompt, generator model, skills, harness/SDK). Deterministic checks do the heavy lifting; an LLM-judge covers only the genuinely-fuzzy "does the generated UI match intent" gate. **Nothing self-improves without this; build it first.**

### Decisions (pinned in the 2026-06-18 brainstorm; still hold)

| Decision | Choice | Rationale |
|---|---|---|
| Tool | **`vitest-evals`** (+ `@vitest-evals/harness-ai-sdk`) | Slots into our vitest stack; reporter + CI summary + tool **record/replay** + inspection UI. Adopt for the *plumbing*, not for the LLM-judge as the headline. |
| Core | **Deterministic gates first** | Most gates (ontology validates, transaction commits, **vite build succeeds**, feature present) are deterministic state read-back → plain `expect()`, **no model**. This is the bulk of the value; keep the model-judged surface minimal. |
| LLM-judge scope | **Only** the fuzzy "generated UI matches intent" gate | The one deferred quality gate from the bake-off. Everything else stays deterministic. |
| Judge provider | **Workers AI via `workers-ai-provider` → AI Gateway**, Node-side (`{ accountId, apiKey }`, not a binding) | Eval driver runs Node-side vitest (mirrors `apps/nebula/test/browser/smoke.test.ts`). Routes through AI Gateway for caching / spend caps / cost observability. |
| Judge model | **GLM-5.2** — `@cf/zai-org/glm-5.2`, **pinned**, `temperature: 0` | Different lab/lineage from the Kimi generator (Zhipu vs Moonshot) → breaks "grades its own homework." Capable evaluator; landed on Workers AI 2026-06-16. |
| Generator under test | **Kimi K2.7** (current Studio engine, [[kimi-k27-adoption]]) | The thing being graded. Judge ≠ generator (invariants below). |
| Billing | All judging on **Workers AI (Cloudflare bills)**; zero Anthropic per-token | Hard constraint. The no-per-token route = a Workers AI *destination* model; there is **no flat "Claude SDK credits" judge path** — confirmed, don't go looking. ⚠️ **The old reason for that was "AI Gateway is not a billing route", which stopped being true 2026-08-07** (unified billing, now including Workers AI). It *is* a billing route — it just isn't a *flat* one: provider per-token rates are passed through, so paying Anthropic in Cloudflare credits is still Anthropic per-token. Same conclusion, different premise; don't restore the old clause. |
| CI determinism | Tool **record/replay** (`VITEST_EVALS_REPLAY_MODE=auto`) | CI reuses recorded outputs instead of paying for inference every run. |

### Invariants (the judge is a fixed ruler)

The suite measures whether the *system under test* moved. That only holds if the judge is held constant:

1. **Pin the judge** — model + `temperature: 0`. Change rarely and deliberately; when you do, **re-baseline the whole suite** (a judge change makes old scores incomparable).
2. **Judge ≠ generator, per row.** GLM-as-judge is clean while the generator is Kimi. The moment we A/B **GLM as a *generation* engine**, those rows need a *different* judge.
3. **Golden-set canary for judge drift.** Workers AI slugs aren't finely versioned and GLM-5.2 is new (CF may swap weights under the stable slug). Keep ~5–10 fixed `(output, known-correct-score)` pairs; re-run every CI pass. Canary scores move ⇒ the **judge** drifted → re-baseline.
4. **Decorrelation is partial, not independence.** GLM vs Kimi reduces correlated blind spots; both are open-weight frontier models with overlapping pressures. *Less correlated*, not independent.

### Prior art to lift (don't rebuild)

From the bake-off (`experiments/think-vs-cma/`, branch `feat/think-vs-cma-bakeoff` — recover from git history if pruned):
- `shared/benchmark-suite.ts` — the 3-app × 5-step scripts as **cases-as-data** (todo / kanban / CRM; cold-gen → add field → change behavior → migration → debug-recover).
- `shared/rubric.ts` — the **deterministic** pass/fail gate → the `expect()`-based core; no model.
- `shared/cost.ts` — per-turn USD math (vitest-evals captures token usage in `task.meta`; the USD/AI-Gateway specifics we wire ourselves).

Harness: reuse `apps/nebula/test/browser/smoke.test.ts`'s Node-side bootstrap (`bootstrapAdmin` → `HarnessNebulaClient` → `resources.transaction`) to drive a `.dev` Star. *(Realignment discharged: `appendOntologyVersion` dropped from the harness.)*

### What vitest-evals does NOT give us

- **No N-run statistical distributions.** Replay freezes runs — the opposite of measuring variance. "Is K2.8 more *reliable* than K2.7" (variance, not regression) is a separate N-run harness we build ourselves.
- **No USD math / CMA / AI-Gateway cost specifics** — usage tokens only.

---

## Where the harvest record lives — DECIDED 2026-08-07

Part A reads it as the eval fixture and Part B reads it as the attribution substrate, so it is decided **once, here**, rather than independently in each. What exists today: `TurnRecord` ([galaxy.ts](../apps/nebula/src/galaxy.ts)) is written fire-and-forget on **every** codegen turn — `DevStudio`'s recorder fires it at the Galaxy, which persists a JSON payload row readable through `getTurns`. Its own JSDoc already designates it the eval-replay unit and equates its schema with the eval-fixture schema, so Part A's fixture format is not a new artifact to design.

| Decision | Choice | Rationale |
|---|---|---|
| Harvest substrate | **Our own resource model. AI Gateway logs are NOT the record** — not now, not as a fallback | Three independent reasons, any one sufficient. (1) **The signal is post-inference and AIG structurally cannot see it**: what makes a turn good is whether the compile gate passed, whether files applied, whether the human accepted or immediately rephrased — AIG sees one request/response pair, the same blindness [nebula-tenant-ai-billing.md](on-hold/nebula-tenant-ai-billing.md) § *AI Gateway vs Analytics Engine* already names on the cost side. (2) **Tenancy is structural for us and conventional for AIG**: a record lives in the tenant's own DO by construction, where AIG's tenant boundary is a `cf-aig-metadata` string somebody remembered to attach per call site — hand-written policy per site is the footgun [docs/vision/enterprise.md](../docs/vision/enterprise.md) uses *against* a competitor, so buying it here would be buying our own criticism. (3) **[ADR-004](../docs/adr/004-snodgrass-temporal-resources.md) gives history free**, with no per-plan retention ceiling and no privileged Cloudflare token on the read path — a token the billing file works specifically to avoid. |
| AI Gateway's remaining role | **Runtime control plane only** — spend caps, auto-fallback, Workers-AI rate-limit headroom. Never the record | Those are *enforcement*, which a passive record cannot do, so the two are complements rather than alternatives. ⇒ If a gateway is ever enabled it SHOULD carry `cf-aig-collect-log-payload: false`: metering and caps without duplicating prompts and generated source account-side. That is what stops the metering goal and the harvest goal competing for the same switch — they were only ever in tension because one switch served both. |
| Which of OUR surfaces is the record | **OPEN — resolve during the Galaxy collapse, not here** | Two capture surfaces exist with an unclear division: `TurnRecord` (Galaxy-local JSON, eval-shaped, carries model id / prompts / current source / raw output / reasoning / tool calls with results / applied paths / compile-gate slot) and `Session`/`Message` (DevStudio Resources, conversation-shaped, carries none of the turn mechanics). Neither is a superset. The collapse lands both in **one DO** — it already notes the cross-node recorder fire becoming a local self-call — so the question stops being a cross-node design problem and becomes a schema choice inside one node. Deciding it *before* then would price a hop that is about to disappear. |

⚠️ **Under-capture is the failure mode with no signal, which is why the surface question is scheduled rather than deferred.** Nothing goes red if a turn omits its gate outcome; the corpus simply comes out thin months later, and **turns already written cannot be backfilled**. This is the same argument [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) already makes for the [ADR-019](../docs/adr/019-derived-artifacts-record-observations.md) observation stamp — same object, same write moment, same irreversibility — so the two capture decisions SHOULD land together rather than in separate passes.

ⓘ **Two drifts in `TurnRecord` to fix whenever it is next opened** (noted 2026-08-07, neither blocking): its turn time is an epoch `number`, which [ADR-011](../docs/adr/011-iso-timestamps.md) rules out in favour of an ISO 8601 string; and its JSDoc still describes the one-shot regex path as current, though the tool-calling loop has since shipped and populates the tool-call slot.

---

## Part B — The optimizer (scaffold evolution)

The Cloudflare-native loop from the vision doc, made concrete:

- **Store** — scaffold versions live in a Durable Object as a non-destructive history sequence (ADR-004). Every version is addressable; rollback is instant (no destructive write to undo).
- **Retrieve** — **Vectorize** holds `(task embedding → scaffold-version → outcome)` tuples. On a new task, retrieve top-k winners and condition generation on them (retrieval-augmented scaffolds — the cheapest Ornith-shaped win, zero training).
- **Attribute** — the history substrate answers "what scaffold was live at time T, and what outcome followed" — the credit-assignment substrate, for free. Noisy/delayed/confounded on economic signal (the core research risk).
- **Reward, in order of strength** — (1) deterministic gates (Part A), (2) LLM-judged UI-intent (Part A), (3) **economic outcome** — did the app get used, did the builder get paid (the signal only a get-paid host can see; the crown-jewel flywheel doubling as reward). (3) is later; it is what makes this a moat.

---

## Part C — Cadence + safety model (NEW — not the repo loop's)

**Cadence.** Reuse the nightly pattern (scheduled sense → propose → gate → act), but this loop is likely triggered by **accumulated outcome volume**, not a wall-clock time — and it runs against Studio's scaffold on Workers AI, not Larry's repo on his meter. Its "propose" output is a **candidate scaffold version**; its "act" is a **gated promotion**.

**Safety model** — the risks here are user-facing and multi-tenant, so this is authored fresh (the repo loop's token-window/dirty-tree gates do not transfer):

1. **Promotion gate (the core control).** A candidate scaffold reaches user-developers **only after** it clears the pinned eval **and** a human ok. Proposal-only by default — the optimizer proposes; it never self-promotes to production.
2. **Multi-tenant isolation.** Evolve only the **platform's trusted scaffolds** from *aggregate* signal. **Never** let one builder's code/data enter another's generation — the trusted-skill vs. untrusted-user-code boundary is the seam; crossing it is a security defect, not a feature.
3. **Goodhart guard.** The pinned eval is the fixed ruler; the optimizer must never move the metric it also reports. Golden-set canary (Part A invariant 3) catches judge drift masquerading as improvement.
4. **Instant rollback.** ADR-004 makes every scaffold version non-destructive → a regressing promotion is reverted by pointing at the prior version, no data loss.

---

## Timing gates — why this is not started (mirror the vision doc)

1. **Generation target is real** — files-as-resources + compile + **vite-build preview** landed, so deterministic gates can be satisfied. *(Retires the old "§5.3.7 SFC substrate" trigger; the codegen loop has since shipped — verify this gate is met before un-parking Part A.)*
2. **The reward function exists** — Part A built and pinned. **Non-negotiable; comes first.**
3. **Enough volume for signal** — outcome-driven evolution needs density (a wedge outcome, not a shortcut).

Part A (the eval) is buildable as soon as gate #1 is confirmed. Parts B/C wait on volume.

---

## Phases (buildable order — reward function first)

### Phase 0 — Dependency + provider spike
**Success**: `vitest-evals` + `@vitest-evals/harness-ai-sdk` installed (ask-before-install; verify permissive license + Workers-friendly transitive footprint — `ai` and `workers-ai-provider` already present). A trivial `FactualityJudge({ judgeHarness })` runs Node-side against `@cf/zai-org/glm-5.2` through AI Gateway and returns a score. CF token in `.dev.vars` (never committed).

### Phase 1 — Deterministic gate suite (no model) — THE reward-function floor
**Success**: bake-off `benchmark-suite.ts` cases ported; `rubric.ts` gates as plain `expect()` over a `.dev` Star (ontology validates, transaction commits, **vite build succeeds**, feature present, **secure-by-default present**). Green on the current Studio loop. This is the bulk of the value and the gate for everything downstream.

### Phase 2 — LLM-judged UI-quality gate *(exploratory — calibration is empirical)*
**Success**: GLM-5.2 judge scores "UI matches intent"; `judgeThreshold` chosen from observed separation between known-good and known-bad outputs; golden-set canary established. Deliverable includes a captured findings note (threshold, canary set, judge-prompt that worked).

### Phase 3 — CI wiring
**Success**: reporter emits pass/fail to `GITHUB_STEP_SUMMARY`; replay keeps CI cost bounded; canary runs every pass; threshold breach fails the check. **At this point the regression gate is live — the reward function exists.**

### Phase 4 — Scaffold store + outcome logging
**Success**: scaffold versions persisted as an ADR-004 history sequence in a DO; every generation logs `(task → scaffold-version → deterministic+judge outcome)` **onto the substrate settled in § *Where the harvest record lives*** — which by the time this phase runs is one surface in one DO, so this phase extends a record rather than choosing between two; embeddings written to Vectorize. No behavior change yet — just the substrate.

### Phase 5 — Retrieval-augmented generation
**Success**: a new task retrieves top-k past winners from Vectorize and conditions generation on them; A/B (via Part A) shows non-regression vs. the un-augmented loop. The first place the loop *closes*.

### Phase 6 — Scheduled evolve/prune loop + promotion gate
**Success**: a scheduled pass proposes candidate scaffold versions from accumulated outcomes; the promotion gate (eval + human ok) blocks un-scored promotion; a regressing candidate is caught by the eval and never promoted; rollback via ADR-004 verified.

### Phase 7 (later) — Economic-signal reward
**Success**: usage / get-paid outcomes join the reward (behind the crown-jewel flywheel + billing plumbing). Gated on wedge density and honest credit-assignment; the moat step.

---

## Open questions
- **Credit assignment on noisy, delayed economic outcomes** — how much signal survives confounders? Deterministic gates are the fallback if economic signal proves too noisy to learn from directly.
- **What exactly is the versioned scaffold unit?** System prompt / `SKILL.md` tier / exemplars / secure-default templates — all separately versioned? Shapes credit-assignment granularity.
- **Shared engine vs. separate loop** — does the nightly-loop engine run this, or is it always-on and independent? (Different target, meter, safety → leaning separate.)
- **Privacy-preserving aggregation** — trusted-scaffold-only is the floor; is there ever a case for cross-tenant pattern learning, and under what differential-privacy-grade guarantee?
- *(From the eval origin)* Is GLM-5.2 reliable enough as a *judge* at our thresholds (Phase 2 answers)? Node-side REST vs. vitest-pool-workers binding (Node-side default)? Does `@vitest-evals/harness-ai-sdk` map onto our loop or need a thin custom adapter?

## Related
- [`docs/vision/self-improving-platform.md`](../docs/vision/self-improving-platform.md) — governing vision (moat, bounded claim, timing gates).
- [`nebula-nightly-loop.md`](nebula-nightly-loop.md) — the *other*, separate self-improvement loop (Lumenize source review).
- [`nebula-skills.md`](nebula-skills.md) — skills are a scaffold tier; every skill/base-prompt change runs through Part A before it ships.
- [`nebula-offline-prompt-harness.md`](on-hold/nebula-offline-prompt-harness.md) — shares the fixture schema.
- [think-vs-cma bake-off](archive/think-vs-cma-bakeoff.md) — the one-shot cost decision this is **not** (cost-spike vs quality-regression + evolution); [[kimi-k27-adoption]], [[studio-uibuild-pivot]].
