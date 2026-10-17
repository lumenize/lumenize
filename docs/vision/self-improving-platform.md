---
status: draft
status_dated: 2026-07-05
---

# Nebula as a Self-Improving Platform — the Compounding Moat

> **Every app built on Nebula makes the next one better.** The platform's generation, defaults, and security posture compound from real-world outcomes — a self-improving *system* (not a self-improving *model*), and a moat competitors structurally can't copy. **Committed in direction, gated in timing, not day-one.**

| | |
|---|---|
| **Status** | Living doc as of 2026-07-05. Direction committed; timing gated behind the wedge + a working eval harness (see § *Timing gates*). Forward-looking — this is a moat we grow into, not a feature we ship early. |
| **Audience** | Internal. A `/review-task` product-vision lens for any task touching Studio's generation loop, evals, or platform-learning. Also the investor "compounding moat" narrative. |
| **Relationship** | Sibling of [`strategy.md`](strategy.md); deepens its coach-loop line ("over time the same feedback loop trains the platform's own agents, docs, and defaults"). Where the two conflict, `strategy.md` wins — the wedge funds and proves this, not the other way around. |

---

## The idea, distilled — a self-improving *system*, not a self-improving *model*

The inspiration is **Ornith-1.0** (DeepReinforce, [June 2026](https://deep-reinforce.com/ornith_1_0.html)): a coding model that, during RL training, learns to generate not just the *solution* but the *scaffold* that guides it — the agent's reasoning sequence, memory layout, tool order, debugging playbook. Reward flows back to both; over thousands of iterations the scaffolds themselves evolve, and winning workflows survive while losers die out. Ornith bakes that into **model weights**. That is model development — a GPU-cluster RL job — and it is explicitly **not** a business we are in.

The portable insight is that you don't need to touch weights to get the loop. **Lift it one level, from weights to orchestration:** keep the base model frozen and treat *the scaffold as data* — the generation harness Studio already runs (system prompts, `SKILL.md` files, retrieved exemplars, tool sequences, secure-default templates). Run real builds, capture an outcome signal, and let that signal decide which scaffolds survive vs. get pruned or mutated. Same evolutionary loop, no training pipeline, no GPU.

That distinction is the whole strategy:

- **What this is NOT:** training our own model, "self-improving AI," an autonomous system that rewrites its own goals. No weight updates. The base models stay frozen and swappable (today Studio runs a Kimi-class model via `env.AI`).
- **What this IS:** the platform's *scaffold and defaults* measurably improve from aggregate outcome signal, gated by a fixed eval harness. A self-improving *system*. Bounded, gated, and honest about it (see § *Claim discipline*).

---

## Why it's a moat — the fourth flywheel

`strategy.md` names three flywheels (builder→builder, builder→user, user→user). This is a fourth, different in kind: not a network effect between *users*, but a **data/outcome flywheel** — more usage makes the platform itself better.

**The bottleneck for everyone doing this is the reward signal, and ours is uniquely strong.** Every agentic-build competitor optimizing a generation loop is stuck with a weak, gameable reward: "did it compile / did tests pass." That is exactly what Ornith optimizes against (coding benchmarks). Nebula can close the loop on signals no one else has:

1. **Economic outcome — did the app get *used*, did the builder *get paid*.** This is the crown-jewel flywheel from `strategy.md` (commerce in the loop) doubling as a reward function. Scaffolds that produce apps people actually pay for beat scaffolds that merely compile. **This signal is structurally invisible to a tool that only generates and hands you the code** — you have to *host the paying app* to see it. We do.
2. **The coach loop as labeled training data.** Every coach intervention (`strategy.md`) yields a concrete `(gap → fix)` or `(capability → discoverability-gap)` pair — the highest-bandwidth, human-verified signal available, and it's a byproduct of a motion we already run.
3. **Deterministic eval gates.** The regression suite (ontology validates, transaction commits, SFC compiles, secure-by-default present) is the fast, cheap floor beneath the fuzzy signals.

**Why competitors can't copy it:**

- **Homogeneity makes outcomes aggregable.** Every Nebula app runs on the *same* secure substrate (the walled-garden moat in `strategy.md`). That's what makes `(task → scaffold → outcome)` tuples *comparable* across apps and therefore learnable-from. A deploy-anywhere competitor's outcomes are apples-to-oranges across a thousand different stacks.
- **They lack the economic signal.** No get-paid loop → no "did it succeed in market" reward.
- **They lack the coach loop.** No shared multi-participant build chat → no labeled gap/fix stream.

More apps → more outcome data → better scaffolds and defaults → better, more-secure apps ship faster → more builders. The loop compounds, and each of its three inputs is a thing we already have or already plan to build.

---

## Secure-by-default compounds too

The most important thing the loop optimizes is **not** codegen speed — it's the **secure-by-default posture itself**. A scaffold or default template that led to a footgun (even a rare, under-the-covers-caught one) is a scaffold the loop can prune; a generation pattern that keeps apps inside the ReBAC/DAG substrate cleanly is one it can promote. The platform's security *defaults get better the more the platform is used* — the wedge deepens on its own. That is a claim that turns the secure-by-default wedge from a static property into a compounding one, and it is downstream of the same homogeneous substrate.

---

## Why Cloudflare makes it buildable (the porting question)

The building blocks map cleanly onto Cloudflare's platform — which is the practical reason this is a Nebula move and not a research fantasy:

- **Vectorize** (Cloudflare's vector DB) → retrieve past `(task embedding → scaffold → outcome)` tuples; condition new generations on the winners.
- **Workers AI** → the frozen base models. (Ornith itself is open-weights, so we could even *use* it as a generator — but that's using the model, not replicating its self-improvement.)
- **Durable Objects + ADR-004 (Snodgrass snapshot history)** → per-Star scaffold state, and — because nothing is ever destructively overwritten — scaffold evolution is just another non-destructive resource-history sequence. "What was the scaffold at time T, and what outcome followed?" is the **credit-assignment substrate, for free.**
- **AI Gateway** → the outcome/telemetry harvest and spend-cap layer (already in the billing/observability plans).

**The honest boundary:** Workers AI is *inference, not training*. You cannot run RL weight updates on Cloudflare — the literal port of Ornith (train an MoE with self-scaffolding RL) is a GPU-cluster job, not a CF workload, and not where we play. There is a middle rung (Workers AI can serve LoRA adapters), but *training* the adapter still happens off-platform and is still lightweight model development. **System-level scaffold evolution is the Cloudflare-native play; weight-level is not.** Don't let the analogy drift into "Cloudflare is where we'd train."

---

## Claim discipline (the bounded claim — read before any external use)

Same discipline `strategy.md` applies to the security claim applies here, harder:

- **Never pitch "self-improving AI," unqualified.** A CISO- or technically-literate reviewer breaks it instantly, and it reads as hype in a deck whose credibility rests on *bounded* claims. The defensible claim is exact: **"the platform's generation scaffolds and secure defaults measurably improve from aggregate outcome signal, gated by a fixed eval harness."** System-level, bounded, gated.
- **Credit assignment is the real research risk — name it, don't hide it.** Ornith gets clean, immediate reward from verifiable rollouts. Real-world "did they get paid" is noisy, delayed, and confounded. Attributing an outcome back to a scaffold version is the hard part, not the loop.
- **The reward is a proxy — guard against Goodhart.** Optimizing scaffolds against "compiles" or even "gets paid" can degrade the true target (secure, durable, paying apps). The eval harness is the fixed ruler that keeps the optimizer honest; it must be built and pinned *before* anything optimizes against it.
- **Multi-tenant privacy is a hard boundary.** We evolve only the **platform's own trusted scaffolds** from aggregate signal — never let one builder's code or data leak into another's generation. The trusted-platform-skill vs. untrusted-user-code seam is exactly that boundary; cross-tenant learning that crosses it is a security defect, not a feature.

---

## Timing gates — why this is not day-one

Do **not** build the evolution loop until all hold (building it early is the same premature-investment error as premature enterprise or social features):

1. **The generation target is real** — the SFC substrate (files-as-resources + compile + preview) has landed, so deterministic gates can actually be satisfied. (Same trigger that un-parks the eval suite.)
2. **The reward function exists** — the eval harness is built and pinned. *Nothing self-improves without a scorer;* this gate is non-negotiable and comes first.
3. **There is enough volume to have signal** — outcome-driven learning needs density, and density is a wedge outcome, not a shortcut (`strategy.md`: single-player value first, density-dependent features ship late).

Until then this is a captured direction, not active work. It is real, it is probably a large part of the long-term moat — but it is an *expansion of the wedge*, gated behind it, not a parallel track competing for focus today.

---

## How it gets built (pointers, not mechanics)

This doc stays at strategy altitude; the mechanics live in one task file — [`nebula-studio-self-improvement`](../../tasks/on-hold/nebula-studio-self-improvement.md) — plus the separate nightly loop:

- **Reward function** → its **Part A** (the former eval-suite, absorbed): deterministic gates + a pinned GLM-5.2 judge. The scorer the loop optimizes against; **build it first.**
- **The scaffold-evolution loop** → its **Parts B/C**: log `(task → scaffold → outcome)` to Vectorize, retrieve winners, prune losers, gate promotion.
- **Automation engine (separate)** → the [`nebula-nightly-loop`](../../tasks/archive/nebula-nightly-loop.md) — a different target (Lumenize's own source), kept separate; shares only the *pattern*.

---

## Review checks (the `/review-task` lens)

Flag a task that:

1. **Pitches or assumes "self-improving AI" unqualified** — the bounded claim is scaffold/defaults improving from signal against a fixed eval, nothing more.
2. **Builds the scaffold-evolution loop before the reward function (eval harness) exists** — you cannot optimize against a scorer you haven't built and pinned.
3. **Lets cross-tenant learning leak one builder's code/data into another's generation** — evolve only the platform's trusted scaffolds; the trust boundary is non-negotiable.
4. **Optimizes scaffolds against a weak proxy** (compile-pass) in a way that degrades the true target (secure, paying apps) — Goodhart; the fixed eval ruler is the guard.
5. **Treats this as day-one** or pulls focus from the wedge — it's gated behind a proven wedge + a working eval harness (see § *Timing gates*).

---

## Open questions

- **Credit assignment on noisy, delayed economic outcomes.** How much signal survives the confounders? This is the core research risk; the deterministic eval gates are the fallback if the economic signal proves too noisy to learn from directly.
- **What exactly *is* "the scaffold" as a versioned resource?** System prompt? The `SKILL.md` tier? Retrieved exemplars? Secure-default templates? All of them, versioned separately? This shapes the whole loop and the credit-assignment granularity.
- **Does the nightly-loop engine run this, or is it a separate always-on loop?** The nightly loop reviews *Lumenize's own source* on Larry's meter; scaffold evolution optimizes *Studio's codegen* on aggregate user outcomes — related philosophy, different target, different meter. Shared engine or siblings?
- **Privacy-preserving aggregation.** Trusted-scaffold-only is the floor; is there ever a case for learning from patterns across tenant apps, and if so under what differential-privacy-grade guarantee?
