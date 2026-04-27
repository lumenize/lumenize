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

**Goal**: Measure the *integrated* facet cost — Galaxy + Star + mesh routing + facet — on top of the bare facet numbers already known from 5.2.4.1 Phase 6 (cold ~1.7 s, warm ~1.4 ms deployed). The implementation tests in 5.2.4.2 already validated correctness; this phase measures the cost.

**Phase 0 — facet beta-status check** (do *first*, before any benchmark work): any Cloudflare API-stability signals, GA timing announcements, or known regressions worth knowing about before we build a public-facing post around the technology? If facets have been flagged as moving or unstable, surface that — the post's tone shifts from "use this in production" to "early-look" depending on what we find.

**Work**:
- Benchmark Worker wrapping the deployed Galaxy + Star + facet stack at `experiments/nebula-parse-integration-bench/`. Drive: client → Gateway → Star Handler 1 (cache miss) → Galaxy `getLatestOntologyVersion()` → Star Handler 2 (load facet from row, run `parseBatch()`, write transaction) → response.
- Measure end-to-end:
  - Cold path: Star wake + Galaxy fetch + facet load + first parse
  - Warm path p50 / p99: subsequent transactions on a hot Star
- **tsc-baseline spike**: a parallel Worker wrapping the old `@lumenize/ts-runtime-validator` so 2b can cite new-vs-old side by side. Lives at `experiments/ts-runtime-validator-baseline/` (sibling to the existing `experiments/ts-runtime-parser-validator-spike/`; keeping the two engines in separate dirs avoids cross-contaminating their failure modes per the experiments-aren't-maintained convention in CLAUDE.md). New work — *not* a pre-existing 5.2.4.1 follow-up; that task closed Phase 6 without an open tsc-baseline item.
- Compare integrated numbers vs the bare GalaxyDO+StarDO bench from 5.2.4.1 Phase 6 — call out integration overhead from mesh routing.

**Success Criteria**:
- [ ] Facet beta-status risks documented (one paragraph, fed back into 2b's post draft if material)
- [ ] Integrated cold/warm p50/warm p99 numbers recorded in `experiments/nebula-parse-integration-bench/RESULTS.md`
- [ ] tsc-baseline spike numbers in `experiments/ts-runtime-validator-baseline/RESULTS.md`
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
| tsc-baseline equivalents (cold, warm) | TBD | Phase 1 here |

The "added on top of DO wake" framing keeps the focus on facet-specific cost without dragging readers through the DO infrastructure baseline.

**Content checklist**:
- Lead with the facet-specific number (262 ms cold-spawn) and the warm number (1.4 ms parse). Make those the headline.
- Include the 30-type benchmark fixture (`packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts`) so readers can reproduce.
- Specific guidance on when facets are right (dynamic code hot-swap, per-tenant sandboxed code, ontology-driven schemas) vs wrong (sub-ms per-call latency requirements with no hot-swap need).
- Apply the framing rules from `feedback_cf_community_framing.md` — Cloudflare's "essentially free" is true at the layer they meant (billing/infra); we're adding the per-call latency view, not contradicting.
- Cite the new-vs-old tsc-baseline numbers from Phase 1's spike.
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

- [ ] Phase 1 measurement complete; numbers in `experiments/nebula-parse-integration-bench/RESULTS.md` and `experiments/ts-runtime-validator-baseline/RESULTS.md`
- [ ] Release-announcement post drafted at `website/blog/YYYY-MM-DD-parse-validate.md`; references the two existing conceptual posts rather than re-deriving the frame
- [ ] Facet-performance post drafted at `website/blog/YYYY-MM-DD-facet-performance-in-practice.md`; leads with facet-specific cost (cold-spawn + warm parse), avoids the DO cold-wake baseline framing
- [ ] Reproducer link points at the committed benchmark fixture and the bench scripts in `experiments/ts-runtime-parser-validator-spike/` and `experiments/ts-runtime-validator-baseline/`
- [ ] Both posts cross-link
- [ ] Cross-post per `reference_content_distribution.md` (Lumenize site + Substack + Medium)
- [ ] Pre-Phase 3 gates met: docs review pass, `@lumenize/ts-runtime-parser-validator` published to npm, release post live
- [ ] `@lumenize/ts-runtime-validator` deprecated on npm with pointer to the new package and the release post
