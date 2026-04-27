# Parse-Validate: Blog Posts + Integrated Measurement

**Status**: Not started — split out of `tasks/nebula-5.2.4.2-validator-galaxy-integration.md` on 2026-04-27 once the implementation phases (2, 3) had landed
**Depends on**: 5.2.4.2 phases 2, 3 landed (functional integration complete)
**Related**: Existing 5.2.4.1 task (archived) for the validator-package side; existing blog posts launching `@lumenize/ts-runtime-validator` set the conceptual frame this work inherits.

## Objective

Two paired blog posts that ship together and the measurement work that feeds the second post's numbers.

- **6a — Release announcement**: "the parse-validate pipeline is here, here's what changed, use it." User-facing, frames-and-pitches.
- **6b — Facet performance in practice**: "real numbers — what facets actually cost per call, when they're the right tool." Cloudflare-community technical deep-dive.

The reason this lives separately from 5.2.4.2's implementation work: the implementation phases (2, 3, 4, 5) are bounded code changes that ship under one PR. The blog + measurement work is a different shape — it's a benchmark experiment, a tsc-baseline spike, two drafts to write and cross-link, and cross-posting to three platforms. Splitting keeps each task internally coherent.

## Phase 1: Integrated measurement (feeds 6b)

**Goal**: Measure the *integrated* facet cost — Galaxy + Star + mesh routing + facet — on top of the bare facet numbers already known from 5.2.4.1 Phase 6 (cold ~1.7 s, warm ~1.4 ms deployed). The implementation tests in 5.2.4.2 already validated correctness; this phase measures the cost.

**Pre-implementation check** (do *first*, before any benchmark work): Cloudflare facet beta status. Any API-stability signals, GA timing announcements, or known regressions worth knowing about before we build a public-facing post around the technology? If facets have been flagged as moving or unstable, surface that — the post's tone shifts from "use this in production" to "early-look" depending on what we find.

**Work**:
- Benchmark Worker wrapping the deployed Galaxy + Star + facet stack via `apps/nebula/test/test-apps/baseline/` or a dedicated `experiments/nebula-parse-integration-bench/`. Drive: client → Gateway → Star Handler 1 (cache miss) → Galaxy `getLatestOntologyVersion()` → Star Handler 2 (load facet from row, run `parseBatch()`, write transaction) → response.
- Measure end-to-end:
  - Cold path: Star wake + Galaxy fetch + facet load + first parse
  - Warm path p50 / p99: subsequent transactions on a hot Star
- **tsc-baseline spike** (the open 5.2.4.1 Phase 6 follow-up): a parallel Worker wrapping the old `@lumenize/ts-runtime-validator` so 6b can cite new-vs-old side by side. Live on `experiments/ts-runtime-parser-validator-spike/` or a sibling dir.
- Compare integrated numbers vs the bare GalaxyDO+StarDO bench from 5.2.4.1 Phase 6 — call out integration overhead from mesh routing.

**Success Criteria**:
- [ ] Facet beta-status risks documented (one paragraph, fed back into 6b's post draft if material)
- [ ] Integrated cold/warm p50/warm p99 numbers recorded in `experiments/.../RESULTS.md` (or this file)
- [ ] tsc-baseline spike numbers captured in same RESULTS file
- [ ] Integration overhead vs bare bench documented (one sentence per row)

## Phase 6a: Release announcement

The conceptual frame is already in place via two existing posts that launched `@lumenize/ts-runtime-validator`:
- [index.md](./../website/blog/2026-03-24-typescript-is-the-schema/index.md) — why TS interfaces beat parallel Zod / JSON Schema definitions
- [index.md](./../website/blog/2026-03-25-write-your-types-once/index.md) — the "you write types four times" pain pitch

The new announcement is a shorter follow-up that inherits the frame and announces what's new, not a fresh ground-up essay.

**Content** (target: ~half the scope of the conceptual posts above):
- What changed under the hood: typia engine replaces tsc, parse-not-just-validate semantics, `@default` filling, DO facet hosting
- One paragraph on the facets-vs-plain-DW rationale: facets share the parent DO's isolate → same-isolate RPC, no network hop. (The package's `index.md` links to Cloudflare's facets announcement for "what are facets"; the release blog is the place for "why *we* picked them for this.")
- Deprecation of `@lumenize/ts-runtime-validator` with pointer to the new package
- Cross-post per the content-distribution memory (Lumenize site + Substack + Medium)

**Rationale for the timing**: writing the announcement after Nebula integration lets us describe the full working system (parse-validate + Galaxy/Star wiring + `@default` lifted into JSDoc + DO facet hosting) in one post, and avoids announcing something that might still hit integration snags.

## Phase 6b: Facet performance in practice (technical deep-dive)

**Why it's worth writing**: facets are new (announced 2026-04-13) and community guidance is thin. Our 5.2.4.1 Phase 6 benchmarks produced facet-specific numbers that answer questions other developers will have. Distinguishes Lumenize as having done the homework; pairs naturally with the release announcement.

**Headline framing**: real numbers distinguishing "DO facets are essentially free" (true for infrastructure/billing, Cloudflare's framing) from the per-call latency reality: **DO facets add \~262 ms cold-spawn and \~1 ms per-call RPC overhead** on top of whatever your DO setup already costs. (The post deliberately stays out of the DO cold-wake baseline — that's a separate cost everyone in DOs pays regardless, not something facets add.)

**Numbers to include** (from 5.2.4.1 Phase 6, expanded with Phase 1 above):

| Metric | Number |
| --- | --- |
| Facet cold-spawn (added on top of DO wake) | ~262 ms |
| Warm parse iteration | ~1.4 ms |
| Per-call RPC overhead (structured-clone + scheduler hop) | ~1 ms |
| Bundle size, 30-type ontology | 119 KB |
| Integrated cold (Galaxy fetch + facet load + first parse) | TBD from Phase 1 |
| Integrated warm p50 / p99 | TBD from Phase 1 |
| tsc-baseline equivalents | TBD from Phase 1 spike |

The "added on top of DO wake" framing keeps the focus on facet-specific cost without dragging readers through the DO infrastructure baseline.

**Content checklist**:
- Lead with the facet-specific number (262 ms cold-spawn) and the warm number (1.4 ms parse). Make those the headline.
- Include the 30-type benchmark fixture (`packages/ts-runtime-parser-validator/test/fixtures/benchmark-ontology-30.ts`) so readers can reproduce.
- Specific guidance on when facets are right (dynamic code hot-swap, per-tenant sandboxed code, ontology-driven schemas) vs wrong (sub-ms per-call latency requirements with no hot-swap need).
- Apply the framing rules from `feedback_cf_community_framing.md` — Cloudflare's "essentially free" is true at the layer they meant (billing/infra); we're adding the per-call latency view, not contradicting.
- Cite the new-vs-old tsc-baseline numbers from Phase 1's spike.
- CTA links back to the release post and to the `@lumenize/ts-runtime-parser-validator` package docs.

## Combined Success Criteria

- [ ] Phase 1 measurement complete; numbers in `experiments/.../RESULTS.md`
- [ ] Release-announcement post drafted at `website/blog/YYYY-MM-DD-parse-validate.md`; references the two existing conceptual posts rather than re-deriving the frame
- [ ] Facet-performance post drafted at `website/blog/YYYY-MM-DD-facet-performance-in-practice.md`; leads with facet-specific cost (cold-spawn + warm parse), avoids the DO cold-wake baseline framing
- [ ] Reproducer link points at the committed benchmark fixture and the bench script in `experiments/ts-runtime-parser-validator-spike/`
- [ ] Both posts cross-link
- [ ] Cross-post per `reference_content_distribution.md` (Lumenize site + Substack + Medium)
