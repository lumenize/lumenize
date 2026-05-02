# Parse-Validate: Release Coordination

**Status (2026-04-30)**: Phase 1 complete + throughput task complete + Phase 2 drafted as a **three-post split** (was two). Headline: per-call warm latency ~52 ms, per-DO-instance peak throughput ~410 txn/s (21× the serial floor — the output-gate / group-commit insight is empirically confirmed). Latency numbers in [RESULTS.md](../apps/nebula/test/browser/RESULTS.md), throughput numbers in [THROUGHPUT-RESULTS.md](../apps/nebula/test/browser/THROUGHPUT-RESULTS.md).

## Update 2026-04-30: three-post split + new staging

During the Phase 2 drafting, the original 2b ("Facet performance in practice") was split into two posts because the throughput-finding earned its own post — and the DO-general gate-semantics insight has a wider audience than facet-specific cost analysis:

- **2a** `website/blog/2026-04-29-introducing-parse-validator/` — release announcement (unchanged)
- **2b** `website/blog/2026-04-29-what-i-got-wrong-about-do-throughput/` — DO throughput / gate-semantics insight (NEW; absorbs what was "future companion (i)" below)
- **2c** `website/blog/2026-04-29-cloudflare-do-facets-in-practice/` — facet-specific cost deep-dive (was the original 2b)

A fourth post (2d) is now in `tasks/backlog.md`: "When time stops: benchmarking Cloudflare Durable Objects from outside" — captures the WS-push-observer + ping-subtraction harness pattern. To be drafted in a separate session.

**Revised staging** (was: 2a + 2b same-day, then deprecate; new: staged release).

The "Day +X" cadence applies to **cross-posting on external channels** (Discord, Medium, Substack — see [reference_content_distribution.md](../.claude/projects/-Users-larry-Projects-mcp-lumenize/memory/reference_content_distribution.md)), not to the original publish on the Lumenize blog. All three posts can land on the Lumenize blog same-day if they're drafted; the staggered broadcast is what gives each post its own attention window with the cross-posting audience.

1. ✅ **2026-05-02**: npm publish `@lumenize/ts-runtime-parser-validator` via `/release-workflow` — published at 0.25.0 alongside the rest of the `@lumenize/*` packages.
2. ✅ **2026-05-02 (Day 0)**: publish 2a + 2c on the Lumenize blog — both live (`introducing-parse-validator` + `cloudflare-do-facets-in-practice`).
3. ✅ **2026-05-02**: publish 2b on the Lumenize blog (`what-i-got-wrong-about-do-throughput`) — already live, pre-positioned ahead of the cross-post window.
4. ⏳ **Day +3–5 (~2026-05-05)**: cross-post 2b to Discord + Medium. (Optional: 2a + 2c if not already broadcast.) Substack: pending channel setup; once active, include it in this cycle's broadcast.
5. ⏳ **Day +7–10 (~2026-05-09)**: draft + publish 2d ("When time stops: benchmarking Cloudflare Durable Objects from outside"); cross-post on the same cadence.
6. ✅ **2026-05-02**: `npm deprecate @lumenize/ts-runtime-validator` with message pointing at 2a's published URL — done in the same session as the npm publish.

**Substack setup** is an open prerequisite — captured in `tasks/backlog.md`; once the channel exists, fold it into this cycle's cross-posts and update `reference_content_distribution.md`.

The Phase 2 subsections below are kept for historical context. Where they describe "Phase 2b: Facet performance in practice" — that content is now 2c. Where they describe "Future companion post (i): the throughput-intuition trap with DOs" — that's now 2b. The "(ii) facets/DW/plain-Worker performance reference" remains a future companion.

**Depends on**: 5.2.4.2 phases 2, 3 (and ideally 4) landed — the integrated stack must exist before we measure or announce it
**Related**: Existing 5.2.4.1 task (archived) for the validator-package side; existing blog posts launching `@lumenize/ts-runtime-validator` set the conceptual frame this work inherits.

## Why throughput came before publish (decision 2026-04-29, retained for context)

The original plan was to ship 2a/2b on latency numbers alone, with `1/mean_latency` standing in as a "theoretical max throughput" proxy. **That proxy was wrong**:

- **Output gates don't serialize the DO.** They hold *one* invocation's outputs until *its* writes commit; the input gate keeps opening on awaits, so concurrent invocations interleave and their writes batch into a shared commit (group-commit).
- The pushback we got on the tsc engine was about throughput and latency. The typia engine fixes both; going out without a throughput number would have left the strongest objection unanswered, and going out with `1/mean × 1` would have invited a second round of "but what about throughput?" pushback.

The throughput task ran 2026-04-29 and **vindicated the prediction loudly**: per-Star peak ~410 txn/s deployed at N=128 — 21× the serial single-client floor. See [THROUGHPUT-RESULTS.md](../apps/nebula/test/browser/THROUGHPUT-RESULTS.md). Phase 2 below now has both story arcs to tell.

## Objective

The release-coordination work for the parse-validate pipeline: measure the integrated stack, announce it, and deprecate the predecessor. Each phase is gated on the previous one shipping.

- **Phase 1 — Integrated measurement**: feed the deep-dive blog post real numbers from the Galaxy + Star + facet path.
- **Phase 2 — Paired blog posts** (siblings, written together, published together):
  - **2a — Release announcement** (Lumenize/Nebula audience): "the parse-validate pipeline is here, here's what changed, use it."
  - **2b — Facet performance in practice** (Cloudflare-community audience): "real numbers — what facets actually cost per call, when they're the right tool."
- **Phase 3 — Deprecate `@lumenize/ts-runtime-validator` on npm**: only safe *after* the announcement points users at the new package, and gated on the new package being published (see Phase 3 pre-gate).

## Phase 1: Integrated measurement (feeds 2b)

**Status (2026-04-28)**: **Unblocked, decision made — go path (a).** `tasks/nebula-deployable-and-browser-harness.md` shipped end-to-end and is archived at `tasks/archive/nebula-deployable-and-browser-harness.md`. The browser harness lives at `apps/nebula/test/browser/` with a passing 3-test smoke (boot + auth + full client → Gateway → Star → Galaxy → Star round-trip). `wrangler dev` boots cleanly; Nebula can now be deployed.

**Direction (decided 2026-04-28)**: build the integrated bench. Two reasons:
1. **Validate the harness work end-to-end on a measurement path**, not just a single-transaction smoke. Running N transactions back-to-back will surface anything brittle in the harness that the smoke test doesn't.
2. **The harness is expected to be the foundation for almost all Nebula testing going forward** — reactivity (5.3 subscriptions), end-to-end client flows, future bench scenarios. Getting it exercised on a real bench cements the patterns.

A previously considered "skip the bench, ship 2a/2b with bare-facet numbers + a footnote" path was rejected for those reasons. (Notes preserved in this branch's session log.)

**Next-session entry point**: a fresh session reading this file cold should be able to pick up here. The relevant files all live under `apps/nebula/test/browser/`. See "Work remaining for Phase 1" below.

**Goal**: Measure the *integrated* facet cost — Galaxy + Star + mesh routing + facet — on top of the bare facet numbers already known from 5.2.4.1 Phase 6 (deployed: cold ~1,756 ms total = 1,494 ms DO infra + 262 ms facet contribution; warm ~1.4 ms per call). The implementation tests in 5.2.4.2 already validated correctness; this phase measures the cost.

**Phase 0 — facet beta-status check (completed 2026-04-27)** — *low risk; "use it now, beta-status disclosed" tone is appropriate, no early-look framing needed:*
- Status unchanged since 2026-04-13 launch: **beta on Workers Paid plan**. Two weeks elapsed.
- No GA timing announcement, no breaking-change entries, no regressions in either the [Durable Objects changelog](https://developers.cloudflare.com/changelog/product/durable-objects/) (latest entry 2026-02-24, pre-launch) or the [Workers Platform changelog](https://developers.cloudflare.com/workers/platform/changelog/). Most recent Durable Objects release-notes update is also silent on facets.
- Adjacent Dynamic Workers / Worker Loader API is still receiving **additive** enhancements (2026-04-17 "passing custom limits for dynamic workers"; nullable bundle names). Additive, not breaking — signals an evolving but compatible surface.
- **Implication for 2b**: the post should explicitly state "facets are currently in beta" with a link to Cloudflare's [launch announcement](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/), but no need to hedge the architectural recommendation. We're using a stable beta of an evolving feature, not betting on shifting sand.

**Approach (revised 2026-04-28)**: harness shipped at `apps/nebula/test/browser/` as a plain vitest-node project using `@lumenize/testing`'s `Browser` (cookie-aware fetch + CORS + redirect handling) — not vitest-browser/Playwright as originally planned. See the archived harness task for why (cross-origin cookie pain in vitest-browser's iframe; Browser already does the job in pure Node). Honest wall-clock timing comes from running in Node 22 outside any Worker isolate — `performance.now()` advances normally.

**Work — what's already in place** (from the harness task):
- `apps/nebula/test/browser/global-setup.ts` — auto-spawns `wrangler dev` over HTTPS, picks a free port, exposes base URL + email-test token via `project.provide()`. No manual prerequisite.
- `apps/nebula/test/browser/auth-bootstrap.ts` — real magic-link e2e helper. Triggers `/auth/<scope>/email-magic-link`, waits for the email via WebSocket from the deployed `email-test` Worker, captures the refresh cookie. NO test mode bypass.
- `apps/nebula/test/browser/smoke.test.ts` — three-test smoke: boot regression + auth bootstrap + full NebulaClient round-trip (register ontology + fire transaction). Currently green.
- `apps/nebula/test/browser/worker/index.ts` + `wrangler.jsonc` — full Nebula DO bindings + auth + Cloudflare Email Sending. `TestNebulaEmailSender` overrides `from` to `test@lumenize.io` (the production sender domain isn't verified).
- `browser-bench` vitest project already configured.
- `@lumenize/nebula/client` Node-safe subpath added so `NebulaClient` can be imported from Node test code without dragging in `cloudflare:workers`.

**Work remaining for Phase 1**:
- **Use `smoke.test.ts` test #3 as the template**. That test does exactly one transaction end-to-end (bootstrap admin → construct NebulaClient → register ontology → fire `callStarTransaction` → assert success). The bench is "do many of those, measure latency" — same setup, replace the single transaction with a vitest `bench(...)` block that fires N transactions on a hot Star.
- `transactions.bench.ts` alongside `smoke.test.ts` — vitest bench mode. Three `bench()` blocks (warm + cold + ping) — see "What 'cold' means" and bench design notes below.
- The full Nebula transaction path that gets benched: client → Gateway → Star Handler 1 (cache hit on warm, cache miss on cold) → [if cache miss: Galaxy `getLatestOntologyVersion()` → Star Handler 2] → load parser-validator facet → `parseBatch()` → write transaction → result delivered via mesh callback to the test client.
- Compare integrated numbers vs the bare facet bench from 5.2.4.1 Phase 6 (in `experiments/ts-runtime-parser-validator-spike/`) — call out integration overhead from mesh routing + auth + result callback.
- Record numbers in `apps/nebula/test/browser/RESULTS.md`.

**What "cold" means in this bench (decision 2026-04-29)**:

We measure **cold-Star against a warm cluster** — the most common real-world cold path: a user touches a new tenant scope under their existing org/galaxy. *Not* "fresh deploy cold" (whole-Worker cold-start); *not* "first-org-ever cold" (cold Galaxy + cold bundle + ontology re-registration per iteration).

Concretely, each cold iteration must vary **only the tenant segment** of the Star scope, e.g. `acme.app.tenant-${suffix}`. Do **not** use `smoke.test.ts`'s `uniqueStar()` — that varies the universe segment (`acme-${suffix}.app.tenant-a`), which produces a different Galaxy *and* a different Worker Loader bundleId per iteration. That's the heavier "cold-everything" path; we're not measuring that.

What is and isn't cold under this design:
- **Cold per iteration**: the Star DO instance (fresh wake, no `_index` populated → cache miss on Handler 1 → mesh hop to Galaxy → `doTransaction` populates cache → first parse on this Star).
- **Warm across iterations**: Galaxy DO (one galaxy serves all tenants in this bench, ontology registered once in `beforeAll`); the parser-validator bundle in the Worker Loader cache (bundleId is `<universe.galaxy>/<version>` — see [star.ts:97](apps/nebula/src/star.ts:97), documented at [star.ts:50-58](apps/nebula/src/star.ts:50); since universe.galaxy is constant, the bundle is loaded once on the first cold iteration and cache-hits thereafter); the Worker isolate; the test-side WS connection and JWT.
- **Decision rationale**: bare-bench cold was ~262 ms (5.2.4.1 Phase 6); we expect integrated cold-Star/warm-cluster to be in the same ballpark plus mesh-hop and result-callback overhead. If the integrated number grows past ~1 s we'd revisit the cold-everything case to understand why; otherwise the cold-Star/warm-cluster number is the headline.

The warm bench reuses the same Star scope across iterations: hot Star (Handler 1 cache hit, no Galaxy hop), bundle already loaded, Galaxy untouched.

(Iteration-1 bundle-load cost is handled in bench design note 4 below — it's pre-warmed in `beforeAll`.)

**Bench design notes (decided 2026-04-29)**:

These pin the harness-side decisions before implementation. All four are required for the bench to produce trustworthy numbers; none of them is a "tweak later" item.

1. **Result delivery: Promise wrapper, not polling.** The smoke template uses `vi.waitFor(() => client.callCompleted)` to observe completion. `vi.waitFor`'s default interval is 50 ms — much larger than the warm-path measurement target (~1.4 ms bare, expected single-digit-ms integrated). Polling would dominate the noise floor. The WebSocket push mechanism is *already* there: `handleTransactionResult` is a `@mesh()` handler that fires when the Star's mesh callback arrives over the existing WS. Wrap a single shared `#pending` slot so all result paths route through one Promise:

   ```ts
   class HarnessNebulaClient extends NebulaClient {
     #pending?: { resolve: (v: any) => void; reject: (e: Error) => void };

     #settle(v: any): void {
       if (v instanceof Error) this.#pending?.reject(v);
       else this.#pending?.resolve(v);
       this.#pending = undefined;
     }

     // Mesh callbacks the Star invokes directly over the existing WS.
     @mesh() override handleTransactionResult(r: TransactionResult | Error) { this.#settle(r); }
     @mesh() handlePingResult(r: number | Error) { this.#settle(r); }

     // Plain handler for callers that explicitly forward via `(this.ctn() as any).handleResult(remote)` —
     // Galaxy ontology registration uses this pattern (see smoke.test.ts).
     handleResult(r: any) { this.#settle(r); }

     callStarTransaction(starName, ontologyVersion, ops): Promise<TransactionResult> {
       return new Promise((resolve, reject) => {
         this.#pending = { resolve, reject };
         this.lmz.call('STAR', starName, (this.ctn() as any).transaction(ontologyVersion, ops));
       });
     }

     callStarPing(starName): Promise<number> {
       return new Promise((resolve, reject) => {
         this.#pending = { resolve, reject };
         this.lmz.call('STAR', starName, (this.ctn() as any).ping());
       });
     }

     callGalaxyAppendOntologyVersion(galaxyName, cfg): Promise<void> {
       return new Promise((resolve, reject) => {
         this.#pending = { resolve, reject };
         const remote = (this.ctn() as any).appendOntologyVersion(cfg);
         this.lmz.call('GALAXY', galaxyName, remote, (this.ctn() as any).handleResult(remote));
       });
     }
   }
   ```

   Bench iteration becomes `await client.callStarTransaction(...)` — measures actual WS round-trip with no polling noise. Single-slot `#pending` is fine because vi.bench (and `beforeAll`) are sequential. The throughput task ([parse-validate-throughput.md](./parse-validate-throughput.md)) needs a Map for concurrent in-flight calls; not our concern here.

2. **WS-leg baseline: ping bench.** Local round-trip to `wrangler dev` is negligible (~ms over loopback); deployed round-trip is material (tens to hundreds of ms depending on client/colo geography). To isolate in-Worker cost from network round-trip, run a ping bench alongside the transaction bench: same WS connection, server-side handler does no work, measure round-trip. Subtract from transaction latency to get the in-Worker contribution. Implementation outline:
   - Add a no-op `ping()` mesh handler to **`StarTest`** ([apps/nebula/test/test-apps/baseline/index.ts:38](apps/nebula/test/test-apps/baseline/index.ts:38)) — the existing test-only subclass that the browser harness already binds as the `STAR` class. This keeps the production `Star` class clean with no env gates and no new flags.
   - The handler bounces a `handlePingResult` back to the client via the same mesh-callback mechanism.
   - Add `callStarPing()` to `HarnessNebulaClient` (shown above).
   - Bench file gets a third `bench()` block: `ping`. Its number is the floor we subtract.

3. **Setup: `beforeAll`, not per-iteration.** The bench measures *transaction* cost, not bootstrap cost. `beforeAll` does: magic-link admin bootstrap + cookie capture + NebulaClient construction + WS connect + Galaxy ontology registration + cold-bundle pre-warm (see note 4). The client is constructed at **galaxy scope** (`authScope` and `activeScope` both `acme.app`) — `lmz.call('STAR', starName, ...)` targets specific Stars by binding+name, so one long-lived galaxy-scoped client drives every iteration regardless of tenant segment. No need to re-bootstrap or re-mint tokens per iteration. Per-iteration the bench just calls `client.callStarTransaction(starName, version, ops)` with the appropriate Star (warm: same Star; cold: vary tenant segment).

4. **Warmup iterations.**
   - **Warm bench**: vi.bench's built-in `warmupIterations` (3–5 sufficient) covers wrangler-dev subprocess warm-up, TLS handshake, etc.
   - **Cold bench**: cold-Star/warm-cluster keeps `universe.galaxy` constant, so the bundle is loaded once across the whole run. But iteration 1 of the bench would still pay that one-time ~262 ms load. **Fix**: in `beforeAll`, after ontology registration, fire one transaction against a *throwaway* tenant scope (e.g. `acme.app.tenant-warmup`). That populates the Worker Loader cache for the bundle and exercises the cold-Star path once before the recorded cold iterations begin. vi.bench's `warmupIterations` is **not** sufficient on its own — each cold-bench warmup iteration would itself be a fresh-Star path and skew toward measuring "second-fresh-Star," not the bundle pre-warm we actually need.
   - **Ping bench**: vi.bench's `warmupIterations` covers it.

**Local-first, then deploy**:

Get the bench green and stable against `wrangler dev`, then **rerun against a deployed Worker on Cloudflare to get the publishable numbers**. Local numbers are sanity-floor (no network, no real cold-start, different loader-cache behavior). Phase 2b's framing "real numbers from production-equivalent infrastructure" requires deployed.

Concretely:
- Local pass: bench code compiles, all three blocks (warm + cold + ping) produce stable percentiles, ping number is ~ms range. This is the "implementation correct" gate.
- Deployed pass: deploy the harness's worker (`apps/nebula/test/browser/worker/`) — Nebula is now deployable, per the harness task. Re-run the bench pointing at the deployed URL (configurable base URL in the harness). Record numbers.
- Both number sets go in `RESULTS.md`, clearly labeled. The deployed numbers feed 2b; the local numbers help diagnose if/when deployed numbers regress.

**Splits** (already in place):
- Smoke (and future reactivity tests for 5.3) → `npm test` from `apps/nebula/`. Deterministic assertions only.
- Bench → `npm run bench` from `apps/nebula/` (already wired). Records numbers, no flaky timing assertions.

**Out of scope (decided 2026-04-28)**: tsc-baseline new-vs-old comparison. The post's framing is "what does facet-hosted typia validation cost in the integrated stack?", not "we beat the old engine." The qualitative win is already documented in `@lumenize/ts-runtime-parser-validator`'s `index.md` and the 2026-03-24 / 2026-03-25 conceptual posts. Skipping that comparison keeps 2b focused.

**Success Criteria**:
- [x] Facet beta-status risks documented (one paragraph, fed back into 2b's post draft if material) — see Phase 0 findings above
- [x] `apps/nebula/test/browser/` harness built; smoke test passes against auto-spawned `wrangler dev`
- [x] `HarnessNebulaClient` exposes Promise-wrapped `callStarTransaction()`, `callStarPing()`, and `callGalaxyAppendOntologyVersion()` via a single shared `#pending` slot
- [x] No-op `ping()` mesh handler on `StarTest`, wired through to client `handlePingResult` (production `Star` untouched)
- [x] Bench file `apps/nebula/test/browser/transactions.bench.ts` with three `bench()` blocks: `warm`, `cold`, `ping`
- [x] Local bench green and stable
- [x] Deployed bench numbers recorded in `apps/nebula/test/browser/RESULTS.md` — both raw and WS-leg-subtracted
- [x] Local numbers also recorded in `RESULTS.md` for regression-diagnostic value
- [x] Integration overhead vs bare bench documented

## Phase 2: Paired blog posts

Two posts written together, published together, cross-linked. 2a is the user-facing release announcement (Lumenize/Nebula audience); 2b is the technical deep-dive (Cloudflare community, parse-validate case study). Sequencing them as a pair means each can lean on the other rather than redundantly covering motivation + cost in both. **Both must publish before Phase 3 (`npm deprecate`) fires**, so the deprecate message can link to a live release post.

### Future companion posts (drafted after the release; not blocking Phase 3)

Two follow-on posts that draw on the parse-validate work but stand on their own as Cloudflare-community references. Both link back to 2a/2b as the source of the data; they are *not* a re-publishing of 2b.

**(i) "The throughput-intuition trap with Durable Objects."** Single-insight piece on output-gate semantics.

**Working tagline / title hook**: *"Input gates prevent races. Output gates prevent lies — without preventing throughput."* The parallel structure sets up the reveal — both gates are protective mechanisms, but the durability mechanism (output gates) doesn't cost what durability mechanisms usually cost. The body should unpack each half:
- **Input gates prevent races** — they serialize JS execution within the DO so concurrent invocations don't see each other's intermediate state. Map this to ACID's *isolation* once for readers who want the formal term.
- **Output gates prevent lies** — they hold outbound messages until storage writes commit, so the system never tells a caller "done" before it's actually durable. Map this to ACID's *durability*, with the qualifier "as observed by the caller."
- **Without preventing throughput** — the per-invocation scoping of output gates plus group-commit batching is what keeps concurrency from collapsing back at the durability boundary. Throughput emerges from (a) input gates opening on awaits → concurrent invocations can run, (b) output gates per-invocation → durable acknowledgment without serializing outputs, (c) group-commit batching → amortized commit cost across concurrent writers.

The hook: `1/mean_latency` reads like a system ceiling but is actually a floor. Empirical evidence in [THROUGHPUT-RESULTS.md](../apps/nebula/test/browser/THROUGHPUT-RESULTS.md): 21× scaling vs the serial floor. Honest framing: 4+ years of working with DOs and Larry hadn't internalized this distinction — strong "expert blind-spot" angle without contradicting any Cloudflare positioning.

**(ii) "Hosting code on Cloudflare: facets vs plain Workers vs Dynamic Workers — a performance reference."** Evergreen decision-framework piece for Cloudflare devs. The hook: when you have code that should run in response to events from a DO, you have several hosting options (facet on the DO, plain Worker via Service Binding, Dynamic Worker via Worker Loader, or just inlined into the DO). Each has different latency/throughput/scaling characteristics. The post lays out the decision framework and uses our parse-validate work as the case study (links to 2b for numbers; this post generalizes the reasoning to other workloads). Differentiator from 2b: 2b is "what the parse-validate facet costs"; this post is "how to think about facet/DW/plain-Worker tradeoffs for *your* use case."

**Note on the gate tagline**: keep the input/output-gate explanation in (ii) but bury it as one paragraph in the throughput section, not the headline. (i) owns the gate-semantics narrative; (ii) borrows it as supporting material to explain *why* one of its throughput observations holds. If (ii)'s headline foregrounds gates, it drifts toward being a re-tread of (i) when its job is broader.

Both follow-ons are drafted post-release. They're captured here so we don't lose the thread; they don't gate the release. Sequencing: (i) is ready to draft now (numbers are in); (ii) is more design work and can wait until we've sat with the parse-validate numbers a bit longer to see what generalizes cleanly.

### Phase 2a: Release announcement (Lumenize/Nebula audience)

The conceptual frame is already in place via two existing posts that launched `@lumenize/ts-runtime-validator`:
- [TypeScript is the schema](./../website/blog/2026-03-24-typescript-is-the-schema/index.md) — why TS interfaces beat parallel Zod / JSON Schema definitions
- [Write your types once](./../website/blog/2026-03-25-write-your-types-once/index.md) — the "you write types four times" pain pitch

The new announcement is a shorter follow-up that inherits the frame and announces what's new, not a fresh ground-up essay.

**Content** (target: ~half the scope of the conceptual posts above):
- What changed under the hood: typia engine replaces tsc, parse-not-just-validate semantics, `@default` filling, DO facet hosting
- One paragraph on the facets-vs-plain-DW rationale: facets share the parent DO's isolate → same-isolate RPC, no network hop. (The package's `index.md` links to Cloudflare's facets announcement for "what are facets"; the release blog is the place for "why *we* picked them for this.")
- One-line cross-link to 2b for readers who want the latency numbers
- Mention `@lumenize/ts-runtime-validator` is being retired and link to the new package — Phase 3 below executes the actual `npm deprecate` once this post is live
- Cross-post per the content-distribution memory (Lumenize site + Substack + Medium)

### Phase 2b: Facet performance in practice (Cloudflare community)

**Why it's worth writing**: facets are new (announced 2026-04-13) and community guidance is thin. Our 5.2.4.1 Phase 6 benchmarks produced facet-specific numbers that answer questions other developers will have. Distinguishes Lumenize as having done the homework; pairs naturally with the release announcement.

**Headline framing**: real numbers distinguishing "DO facets are essentially free" (true for infrastructure/billing, Cloudflare's framing) from the per-call latency reality: **the facet contribution is ~262 ms (facet load + 119 KB module parse + first parse) and ~1.4 ms per-call once warm** — added on top of whatever your DO setup already costs. The 1.4 ms is overwhelmingly the same-isolate RPC boundary (structured-clone + scheduler hop, ~1.35 ms); the typia parse itself is ~50 µs. (The post deliberately stays out of the DO cold-wake baseline — that's a separate cost everyone in DOs pays regardless, not something facets add.)

**Reconciliation note for the post**: 5.2.4.1 Phase 6 measured a deployed cold-wake of ~1,756 ms total = ~1,494 ms DO infrastructure (everyone-pays baseline) + ~262 ms facet contribution. The post's headline is the 262 ms (the facet-specific number), not the 1,756 ms. If a reader cross-references our `@lumenize/ts-runtime-parser-validator` `index.md`'s "~1.7 s cold-wake" figure, that's the total — same data, different layer.

**Numbers to include** (from 5.2.4.1 Phase 6, expanded with Phase 1 above):

| Metric | Number | Source |
| --- | --- | --- |
| Facet contribution to cold-wake (load + module parse + first parse) | ~262 ms | 5.2.4.1 Phase 6 |
| Warm per-call latency (parse + RPC) | ~1.4 ms | 5.2.4.1 Phase 6 |
| &nbsp;&nbsp;↳ of which: facet RPC (structured-clone + scheduler hop) | ~1.35 ms | derivation |
| &nbsp;&nbsp;↳ of which: typia parse core | ~50 µs | 5.2.4.1 Phase 6 |
| Bundle size, 30-type ontology | 119 KB | 5.2.4.1 Phase 6 |
| Integrated cold-Star/warm-cluster (mesh + Galaxy fetch + first parse on this Star) | TBD | Phase 1 here |
| Integrated warm p50 / p99 | TBD | Phase 1 here |

The "added on top of DO wake" framing keeps the focus on facet-specific cost without dragging readers through the DO infrastructure baseline.

**Content checklist**:
- Lead with the facet-specific number (262 ms facet contribution to cold-wake) and the warm number (1.4 ms parse). Make those the headline.
- Include the 30-type benchmark fixture (`packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts`) so readers can reproduce.
- Specific guidance on when facets are right (dynamic code hot-swap, per-tenant sandboxed code, ontology-driven schemas) vs wrong (sub-ms per-call latency requirements with no hot-swap need).
- Apply the framing rules from `feedback_cf_community_framing.md` — Cloudflare's "essentially free" is true at the layer they meant (billing/infra); we're adding the per-call latency view, not contradicting.
- CTA links back to the release post and to the `@lumenize/ts-runtime-parser-validator` package docs.

## Phase 3: Deprecate `@lumenize/ts-runtime-validator` on npm

**Goal**: Mark the old package as deprecated so anyone landing on it from npm sees the migration pointer.

**Why this is the closing step**: deprecation is a public, externally-visible action. Doing it before the announcement leaves users stranded ("the old one says deprecated, but where do I go?"); doing it well after lets new users keep adopting the dead package. It runs immediately after the announcement posts go live, when the redirect target exists publicly.

Pulled here from 5.2.4.2's original Phase 5. The internal-only parts of that phase (drop the dep from Nebula, ensure no remaining imports) already shipped with 5.2.4.2 — only the externally-coupled deprecate remains.

**Pre-Phase 3 gates** (in order):
- [x] **Docs review pass** of `@lumenize/ts-runtime-parser-validator` — landing-shape confirmed 2026-04-27 (`parseBatch` scoped to api-reference + index.md mention; `ParserValidator.parse()` / `.parseBatch()` heading style aligned with the project's `#`-means-private convention).
- [x] **`@lumenize/ts-runtime-parser-validator` published to npm** — v0.25.0 published 2026-05-02 alongside the rest of the `@lumenize/*` packages.
- [x] **Release announcement (Phase 2a) is published** — `https://lumenize.com/blog/introducing-parse-validator/` live as of 2026-05-02 (alongside the facet-performance post).

**Work** (executed 2026-05-02):
- [x] Updated `packages/ts-runtime-validator/README.md` with a deprecation banner pointing at the new package and the announcement post.
- [x] Bumped `@lumenize/ts-runtime-validator` to **0.25.1** and published — needed to ship the updated README (npm tarballs are immutable; README updates require a new version).
- [x] Ran `npm deprecate @lumenize/ts-runtime-validator "Deprecated. Use @lumenize/ts-runtime-parser-validator — https://lumenize.com/blog/introducing-parse-validator/"`. `npm deprecate` without a version range deprecates **all** versions, which is what we want — anyone on 0.23.x, 0.24.x, or any 0.25.x sees the banner.
- [x] Verified via `https://registry.npmjs.org/@lumenize/ts-runtime-validator` — `latest: 0.25.1`, all 4 versions (0.23.0, 0.24.0, 0.25.0, 0.25.1) carry the deprecation message.

`npm deprecate` is reversible (`npm deprecate <pkg> ""` clears the message), but the message is publicly visible, indexed, and cached by tooling — treat as an external-action gate per CLAUDE.md "Executing actions with care."

**No migration guide** — per 5.2.4.1 Phase 7's decision, the new package is framed as a fresh package, not a successor. The blog post is the migration pointer.

**Success Criteria**:
- [x] npm shows `@lumenize/ts-runtime-validator` as deprecated with the pointer message
- [x] Deprecation message links to the published release post

## Combined Success Criteria

- [ ] Phase 1 measurement complete; numbers in `apps/nebula/test/browser/RESULTS.md`
- [ ] Release-announcement post drafted at `website/blog/YYYY-MM-DD-parse-validate.md`; references the two existing conceptual posts rather than re-deriving the frame
- [ ] Facet-performance post drafted at `website/blog/YYYY-MM-DD-facet-performance-in-practice.md`; leads with facet-specific cost (cold-spawn + warm parse), avoids the DO cold-wake baseline framing
- [ ] Reproducer link points at the committed benchmark fixture (`packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts`) and bench scripts in `experiments/ts-runtime-parser-validator-spike/` (bare facet) + `apps/nebula/test/browser/` (integrated stack)
- [ ] Both posts cross-link
- [ ] Cross-post per `reference_content_distribution.md` (Lumenize site + Substack + Medium)
- [ ] Pre-Phase 3 gates met: docs review pass, `@lumenize/ts-runtime-parser-validator` published to npm, release post live
- [ ] `@lumenize/ts-runtime-validator` deprecated on npm with pointer to the new package and the release post
