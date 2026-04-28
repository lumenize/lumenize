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

**Status (2026-04-28)**: **Blocked on `tasks/nebula-deployable-and-browser-harness.md`** — that task split out after Phase 1 work discovered Nebula doesn't currently start under real `wrangler dev` (a deploy-blocking bug previously hidden by vitest-pool-workers' miniflare). The browser-harness scaffolding that was started for Phase 1 lives at `apps/nebula/test/browser/` and is owned by that task now.

**Two paths once that task lands**:
- (a) Resume Phase 1 here — the integrated bench becomes a thin `bench.bench.ts` on top of the harness.
- (b) Skip Phase 1 — go straight to drafting 2a/2b with bare-facet numbers (5.2.4.1 Phase 6) and a "integration overhead is its own post" footnote. Decide when we get there; the bare numbers may already be enough for 2b's argument.

**Goal**: Measure the *integrated* facet cost — Galaxy + Star + mesh routing + facet — on top of the bare facet numbers already known from 5.2.4.1 Phase 6 (cold ~1.7 s, warm ~1.4 ms deployed). The implementation tests in 5.2.4.2 already validated correctness; this phase measures the cost.

**Phase 0 — facet beta-status check** (do *first*, before any benchmark work): any Cloudflare API-stability signals, GA timing announcements, or known regressions worth knowing about before we build a public-facing post around the technology? If facets have been flagged as moving or unstable, surface that — the post's tone shifts from "use this in production" to "early-look" depending on what we find.

**Phase 0 findings (2026-04-27)** — *low risk; "use it now, beta-status disclosed" tone is appropriate, no early-look framing needed:*
- Status unchanged since 2026-04-13 launch: **beta on Workers Paid plan**. Two weeks elapsed.
- No GA timing announcement, no breaking-change entries, no regressions in either the [Durable Objects changelog](https://developers.cloudflare.com/changelog/product/durable-objects/) (latest entry 2026-02-24, pre-launch) or the [Workers Platform changelog](https://developers.cloudflare.com/workers/platform/changelog/). Most recent Durable Objects release-notes update is also silent on facets.
- Adjacent Dynamic Workers / Worker Loader API is still receiving **additive** enhancements (2026-04-17 "passing custom limits for dynamic workers"; nullable bundle names). Additive, not breaking — signals an evolving but compatible surface.
- **Implication for 2b**: the post should explicitly state "facets are currently in beta" with a link to Cloudflare's [launch announcement](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/), but no need to hedge the architectural recommendation. We're using a stable beta of an evolving feature, not betting on shifting sand.

**Approach (decided 2026-04-28)**: build a **vitest-browser-mode harness** at `apps/nebula/test/browser/` rather than a one-off experiment dir. Reusable infrastructure for upcoming 5.3 reactivity tests, naturally exercises NebulaClient end-to-end in a real browser (Playwright/Chromium), and the browser's wall clock isn't subject to Cloudflare Worker isolate's `performance.now()` pinning. The bench becomes a thin `vitest bench` mode file on top of the harness.

**Work**:
- Add `apps/nebula/test/browser/` vitest project: `globalSetup.ts` auto-spawns `wrangler dev` against the existing `test-apps/baseline/test/wrangler.jsonc`, picks a free port, exports the base URL via env var, tears down on teardown. Same DX as vitest-pool-workers — no manual prerequisite. (Pattern is reusable; consider retrofitting to Lumenize Mesh tests too — noted in 5.3 task.)
- `bench-client.ts`: `NebulaClientBench extends NebulaClient` with `@mesh()` overrides for `handleTransactionResult` / `handleReadResult` (mirrors `NebulaClientTest`'s pattern but lives browser-side).
- `auth-bootstrap.ts`: `?_test=true` magic-link → access JWT helper. Same shortcut already used by vitest tests via `Browser`, just driven from browser-side fetch + cookies.
- `smoke.test.ts`: full transaction round-trip from real browser → wrangler dev → Galaxy/Star/facet → callback. Proves the platform works before bench numbers are trusted.
- `bench.bench.ts`: vitest bench mode — cold/warm transaction timings using the same harness. Cold = fresh Star (newUniqueId per iteration), warm = hot Star with N iterations.
- The full Nebula transaction path is exercised: client → Gateway → Star Handler 1 (cache miss) → Galaxy `getLatestOntologyVersion()` → Star Handler 2 (load facet from row, run `parseBatch()`, write transaction) → result delivered via callback to NebulaClientBench.
- Compare integrated numbers vs the bare GalaxyDO+StarDO bench from 5.2.4.1 Phase 6 — call out integration overhead from mesh routing + auth + result callback.

**Splits**:
- Smoke + reactivity (when 5.3 lands) → run with `npm test`. Deterministic assertions only.
- Bench (`bench.bench.ts`) → opt-in via `npm run bench` from the package root. Records numbers, no flaky pass/fail timing assertions.

**Out of scope (decided 2026-04-28)**: tsc-baseline new-vs-old comparison. The post's framing is "what does facet-hosted typia validation cost in the integrated stack?", not "we beat the old engine." The qualitative win is already documented in `@lumenize/ts-runtime-parser-validator`'s `index.md` and the 2026-03-24 / 2026-03-25 conceptual posts. Skipping that comparison keeps 2b focused.

**Success Criteria**:
- [x] Facet beta-status risks documented (one paragraph, fed back into 2b's post draft if material) — see Phase 0 findings above
- [ ] `apps/nebula/test/browser/` harness built; smoke test passes against auto-spawned `wrangler dev`
- [ ] Integrated cold/warm p50/warm p99 numbers recorded in `apps/nebula/test/browser/RESULTS.md`
- [ ] Integration overhead vs bare bench documented (one sentence per row)

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
