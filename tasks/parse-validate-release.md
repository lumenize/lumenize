# Parse-Validate: Release Coordination

**Status**: Not started — split out of `tasks/nebula-5.2.4.2-validator-galaxy-integration.md` on 2026-04-27 once the implementation phases (2, 3) had landed
**Depends on**: 5.2.4.2 phases 2, 3 (and ideally 4) landed — the integrated stack must exist before we measure or announce it
**Related**: Existing 5.2.4.1 task (archived) for the validator-package side; existing blog posts launching `@lumenize/ts-runtime-validator` set the conceptual frame this work inherits.

## Objective

The release-coordination work for the parse-validate pipeline: measure the integrated stack, announce it, and deprecate the predecessor. Each phase is gated on the previous one shipping.

- **Phase 1 — Integrated measurement**: feed the deep-dive blog post real numbers from the Galaxy + Star + facet path.
- **Phase 2 — Paired blog posts** (siblings, written together, published together):
  - **2a — Release announcement** (Lumenize/Nebula audience): "the parse-validate pipeline is here, here's what changed, use it."
  - **2b — Facet performance in practice** (Cloudflare-community audience): "real numbers — what facets actually cost per call, when they're the right tool."
- **Phase 3 — Deprecate `@lumenize/ts-runtime-validator` on npm**: only safe *after* the announcement points users at the new package, and gated on the new package being published (see Phase 3 pre-gate).

## Phase 1: Integrated measurement (feeds 2b)

**Status (2026-04-28)**: **Unblocked.** `tasks/nebula-deployable-and-browser-harness.md` shipped end-to-end and is archived at `tasks/archive/nebula-deployable-and-browser-harness.md`. The browser harness lives at `apps/nebula/test/browser/` with a passing 3-test smoke (boot + auth + full client → Gateway → Star → Galaxy → Star round-trip). `wrangler dev` boots cleanly; Nebula can now be deployed.

**Picking up here**: the bench becomes a thin `*.bench.ts` file alongside `apps/nebula/test/browser/smoke.test.ts`, reusing the same `globalSetup.ts` (auto-spawn wrangler dev, real magic-link auth bootstrap, `Browser` for cookie-aware fetch). The `browser-bench` vitest project is already configured in `apps/nebula/vitest.config.js`; `npm run bench` from `apps/nebula/` invokes it.

**Two paths still on the table**:
- (a) Build the bench — the integrated cold/warm numbers go into 2b directly.
- (b) Skip the bench — go straight to drafting 2a/2b with the bare-facet numbers from 5.2.4.1 Phase 6 and a "integration overhead is its own post" footnote. The bare numbers may already be enough for 2b's argument.

Decide before starting work. (a) is more honest but adds more time to publish; (b) ships faster with a clearer scope.

**Goal**: Measure the *integrated* facet cost — Galaxy + Star + mesh routing + facet — on top of the bare facet numbers already known from 5.2.4.1 Phase 6 (cold ~1.7 s, warm ~1.4 ms deployed). The implementation tests in 5.2.4.2 already validated correctness; this phase measures the cost.

**Phase 0 — facet beta-status check** (do *first*, before any benchmark work): any Cloudflare API-stability signals, GA timing announcements, or known regressions worth knowing about before we build a public-facing post around the technology? If facets have been flagged as moving or unstable, surface that — the post's tone shifts from "use this in production" to "early-look" depending on what we find.

**Phase 0 findings (2026-04-27)** — *low risk; "use it now, beta-status disclosed" tone is appropriate, no early-look framing needed:*
- Status unchanged since 2026-04-13 launch: **beta on Workers Paid plan**. Two weeks elapsed.
- No GA timing announcement, no breaking-change entries, no regressions in either the [Durable Objects changelog](https://developers.cloudflare.com/changelog/product/durable-objects/) (latest entry 2026-02-24, pre-launch) or the [Workers Platform changelog](https://developers.cloudflare.com/workers/platform/changelog/). Most recent Durable Objects release-notes update is also silent on facets.
- Adjacent Dynamic Workers / Worker Loader API is still receiving **additive** enhancements (2026-04-17 "passing custom limits for dynamic workers"; nullable bundle names). Additive, not breaking — signals an evolving but compatible surface.
- **Implication for 2b**: the post should explicitly state "facets are currently in beta" with a link to Cloudflare's [launch announcement](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/), but no need to hedge the architectural recommendation. We're using a stable beta of an evolving feature, not betting on shifting sand.

**Approach (revised 2026-04-28)**: harness shipped at `apps/nebula/test/browser/` as a plain vitest-node project using `@lumenize/testing`'s `Browser` (cookie-aware fetch + CORS + redirect handling) — not vitest-browser/Playwright as originally planned. See the archived harness task for why (cross-origin cookie pain in vitest-browser's iframe; Browser already does the job in pure Node). Honest wall-clock timing comes from running in Node 22 outside any Worker isolate — `performance.now()` advances normally.

**Work — what's already in place** (from the harness task):
- `apps/nebula/test/browser/global-setup.ts` — auto-spawns `wrangler dev` over HTTPS, picks a free port, exposes base URL + email-test token via `project.provide()`. No manual prerequisite.
- `apps/nebula/test/browser/auth-bootstrap.ts` — real magic-link e2e helper. Triggers `/auth/<scope>/email-magic-link`, waits for the email via WebSocket from the deployed `email-test` Worker, captures the refresh cookie. NO test mode bypass.
- `apps/nebula/test/browser/smoke.test.ts` — three-test smoke: boot regression + auth bootstrap + full NebulaClient round-trip (register ontology + fire transaction). Currently green in ~10.6s.
- `apps/nebula/test/browser/worker/index.ts` + `wrangler.jsonc` — full Nebula DO bindings + auth + Cloudflare Email Sending. `TestNebulaEmailSender` overrides `from` to `test@lumenize.io` (the production sender domain isn't verified).
- `browser-bench` vitest project already configured.
- `@lumenize/nebula/client` Node-safe subpath added so `NebulaClient` can be imported from Node test code without dragging in `cloudflare:workers`.

**Work remaining for Phase 1 if we go path (a)**:
- `bench.bench.ts` alongside `smoke.test.ts` — vitest bench mode. Cold = fresh Star (`uniqueStar()` each iteration; the smoke test already does this), warm = hot Star with N iterations against the same scope.
- The full Nebula transaction path is exercised by the existing smoke test #3: client → Gateway → Star Handler 1 (cache miss) → Galaxy `getOntology()` → Star Handler 2 (loads parser-validator facet, runs `parseBatch()`, writes transaction) → result delivered via mesh callback to the test client.
- Compare integrated numbers vs the bare GalaxyDO+StarDO bench from 5.2.4.1 Phase 6 — call out integration overhead from mesh routing + auth + result callback.
- Record numbers in `apps/nebula/test/browser/RESULTS.md`.

**Splits** (already in place):
- Smoke (and future reactivity tests for 5.3) → `npm test` from `apps/nebula/`. Deterministic assertions only.
- Bench → `npm run bench` from `apps/nebula/` (already wired). Records numbers, no flaky timing assertions.

**Out of scope (decided 2026-04-28)**: tsc-baseline new-vs-old comparison. The post's framing is "what does facet-hosted typia validation cost in the integrated stack?", not "we beat the old engine." The qualitative win is already documented in `@lumenize/ts-runtime-parser-validator`'s `index.md` and the 2026-03-24 / 2026-03-25 conceptual posts. Skipping that comparison keeps 2b focused.

**Success Criteria**:
- [x] Facet beta-status risks documented (one paragraph, fed back into 2b's post draft if material) — see Phase 0 findings above
- [x] `apps/nebula/test/browser/` harness built; smoke test passes against auto-spawned `wrangler dev` — shipped 2026-04-28 with the harness task
- [ ] Integrated cold/warm p50/warm p99 numbers recorded in `apps/nebula/test/browser/RESULTS.md` — only if path (a) chosen
- [ ] Integration overhead vs bare bench documented (one sentence per row) — only if path (a) chosen

## Phase 2: Paired blog posts

Two posts written together, published together, cross-linked. 2a is the user-facing release announcement (Lumenize/Nebula audience); 2b is the technical deep-dive (Cloudflare community). Sequencing them as a pair means each can lean on the other rather than redundantly covering motivation + cost in both.

### Phase 2a: Release announcement (Lumenize/Nebula audience)

The conceptual frame is already in place via two existing posts that launched `@lumenize/ts-runtime-validator`:
- [index.md](./../website/blog/2026-03-24-typescript-is-the-schema/index.md) — why TS interfaces beat parallel Zod / JSON Schema definitions
- [index.md](./../website/blog/2026-03-25-write-your-types-once/index.md) — the "you write types four times" pain pitch

The new announcement is a shorter follow-up that inherits the frame and announces what's new, not a fresh ground-up essay.

**Content** (target: ~half the scope of the conceptual posts above):
- What changed under the hood: typia engine replaces tsc, parse-not-just-validate semantics, `@default` filling, DO facet hosting
- One paragraph on the facets-vs-plain-DW rationale: facets share the parent DO's isolate → same-isolate RPC, no network hop. (The package's `index.md` links to Cloudflare's facets announcement for "what are facets"; the release blog is the place for "why *we* picked them for this.")
- One-line cross-link to 2b for readers who want the latency numbers
- Mention `@lumenize/ts-runtime-validator` is being retired and link to the new package — Phase 3 below executes the actual `npm deprecate` once this post is live
- Cross-post per the content-distribution memory (Lumenize site + Substack + Medium)

### Phase 2b: Facet performance in practice (Cloudflare community)

**Why it's worth writing**: facets are new (announced 2026-04-13) and community guidance is thin. Our 5.2.4.1 Phase 6 benchmarks produced facet-specific numbers that answer questions other developers will have. Distinguishes Lumenize as having done the homework; pairs naturally with the release announcement.

**Headline framing**: real numbers distinguishing "DO facets are essentially free" (true for infrastructure/billing, Cloudflare's framing) from the per-call latency reality: **DO facets add \~262 ms cold-spawn and \~1.4 ms per-call latency** on top of whatever your DO setup already costs. The 1.4 ms is overwhelmingly the same-isolate RPC boundary (structured-clone + scheduler hop, ~1.35 ms); the typia parse itself is ~50 µs. (The post deliberately stays out of the DO cold-wake baseline — that's a separate cost everyone in DOs pays regardless, not something facets add.)

**Numbers to include** (from 5.2.4.1 Phase 6, expanded with Phase 1 above):

| Metric | Number | Source |
| --- | --- | --- |
| Facet cold-spawn (added on top of DO wake) | ~262 ms | 5.2.4.1 Phase 6 |
| Warm per-call latency (parse + RPC) | ~1.4 ms | 5.2.4.1 Phase 6 |
| &nbsp;&nbsp;↳ of which: facet RPC (structured-clone + scheduler hop) | ~1.35 ms | derivation |
| &nbsp;&nbsp;↳ of which: typia parse core | ~50 µs | 5.2.4.1 Phase 6 |
| Bundle size, 30-type ontology | 119 KB | 5.2.4.1 Phase 6 |
| Integrated cold (Galaxy fetch + facet load + first parse) | TBD | Phase 1 here |
| Integrated warm p50 / p99 | TBD | Phase 1 here |

The "added on top of DO wake" framing keeps the focus on facet-specific cost without dragging readers through the DO infrastructure baseline.

**Content checklist**:
- Lead with the facet-specific number (262 ms cold-spawn) and the warm number (1.4 ms parse). Make those the headline.
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
- [ ] **`@lumenize/ts-runtime-parser-validator` published to npm** via `/release-workflow`. The deprecate message points at this package; it must exist on the registry before the message goes live.
- [ ] **Release announcement (Phase 2a) is published** so the URL substituted into the deprecate message resolves.

**Work**:
- Run: `npm deprecate @lumenize/ts-runtime-validator "Use @lumenize/ts-runtime-parser-validator instead — see https://lumenize.com/blog/<release-post-slug>"` (substitute the actual blog URL once published)
- Verify the deprecation banner appears on the npm package page

`npm deprecate` is reversible (`npm deprecate <pkg> ""` clears the message), but the message is publicly visible, indexed, and cached by tooling — treat as an external-action gate per CLAUDE.md "Executing actions with care."

**No migration guide** — per 5.2.4.1 Phase 7's decision, the new package is framed as a fresh package, not a successor. The blog post is the migration pointer.

**Success Criteria**:
- [ ] npm shows `@lumenize/ts-runtime-validator` as deprecated with the pointer message
- [ ] Deprecation message links to the published release post

## Combined Success Criteria

- [ ] Phase 1 measurement complete; numbers in `experiments/nebula-parse-integration-bench/RESULTS.md`
- [ ] Release-announcement post drafted at `website/blog/YYYY-MM-DD-parse-validate.md`; references the two existing conceptual posts rather than re-deriving the frame
- [ ] Facet-performance post drafted at `website/blog/YYYY-MM-DD-facet-performance-in-practice.md`; leads with facet-specific cost (cold-spawn + warm parse), avoids the DO cold-wake baseline framing
- [ ] Reproducer link points at the committed benchmark fixture (`packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts`) and bench scripts in `experiments/ts-runtime-parser-validator-spike/` (bare facet) + `experiments/nebula-parse-integration-bench/` (integrated stack)
- [ ] Both posts cross-link
- [ ] Cross-post per `reference_content_distribution.md` (Lumenize site + Substack + Medium)
- [ ] Pre-Phase 3 gates met: docs review pass, `@lumenize/ts-runtime-parser-validator` published to npm, release post live
- [ ] `@lumenize/ts-runtime-validator` deprecated on npm with pointer to the new package and the release post
