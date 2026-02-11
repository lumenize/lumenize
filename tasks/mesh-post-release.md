# Mesh Post-Release Improvements

**Status**: In Progress

## Objective

First round of post-release polish for Lumenize Mesh: close the getting-started gap (email setup), add real-world examples, and write the Gateway pattern blog post.

## Phase 0: Small Cleanup

**Goal**: Fix stale references left over from the alarms-into-mesh and utils→routing renames.

**Success Criteria**:
- [x] `continuations.mdx` line 68: changed to `this.svc.alarms`
- [x] `packages/mesh/src/ocan/index.ts` line 5: updated to `this.svc.alarms` and `@lumenize/fetch`
- [x] `packages/mesh/src/ocan/execute.ts` line 276: updated `@lumenize/proxy-fetch` → `@lumenize/fetch`
- [x] `packages/mesh/test/lumenize-do.test.ts` line 96: updated stale comment
- [x] Scanned — remaining `@lumenize/alarms` refs are only in `_archived/` docs and `tasks/archive/` (fine to leave)

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
- [x] Email setup is a dedicated step in `mesh/getting-started.mdx` (new Step 8), not bundled with Turnstile/rate limiting
- [x] Developer can follow the mesh guide end-to-end and receive a magic-link email without referencing any other page
- [x] `auth/getting-started.mdx` remains the canonical reference for template customization and BYOP — auth is a standalone package usable in any Cloudflare Workers/DO project, not just Mesh
- [x] `npm run build` in `/website` passes (no broken links)
- [x] `npm run check-examples` passes (121 examples, including the new `@check-example` for `auth-email-sender.ts`)

## Phase 2: Lumenize Auth Standalone Blog Post

**Goal**: A short blog post positioning `@lumenize/auth` as a standalone offering for any Cloudflare Workers/DO project — even if you never adopt Mesh.

**Context**: Auth is a hook for developers who already have a Workers system but want passwordless auth that's Cloudflare-native, not a bolted-on SaaS. A few paragraphs, link-heavy, shareable on social media. Points to the auth docs and makes the case: zero external auth services, passwordless by default, delegation model for DO access control, works with `routeDORequest` or your own routing.

**Success Criteria**:
- [x] Blog post in `website/blog/2026-02-11-lumenize-auth-standalone/` — 4 paragraphs, links to auth docs throughout
- [x] Positions auth as usable without Mesh — "Works with any Workers project" section
- [x] Mentions key differentiators: Cloudflare-native (no external auth service), passwordless, delegation, key rotation
- [x] Links back to Mesh announcement for developers who want the full stack
- [x] Mentions Hono compatibility (same `Response | undefined` convention)
- [x] DIY escape hatch — links to auth header contract for developers who want to wire their own routing
- [ ] Marked `draft: true` initially; publish after Phase 3 (Hono example) is complete

## Phase 3: Hono Integration Example and Docs

**Goal**: A tested example showing `@lumenize/auth` wired into a Hono-based Cloudflare Worker, plus a short docs page. On completion, publish the auth standalone blog post (remove `draft: true`).

**Context**: Many Cloudflare Workers developers use Hono as their routing framework. `createAuthRoutes` already returns `(Request) => Promise<Response | undefined>` and the auth hooks return `Response | Request | undefined` — both follow the standard middleware shape. We should prove this with a real test, then document it.

**Research findings** (confirmed by reading source):
- `createAuthRoutes(env)` returns `(request: Request) => Promise<Response | undefined>` — returns `Response` for `/auth/*` routes, `undefined` otherwise. Source: `packages/auth/src/create-auth-routes.ts` lines 22-25, 64, 123.
- `createRouteDORequestAuthHooks(env)` returns `Promise<{ onBeforeRequest: RouteDORequestHook; onBeforeConnect: RouteDORequestHook }>`. Source: `packages/auth/src/hooks.ts` lines 186-188.
- Hook type: `(request: Request, context: HookContext) => Promise<Response | Request | undefined>`. Returns `Response` to block (401/403/429), `Request` to enhance and forward (adds `Authorization` header with verified JWT), never returns `undefined` in practice. Source: `packages/auth/src/hooks.ts` lines 15-16, 214-254.
- `routeDORequest` handles hook results: `Response` → return immediately, `Request` → replace request and continue, `undefined`/`void` → continue unchanged. Source: `packages/routing/src/route-do-request.ts` lines 287-327.
- The codebase already documents this as following "hono convention" in `website/docs/testing/usage.mdx:181` and `website/docs/mesh/services.mdx:181`.
- The blog post at `website/blog/2026-02-11-lumenize-auth-standalone/index.md` already mentions Hono compatibility and needs `draft: true` removed as the last step of this phase.

**Approach**:
- Look at existing `packages/auth/test/for-docs/` tests (especially `quick-start.test.ts` and `email-sender.test.ts`) for patterns — these are vitest-pool-workers integration tests
- Create a new test (e.g., `packages/auth/test/for-docs/hono-integration.test.ts`) that wires `createAuthRoutes` and auth hooks into a Hono app
- The test needs its own DO bindings — check if the existing `packages/auth/test/for-docs/` wrangler.jsonc already has what's needed or if a new mini-app is required
- Hono will need to be installed (`npm install hono`) — check license (MIT ✅) and Workers compatibility (excellent ✅)
- Create `website/docs/auth/hono.mdx` with `@check-example` annotations pointing to the test
- Update `website/sidebars.ts` to include the new page under the auth section
- Final step: remove `draft: true` from `website/blog/2026-02-11-lumenize-auth-standalone/index.md`

**Success Criteria**:
- [ ] Integration test in `packages/auth/test/for-docs/` showing Hono + `createAuthRoutes` + auth hooks
- [ ] New `website/docs/auth/hono.mdx` page with `@check-example` annotations pointing to the test
- [ ] `npm run check-examples` passes
- [ ] `npm run build` in `/website` passes
- [ ] `sidebars.ts` updated to include the new page
- [ ] `draft: true` removed from auth standalone blog post; website redeployed

--- STOP HERE FOR MORE PLANNING AND FLESHING OUT THE FOLLOWING PHASES ---

## Phase 4: Working Document Editor Example

**Goal**: A complete, deployable system example that developers can clone and run.

**Success Criteria**:
- [ ] Document editor example works end-to-end (browser ↔ Gateway ↔ DO)
- [ ] Deploy to Cloudflare button (or clear deploy instructions)
- [ ] UI framework decision made and documented
- [ ] Example linked from mesh docs

## Phase 5: Agent Example

**Goal**: At least one example showing how to use Mesh with Cloudflare's Agent pattern.

**Success Criteria**:
- [ ] Working example with `@lumenize/testing` AgentClient
- [ ] Demonstrates a practical use case (not just echo)
- [ ] Linked from mesh docs

## Phase 6: Gateway Pattern Blog Post

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
