# Mesh Release: Website, Docs & Blog

**Status**: In Progress

## Goal

Reorient lumenize.com around Lumenize Mesh as the anchor product, deprecate/rename older packages, and publish a release announcement blog post.

## Decisions

- **@lumenize/rpc**: Leave source as-is. Deprecate in npm and docs. Moving into testing would create a production circular dependency.
- **@lumenize/utils**: Rename to `@lumenize/routing` (all remaining exports are routing utilities).
- **Actors/LumenizeBase/Lumenize sidebar sections**: Already removed — no action needed.

## Phases

### Phase 1: Home Page Rewrite

**Goal**: Landing page centers on Lumenize Mesh as the primary offering.

**Success Criteria**:
- [ ] Tagline updated in `docusaurus.config.ts` — something like "A de✨light✨fully radical new way to build on Cloudflare Workers and Durable Objects"
- [ ] OG/meta description tags match new tagline
- [ ] 4 hero feature cards in `HomepageFeatures/index.tsx`:
  1. True Mesh Networking — clients as full mesh peers
  2. Secure by Default — required auth and access control
  3. Rich Types Everywhere — structured clone to the browser
  4. De✨light✨ful DX & Quality — testing, docs, giants
- [ ] CTA button enabled, links to `/docs/mesh/getting-started`
- [ ] Layout CSS adjusted for 4-column grid (`col--3`)
- [ ] SVG icons for new cards (create or reuse existing)
- [ ] `website` builds successfully

### Phase 2: Introduction Page Rewrite

**Goal**: `/docs/introduction` reflects current state — Mesh is here, not "coming soon."

**Success Criteria**:
- [ ] Remove "Today (October 2025)" and "Coming soon" framing
- [ ] Mesh-first narrative: what Lumenize is, why it exists
- [ ] Updated release status table:
  - @lumenize/mesh — beta, MIT
  - @lumenize/auth — beta, MIT
  - @lumenize/testing — GA, MIT
  - @lumenize/debug — GA, MIT
  - @lumenize/fetch — beta, MIT
  - @lumenize/structured-clone — GA, MIT
  - @lumenize/routing (was utils) — GA, MIT
  - @lumenize/rpc — deprecated, MIT
- [ ] Remove @lumenize/lumenize row (Nebula is not ready to announce)
- [ ] De✨light✨ful DX section refreshed
- [ ] `website` builds successfully

### Phase 3: Sidebar & Config Cleanup

**Goal**: Sidebar reflects new package hierarchy. Deprecated items are clearly marked.

**Success Criteria**:
- [ ] RPC moved below Testing in sidebar, labeled `'RPC (deprecated)'`
- [ ] Utils section renamed to "Routing" (or removed if docs aren't ready — coordinate with Phase 5)
- [ ] TypeDoc plugins for rpc and utils optionally removed or left as-is (low priority)
- [ ] No broken links in `npm run build`

### Phase 4: Docs Tone Updates

**Goal**: Mesh, Auth, and RPC docs have appropriate framing for their new status.

**Success Criteria**:
- [ ] `mesh/index.mdx`: "Why Lumenize Mesh?" section added near top — value prop, differentiation
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
- [ ] `npm test` passes from monorepo root
- [ ] `npm run type-check` passes

### Phase 6: npm Deprecations

**Goal**: npm registry reflects package status changes.

**Success Criteria**:
- [ ] `npm deprecate @lumenize/rpc "Deprecated for production use. Use @lumenize/mesh. Remains as foundation for @lumenize/testing."`
- [ ] `npm deprecate @lumenize/utils "Renamed to @lumenize/routing"`

### Phase 7: Blog Post

**Goal**: Publish an announcement blog post for Lumenize Mesh beta.

**Success Criteria**:
- [ ] Blog post at `website/blog/2026-02-XX-announcing-lumenize-mesh/index.md`
- [ ] Mesh-focused: vision, key features, what makes it different
- [ ] Sections covering Auth, Debug, Fetch
- [ ] Package changes summary (rpc deprecated, utils renamed)
- [ ] Not marked `draft: true`
- [ ] Existing `lumenize-mesh-vs-agents` draft stays separate (future post)

### Final Verification (every phase)
- [ ] `cd website && npm run build` — no broken links
- [ ] `cd website && npm run check-examples` — doc examples valid
- [ ] Visual review of affected pages

## Notes
- Phase 7 (blog) can be drafted in parallel with earlier phases
- Phases 1-4 are website-only — safe to do without touching packages
- Phase 5 is the most invasive (mechanical refactor across monorepo)
- Phase 6 requires npm publish credentials
