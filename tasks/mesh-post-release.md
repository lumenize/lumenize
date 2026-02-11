# Mesh Post-Release Improvements

**Status**: In Progress

## Objective

First round of post-release polish for Lumenize Mesh: close the getting-started gap (email setup), add real-world examples, and write the Gateway pattern blog post.

## Phase 0: Small Cleanup

**Goal**: Fix stale references left over from the alarms-into-mesh and utils→routing renames.

**Success Criteria**:
- [ ] `continuations.mdx` line 68: change "`@lumenize/alarms` alarm handler" → "alarm handler" or "`this.svc.alarms`"
- [ ] `packages/mesh/src/ocan/index.ts` line 5: update JSDoc to remove `@lumenize/alarms` and `@lumenize/proxy-fetch` references
- [ ] Scan for any other stale `@lumenize/alarms` references in non-archived docs/source

## Phase 1: Email Setup in Mesh Getting Started

**Goal**: A developer following `mesh/getting-started.mdx` can actually send magic-link emails without having to discover the auth docs on their own.

**Context**: Currently, Step 8 lumps email provider setup with Turnstile and rate limiting as "optional but recommended." Turnstile and rate limiting _are_ optional for getting started. Email is not — without it, the auth flow silently fails (user sees "check your email" but nothing arrives). The content already exists in `auth/getting-started.mdx#email-provider`; it needs to be ported into the mesh guide.

**Approach**:
- Promote email setup out of Step 8 into its own required step (new Step 8; current Step 8 becomes Step 9)
- Port the Resend Quick Start content from `auth/getting-started.mdx` (lines 94–150): signup, API key, `AuthEmailSender` class, service binding
- Add a reassuring note: Resend signup takes ~5 minutes, free tier is 100 emails/day, and the only thing they need is to click the test button to confirm email arrives, then `wrangler secret put RESEND_API_KEY` for production
- Keep Step 9 as truly optional (Turnstile + rate limiting only)
- Keep auth/getting-started.mdx as the canonical deep reference (template customization, bring-your-own-provider) — mesh guide links there for advanced options

**Success Criteria**:
- [ ] Email setup is a dedicated step in `mesh/getting-started.mdx`, not bundled with Turnstile/rate limiting
- [ ] Developer can follow the mesh guide end-to-end and receive a magic-link email without referencing any other page
- [ ] `auth/getting-started.mdx` remains the canonical reference for template customization and BYOP — auth is a standalone package usable in any Cloudflare Workers/DO project, not just Mesh
- [ ] `npm run build` in `/website` passes (no broken links)
- [ ] `npm run check-examples` passes

## Phase 2: Lumenize Auth Standalone Blog Post

**Goal**: A short blog post positioning `@lumenize/auth` as a standalone offering for any Cloudflare Workers/DO project — even if you never adopt Mesh.

**Context**: Auth is a hook for developers who already have a Workers system but want passwordless auth that's Cloudflare-native, not a bolted-on SaaS. A few paragraphs, link-heavy, shareable on social media. Points to the auth docs and makes the case: zero external auth services, passwordless by default, delegation model for DO access control, works with `routeDORequest` or your own routing.

**Success Criteria**:
- [ ] Blog post in `website/blog/` — short (3–5 paragraphs), links to auth docs throughout
- [ ] Positions auth as usable without Mesh — "already have a Workers project? Drop this in"
- [ ] Mentions key differentiators: Cloudflare-native (no external auth service), passwordless, delegation, key rotation
- [ ] Links back to Mesh announcement for developers who want the full stack
- [ ] Marked `draft: true` initially, published after review

--- STOP HERE FOR MORE PLANNING AND FLESHING OUT THE FOLLOWING PHASES ---

## Phase 3: Working Document Editor Example

**Goal**: A complete, deployable system example that developers can clone and run.

**Success Criteria**:
- [ ] Document editor example works end-to-end (browser ↔ Gateway ↔ DO)
- [ ] Deploy to Cloudflare button (or clear deploy instructions)
- [ ] UI framework decision made and documented
- [ ] Example linked from mesh docs

## Phase 4: Agent Example

**Goal**: At least one example showing how to use Mesh with Cloudflare's Agent pattern.

**Success Criteria**:
- [ ] Working example with `@lumenize/testing` AgentClient
- [ ] Demonstrates a practical use case (not just echo)
- [ ] Linked from mesh docs

## Phase 5: Gateway Pattern Blog Post

**Goal**: Blog post explaining the Gateway pattern with latency benchmarks.

**Success Criteria**:
- [ ] Latency experiments completed:
  - [ ] Direct to DO round trip
  - [ ] Mesh round trip (expect ~+20ms)
  - [ ] Direct to DO → Worker → back to DO → back to client
  - [ ] Mesh three one-way calls (expect comparable to above)
- [ ] Blog post drafted with results and architectural explanation
- [ ] Marked `draft: true` initially, published after review

## Deferred

Items that are important but not in scope for this task file:

- **Rewrite auto-generated TypeDoc pages** — RPC and routing packages have auto-generated API docs from deprecated TypeDoc tooling. These should be rewritten as hand-authored `.mdx` with `@check-example` annotations.
- **Replace doc-testing generated docs** — Several packages still use the deprecated `tooling/doc-testing` plugin to generate `.mdx` from test files (marked with `generated_by: doc-testing` frontmatter). These need to be replaced with hand-written `.mdx` that uses `@check-example` annotations pointing back to the same tests. The `doc-testing` tooling itself is already marked deprecated.

## Notes

- Sourced from `tasks/todos-for-initial-mesh-release.md` "should-have" section and `tasks/mesh-release-website-and-blog.md` deferred items
- Max sub-request limit experiments moved to `tasks/mesh-resilience-testing.md` (Phase 7) and "could-have" in `todos-for-initial-mesh-release.md`
