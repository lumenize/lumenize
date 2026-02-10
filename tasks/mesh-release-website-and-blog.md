# Mesh Release: Website, Docs & Blog

**Status**: In Progress

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
    3. **Package changes**: For existing users. Rpc deprecated, utils→routing, fetch replaces proxy-fetch, debug standalone. Concise migration guide. Links back to announcement.

## Phases

### Phase 1: Home Page Rewrite

**Goal**: Landing page centers on Lumenize Mesh as the primary offering.

**Success Criteria**:
- [ ] Tagline updated in `docusaurus.config.ts` — something like "A de✨light✨fully radical new way to build on Cloudflare Workers and Durable Objects"
- [ ] OG/meta description tags match new tagline
- [ ] 4 hero feature cards in `HomepageFeatures/index.tsx`:
  1. True Mesh Networking — clients as full mesh peers, expands on Durable Object's actor programming model vibe
  2. Secure by Default — required auth and access control
  3. Rich Types Everywhere — structured clone to the browser
  4. De✨light✨ful DX & Quality — testing, docs, giants
- [ ] CTA button enabled, links to `/docs/mesh/getting-started`
- [ ] Layout CSS adjusted for 4-column grid (`col--3`)
- [ ] SVG icons for new cards (create, borrow from Lucide (e.g. https://lucide.dev/icons/drafting-compass) or reuse existing)
- [ ] `website` builds successfully

### Phase 2: Introduction Page Rewrite

**Goal**: `/docs/introduction` reflects current state — Mesh is here, not "coming soon."

**Success Criteria**:
- [ ] Remove "Today (October 2025)" and "Coming soon" framing
- [ ] Evergreen Mesh-first narrative: what Lumenize is, why it exists
- [ ] Links to both blog posts (announcement for newcomers, package changes for existing users)
- [ ] Updated release status table:
  - @lumenize/mesh — beta, MIT
  - @lumenize/auth — beta, MIT
  - @lumenize/testing — GA, MIT
  - @lumenize/debug — GA, MIT
  - @lumenize/fetch — beta, MIT
  - @lumenize/structured-clone — GA, MIT
  - @lumenize/routing (was utils) — GA, MIT
  - @lumenize/rpc — deprecated, MIT
- [ ] Nebula teaser row in release table: "Lumenize Nebula — coming soon" with one-line description
- [ ] De✨light✨ful DX section refreshed
- [ ] `website` builds successfully

### Phase 3: Sidebar & Config Cleanup

**Goal**: Sidebar reflects new package hierarchy. Deprecated items are clearly marked.

**Success Criteria**:
- [ ] Mesh at top
- [ ] Auth next down
- [ ] RPC moved as a sub-section to Testing in sidebar, labeled `'RPC (deprecated)'`. Docs: Auto-generated-from-JSDocs need to be rewriten into .mdx files with types @check-exampled
- [ ] Utils section renamed to "Routing" (coordinate with Phase 5)
- [ ] TypeDoc plugins for rpc and utils/routing converted
- [ ] No broken links in `npm run build`

### Phase 4: Docs Tone Updates

**Goal**: Mesh, Auth, and RPC docs have appropriate framing for their new status.

**Success Criteria**:
- [ ] `mesh/index.mdx`: Add 2-3 paragraph problem→solution opening before existing content (DOs are powerful but isolated; Workers RPC doesn't extend to browsers; no built-in auth/access control → Mesh solves these). Keep existing content as-is — it's already good.
- [ ] `mesh/index.mdx`: Remove any "coming soon" language
- [ ] `auth/index.mdx`: "Why @lumenize/auth?" section — Cloudflare-native, passwordless, delegation
- [ ] `rpc/introduction.mdx`: Deprecation banner at top — use Mesh instead, remains as testing foundation
- [ ] `website` builds successfully

### Phase 5: Package Rename — @lumenize/utils to @lumenize/routing

**Goal**: Package name matches its actual content (routing utilities only).

**Success Criteria**:
- [ ] `packages/routing/` exists with updated `package.json` name
- [ ] All consuming packages updated: mesh, auth, testing, rpc, fetch, test-endpoints
- [ ] `website/docs/routing/` docs directory (rename from utils)
- [ ] Sidebar updated
- [ ] Docs: Auto-generated-from-JSDocs need to be rewriten into .mdx files with types @check-exampled
- [ ] `npm test` passes from monorepo root
- [ ] `npm run type-check` passes

### Phase 6: npm Deprecations

**Goal**: npm registry reflects package status changes.

**Success Criteria**:
- [ ] `npm deprecate @lumenize/rpc "Deprecated for production use. Use @lumenize/mesh. Remains as foundation for @lumenize/testing."`
- [ ] `npm deprecate @lumenize/utils "Renamed to @lumenize/routing"`

### Phase 7: Blog Posts (three posts)

**Goal**: Publish three blog posts targeting different audiences simultaneously.

**7a. Mesh Announcement** (`website/blog/2026-02-XX-announcing-lumenize-mesh/index.md`)
- Target: developers (HN, Discord, dev Twitter)
- [ ] Vision: DOs, Workers, and browser clients as equal mesh peers
- [ ] Key differentiators: what Mesh does that nothing else does
- [ ] Auth as the security story — secure by default, passwordless, delegation
- [ ] Link to getting-started guide
- [ ] Not marked `draft: true`

**7b. Introducing Lumenize Nebula** (`website/blog/2026-02-XX-introducing-lumenize-nebula/index.md`)
- Target: CEOs, CISOs, Founders (LinkedIn)
- [ ] Agentic software engineering platform built on Lumenize Mesh
- [ ] Business ontologies defined declaratively — think uber-ORM, distilled from Palantir Ontology / Microsoft equivalent
- [ ] Architecture: DO SQLite JSONB for document-db-style entity storage; no backend code required
- [ ] Developers upload ontology, front end hits it directly; Lumenize provides front-end framework
- [ ] Optional backend extensibility via Cloudflare's Dynamic Worker Loader
- [ ] Tone: sounds almost ready (even though months away)
- [ ] CTA: reach out to pilot or help build
- [ ] Links to Mesh announcement for the technical foundation
- [ ] Not marked `draft: true`

**7c. Package Changes** (`website/blog/2026-02-XX-lumenize-package-changes/index.md`)
- Target: existing Lumenize users
- [ ] @lumenize/rpc deprecated (use Mesh; remains as testing foundation)
- [ ] @lumenize/utils renamed to @lumenize/routing
- [ ] @lumenize/fetch (replaces proxy-fetch pattern)
- [ ] @lumenize/debug now standalone
- [ ] Migration table or checklist
- [ ] Links back to Mesh announcement
- [ ] Not marked `draft: true`

**All posts**: Existing `lumenize-mesh-vs-agents` draft stays separate (future post).

### Final Verification (every phase)
- [ ] `cd website && npm run build` — no broken links
- [ ] `cd website && npm run check-examples` — doc examples valid
- [ ] Visual review of affected pages

## Notes
- Phase 7 (blog) can be drafted in parallel with earlier phases
- Phases 1-4 are website-only — safe to do without touching packages
- Phase 5 is the most invasive (mechanical refactor across monorepo)
- Phase 6 requires npm publish credentials
