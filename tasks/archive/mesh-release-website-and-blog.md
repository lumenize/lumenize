# Mesh Release: Website, Docs & Blog

**Status**: Complete — All 9 phases done. Deferred items tracked in `tasks/mesh-post-release.md`.

## Goal

Reorient lumenize.com around Lumenize Mesh as the anchor product, deprecate/rename older packages, and publish a release announcement blog post.

## Decisions

- **@lumenize/rpc**: Leave source as-is. Deprecate in npm and docs. Moving source into testing is work and risk for very little gain — the package is being deprecated anyway and testing already depends on it cleanly.
- **@lumenize/utils**: Rename to `@lumenize/routing` (all remaining exports are routing utilities).
- **Actors/LumenizeBase/Lumenize sidebar sections**: Already removed — no action needed.
- **Content split across three surfaces**:
  - **Introduction page** (`introduction.mdx`): Evergreen "what is Lumenize and why?" — value prop, release status table, DX philosophy. Links to both blog posts.
  - **Mesh index** (`mesh/index.mdx`): Short problem→solution opening (DOs are powerful but isolated; RPC doesn't reach browsers; no built-in auth), then existing "what/how" content (node types, concepts, API). Not a big rewrite — the page is already good.
  - **Three blog posts**:
    1. **Mesh announcement**: The exciting one for developers. Vision, what makes it different, Auth as the security story. Share on HN/Discord.
    2. **Nebula preview**: The business story for CEOs, CISOs, Founders. Tease the agentic platform built on Mesh. CTA: reach out to pilot or help. Sounds almost ready even though months away. Share on LinkedIn.
    3. **Package changes**: For existing users. Rpc deprecated, utils→routing, proxy-fetch deprecated (use mesh + fetch), debug new (GA). Concise migration guide. Links back to announcement.

## Phases

### Phase 1: Home Page Rewrite ✅

**Goal**: Landing page centers on Lumenize Mesh as the primary offering.

**Success Criteria**:
- [x] Tagline updated in `docusaurus.config.ts` — "A de✨light✨fully radical new way to build on Cloudflare Workers and Durable Objects"
- [x] OG/meta description tags match new tagline
- [x] 4 hero feature cards in `HomepageFeatures/index.tsx`:
  1. True Mesh Networking — clients as full mesh peers, expands on Durable Object's actor programming model vibe
  2. Secure by Default — required auth and access control
  3. Rich Types Everywhere — structured clone to the browser
  4. De✨light✨ful DX & Quality — testing, docs, giants
- [x] CTA button enabled, links to `/docs/mesh/getting-started`
- [x] Layout CSS adjusted for 4-column grid (`col--3`)
- [x] SVG icons for new cards (network.svg, shield-check.svg from Lucide; reused puzzle.svg, drafting-compass.svg)
- [x] `website` builds successfully

### Phase 2: Introduction Page Rewrite ✅

**Goal**: `/docs/introduction` reflects current state — Mesh is here, not "coming soon."

**Success Criteria**:
- [x] Remove "Today (October 2025)" and "Coming soon" framing
- [x] Evergreen Mesh-first narrative: what Lumenize is, why it exists
- [x] Links to both blog posts (wrapped in MDX comments — TODO: uncomment when posts are published)
- [x] Updated release status table:
  - @lumenize/mesh — beta, MIT
  - @lumenize/auth — beta, MIT
  - @lumenize/testing — GA, MIT
  - @lumenize/debug — GA, MIT
  - @lumenize/fetch — beta, MIT
  - @lumenize/structured-clone — GA, MIT
  - @lumenize/routing (was utils) — GA, MIT
  - @lumenize/rpc — deprecated, MIT
- [x] Nebula teaser row in release table: "Lumenize Nebula — coming soon" with one-line description
- [x] De✨light✨ful DX section refreshed
- [x] `website` builds successfully

### Phase 3: Sidebar & Config Cleanup ✅

**Goal**: Sidebar reflects new package hierarchy. Deprecated items are clearly marked.

**Success Criteria**:
- [x] Mesh at top
- [x] Auth next down
- [x] RPC moved as a sub-section to Testing in sidebar, labeled `'RPC (deprecated)'`
- [x] Utils section renamed to "Routing" (doc paths still reference `utils/` files)
- [x] No broken links in `npm run build`
- [~] Docs: Auto-generated-from-JSDocs need to be rewritten into .mdx files with `@check-example`d types (deferred to `tasks/mesh-post-release.md`)

### Phase 4: Docs Tone Updates ✅

**Goal**: Mesh, Auth, and RPC docs have appropriate framing for their new status.

**Success Criteria**:
- [x] `mesh/index.mdx`: Add 2-3 paragraph problem→solution opening before existing content
- [x] `mesh/index.mdx`: Remove any "coming soon" language
- [x] `auth/index.mdx`: "Why @lumenize/auth?" section — Cloudflare-native, passwordless, delegation
- [x] `rpc/introduction.mdx`: Deprecation banner at top — use Mesh instead, remains as testing foundation
- [x] `website` builds successfully

### Phase 5: Package Rename — @lumenize/utils to @lumenize/routing ✅

**Goal**: Package name matches its actual content (routing utilities only).

**Success Criteria**:
- [x] `packages/routing/` exists with updated `package.json` name
- [x] All consuming packages updated: mesh, auth, testing, rpc, fetch, test-endpoints
- [x] Sidebar updated (label says "Routing", doc paths still reference `utils/`)
- [x] All 2,330 tests pass across 9 packages (`npm run test:code`)
- [x] `npm run type-check` passes
- [x] `website` builds successfully
- [x] `website/docs/utils/` docs directory rename to `routing/` (done post-release)
- [~] Docs: Auto-generated-from-JSDocs need to be rewritten into .mdx files with `@check-example`d types (deferred to `tasks/mesh-post-release.md`)

### Phase 6: Blog Posts (three posts) ✅

**Goal**: Draft three blog posts targeting different audiences simultaneously.

**6a. Mesh Announcement** (`website/blog/2026-02-10-announcing-lumenize-mesh/index.md`)
- Target: developers (HN, Discord, dev Twitter)
- [x] Vision: DOs, Workers, and browser clients as equal mesh peers
- [x] Key differentiators: what Mesh does that nothing else does
- [x] Auth as the security story — secure by default, passwordless, delegation
- [x] Link to getting-started guide
- [x] Marked `draft: true` (remove at publish time)

**6b. Introducing Lumenize Nebula** (`website/blog/2026-02-10-introducing-lumenize-nebula/index.md`)
- Target: CEOs, CISOs, Founders (LinkedIn)
- [x] Agentic software engineering platform built on Lumenize Mesh
- [x] Business ontologies defined declaratively — think uber-ORM, distilled from Palantir Ontology / Microsoft equivalent
- [x] Architecture: DO SQLite JSONB for document-db-style entity storage; no backend code required
- [x] Developers upload ontology, front end hits it directly; Lumenize provides front-end framework
- [x] Optional backend extensibility via Cloudflare's Dynamic Worker Loader
- [x] Tone: sounds almost ready (even though months away)
- [x] CTA: reach out to pilot or help build
- [x] Links to Mesh announcement for the technical foundation
- [x] Marked `draft: true` (remove at publish time)

**6c. Package Changes** (`website/blog/2026-02-10-lumenize-package-changes/index.md`)
- Target: existing Lumenize users
- [x] @lumenize/rpc deprecated (use Mesh; remains as testing foundation)
- [x] @lumenize/utils renamed to @lumenize/routing
- [x] @lumenize/fetch (replaces proxy-fetch pattern)
- [x] @lumenize/debug new (GA) — was never released as standalone; battle-tested internally
- [x] Migration table with before/after import examples
- [x] Links back to Mesh announcement
- [x] Marked `draft: true` (remove at publish time)

**All posts**: Existing `lumenize-mesh-vs-agents` draft stays separate (future post).

### Phase 7: Verification ✅

- [x] `cd website && npm run build` — no broken links (2 pre-existing broken anchors, unrelated)
- [x] `cd website && npm run check-examples` — all 116 code examples verified
- [x] All 2,330 tests pass across 9 packages

### Phase 8: npm Release

**Goal**: Publish all packages to npm with synchronized versions.

**Success Criteria**:
- [x] Follow `/release-workflow` process
- [x] Remove `draft: true` from blog posts (done for mesh announcement, package changes, nebula; mesh-vs-agents stays draft)
- [x] Uncomment blog post links in `introduction.mdx`
- [x] `packages/utils/` can be removed from the monorepo after `@lumenize/routing` is published (or kept as deprecated stub)
- [x] Verify published packages install correctly

### Phase 9: npm Deprecations

**Goal**: npm registry reflects package status changes. Run after Phase 8 release.

**Success Criteria**:
- [x] `npm deprecate @lumenize/rpc "Deprecated for production use. Use @lumenize/mesh. Remains as foundation for @lumenize/testing."`
- [x] `npm deprecate @lumenize/utils "Renamed to @lumenize/routing. Install @lumenize/routing instead."`
- [x] `npm deprecate @lumenize/proxy-fetch "Deprecated. Use @lumenize/mesh + @lumenize/fetch instead."`

## Deferred Items

These came up during execution but are tracked elsewhere:
- ~~**Rename `website/docs/utils/` directory to `routing/`**~~ — Done post-release.
- **Rewrite auto-generated TypeDoc pages** — Deferred to `tasks/mesh-post-release.md`.
- **Replace doc-testing generated docs** — Deferred to `tasks/mesh-post-release.md`.

## Notes
- Blog posts `draft: true` removed for mesh announcement, package changes, and nebula. Links in `introduction.mdx` uncommented. `mesh-vs-agents` stays draft (future post)
- Phases 1-4 were website-only — no package changes
- Phase 5 was the most invasive (mechanical refactor across 77 files in the monorepo)
- Phase 8 requires npm publish credentials and the `/release-workflow` process
- Phase 9 should run after Phase 8 so the replacement package is available when users see the deprecation notice
