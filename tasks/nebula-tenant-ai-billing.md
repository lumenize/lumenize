# Nebula per-tenant cost attribution & billing

**Status**: Design stub — not started. Captures decisions/findings from a 2026-06-06 design discussion so they aren't lost. Pairs with the Think-vs-CMA bake-off ([tasks/archive/think-vs-cma-bakeoff.md](archive/think-vs-cma-bakeoff.md)) which produced the per-turn AI-cost capture this builds on.

## Objective

Attribute Cloudflare costs to individual Nebula tenants (= scopes; **one Star DO per tenant**) so they can be billed, across **two contexts**:
- **Studio** (conversational app-builder) — low volume; absolute cost negligible. Per-tenant attribution is for fairness/visibility, not margin.
- **In-app AI** (AI features inside the apps tenants ship) — **high volume; this is where per-tenant billing actually matters** and where the Think/Kimi cost edge compounds.

## Cost dimensions

| Dimension | Per-tenant attributable? | How |
|---|---|---|
| **AI model spend (tokens)** | ✅ exact | Captured in-process per turn (`ctx.usage` / CMA `model_usage`) → self-computed via rate tables. Already proven in the bake-off ([experiments/think-vs-cma/shared/cost.ts] in the worktree). |
| **DO compute (CPU + wall-clock ms)** | ✅ exact (billing-grade) | `TraceItem.cpuTime` / `wallTime` via a **Tail Worker**, keyed by `TraceItem.durableObjectId` = the Star = the tenant. See below. |
| **Storage** | ✅ exact | Per-scope DO storage size. |
| **Request / `lmz.call` counts** | ✅ exact | Instrument in mesh / count per scope. |
| **Shared infra** (Gateway Worker, AI Gateway, account egress, Logpush) | ❌ no clean key | Allocate via the proxy-metering fallback below. |

## Mechanisms

### AI token cost — self-owned, billing-grade
Don't rely on AI Gateway's cost number for billing — Cloudflare explicitly calls it *"best-effort estimation… refer to your provider's dashboard for exact billing."* We already capture **exact** per-turn token usage in-process and multiply by a known rate table (`cost.ts`). That's the source of truth: provider-agnostic, exact, no dependency on AIG.

### AI Gateway custom metadata — runtime guardrail, NOT the ledger
`GatewayOptions.metadata` (the `cf-aig-metadata` header) tags each call with `{ tenantId: scope }`. One-line change in the Think arm's `getModel()`. What it buys:
- **Per-tenant spend limits** (added 2026-06-05): cost-based budgets scoped by metadata dimension → auto-`429` *or* auto-fallback to a cheaper model (Opus→Kimi) on breach. Genuinely useful for the high-volume in-app context.
- Caching, retries, dynamic/fallback routing, free analytics dashboards.

Treat AIG as an **optional runtime control plane**, not the billing ledger (its cost is the best-effort estimate). For Workers AI/Kimi, routing through AIG is one config field; CMA/Anthropic would need to be fronted by AIG-as-provider to get the same tagging — a minor point favoring Think/Kimi for the volume context.

### DO compute (CPU + wall-clock) — the part I initially mis-scoped as "hard"
Inside the DO the clock is dead (clock-trap), so you can't time CPU/wall in-isolate. But Cloudflare hands you the **billed** numbers out-of-band — two ways:

1. **Historical (what we used in the proxy-fetch experiment, [tasks/archive/proxy-fetch-performance-experiments.md](archive/proxy-fetch-performance-experiments.md))**: **Logpush `workers_trace_events` → R2**, fields `WallTimeMs` + `CPUTimeMs` per invocation. Batch (~minutes delay). Rejected alternatives recorded there: Workers Logs dashboard (UI-only), Log Explorer SQL (no `workers_trace_events`), GraphQL analytics (only P50/P99 aggregates), `wrangler tail` (real-time, no history). **Not a header** — that was a misremembering.
2. **Better / in-code, real-time**: a **Tail Worker** (`tail_consumers` in wrangler.jsonc) receives a `TraceItem` per invocation:
   ```ts
   interface TraceItem {
     readonly scriptName: string | null;
     readonly durableObjectId?: string;  // ← tenant key (one-Star-per-tenant)
     readonly cpuTime: number;           // billed CPU ms
     readonly wallTime: number;          // billed wall-clock ms
     readonly outcome: string;
     // scriptTags, dispatchNamespace, ...
   }
   ```
   `cpuTime`/`wallTime` **are the numbers CF bills on** (billing-grade, unlike the AIG estimate), and `durableObjectId` attributes them per tenant directly. The Tail Worker aggregates per-tenant-per-window and writes to the ledger.

⚠️ **To verify before building**: that `durableObjectId` is reliably populated on Star DO trace events and maps cleanly to scope.

## Ledger architecture

- **Billing-grade ledger = a DO (or D1)** doing exact per-tenant accumulation. **NOT Analytics Engine** as the source of truth — AE *samples at high write volume*, fine for dashboards, wrong for an invoice. (This refines an earlier suggestion to make AE the ledger.)
- **Analytics Engine = observability/dashboards/spend-trends** layer on top (free today; future: Workers Paid includes 10M data points written/mo +$0.25/M, 1M reads/mo +$1/M).
- Tail Worker aggregates per-tenant-per-window *before* writing → avoids AE sampling and cuts write volume.

### AI Gateway vs Analytics Engine — settled: not either/or, and cost isn't the axis
- AIG **core is free** (we'd skip the paid bits: Guardrails, Logpush export, Unified Billing's 5% markup). AE is free-now + tiny future per-M. **Neither has meaningful marginal cost at our scale** → cost is not the discriminator.
- AIG can *only* see AI calls — blind to requests/CPU/wall/storage. You need a unified ledger for those regardless. So: **self-owned ledger = source of truth; AIG = optional runtime guardrail.**

## Proxy-metering fallback (shared costs + reconciliation)

For genuinely-shared costs with no per-tenant key, and as a top-level sanity check, bill on cleanly-measurable proxies and calibrate against the real CF invoice. Three refinements (vs a naive single multiplier):
- **Multi-dimensional regression, not one multiplier.** A single coefficient on request-count cross-subsidizes (cheap-high-count tenant vs expensive-CPU-heavy tenant pay wrongly). Fit per-dimension coefficients (requests + storage + tokens + compute) against the actual monthly bill. Validate residuals against Logpush ground-truth (`WallTimeMs`/`CPUTimeMs`).
- **Re-fit periodically** as CF pricing / workload mix drift.
- **Expose "compute units" to customers; reconcile internally** so CF pricing changes don't churn customer-facing pricing. Markup/margin applied on top, independent of the cost model.

With the Tail Worker path making most dimensions *directly* attributable, the fallback's role shrinks to (a) allocating shared infra and (b) invoice reconciliation — not the primary basis.

## Billing-grade vs estimate (quick reference)
- ✅ Billing-grade: `TraceItem.cpuTime`/`wallTime` (the billed numbers); self-computed token cost (if rate table current); per-scope storage.
- ⚠️ Estimate only: AI Gateway's reported cost.
- ⚠️ Sampled (not for invoicing): Analytics Engine at high volume.

## Open questions / next steps
- [ ] Verify `durableObjectId` populated on Star trace events + maps to scope.
- [ ] Tail Worker setup; ledger schema (DO vs D1); per-tenant-per-window aggregation.
- [ ] Wire `gateway.metadata = { tenantId }` in the agent's `getModel()`; configure per-tenant spend limits.
- [ ] Decide customer-facing pricing model + which dimensions/units to expose.
- [ ] Decide markup factor / margin.
- [ ] If CMA is ever used (recommendation is Think/Kimi): route Anthropic through AIG-as-provider for tagging.

## References
- Bake-off + per-turn AI-cost capture: [tasks/archive/think-vs-cma-bakeoff.md](archive/think-vs-cma-bakeoff.md); `experiments/think-vs-cma/shared/cost.ts` (worktree).
- CPU/wall via trace logs: [tasks/archive/proxy-fetch-performance-experiments.md](archive/proxy-fetch-performance-experiments.md).
- Clock-trap (why in-isolate timing is dead): `feedback_cf_clock_traps.md` (memory).
- AI Gateway: custom metadata, spend limits (2026-06-05), pricing (core free); verified against Cloudflare docs 2026-06-06.
