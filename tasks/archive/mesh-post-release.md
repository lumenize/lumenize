# Mesh Post-Release Improvements

**Status**: Complete

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
- [x] Marked `draft: true` initially; publish after Phase 3 (Hono example) is complete

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

**Hono-specific research findings**:
- Hono middleware signature: `(c: Context, next: () => Promise<void>) => ...`. Access env via `c.env`, raw Request via `c.req.raw`. Return a `Response` to short-circuit; call `await next()` to pass through.
- `createAuthRoutes` works as Hono middleware with a thin wrapper: `app.use('/auth/*', async (c, next) => { const res = await authRoutes(c.req.raw); if (res) return res; await next(); })`. The prefix is redundant (auth routes reads `LUMENIZE_AUTH_PREFIX` from env) but serves as documentation and minor perf optimization.
- Auth hooks (`onBeforeRequest`/`onBeforeConnect`) have signature `(request, context: HookContext)` where `HookContext = { doNamespace, doInstanceNameOrId }`. This doesn't match Hono's `(c, next)`. Solution: call hooks from within a Hono middleware, passing `c.req.raw` and a context object. The wrapper is ~5 lines inline. Start with inline wrapper; consider exporting `createHonoAuthMiddleware` only if it looks too noisy.
- WebSocket + Hono + Durable Objects: do NOT use Hono's `upgradeWebSocket()` helper. Instead, detect `Upgrade: websocket` header in the Hono route handler, call `onBeforeConnect` hook, then forward `c.req.raw` to the DO stub. This is the pattern recommended by Hono maintainers (honojs/hono#3206).
- `c.env` is automatically populated when `app.fetch(request, env, ctx)` is called — no manual wiring needed.
- Module-level `import { env } from 'cloudflare:workers'` is available as an alternative for env access outside request context, but `c.env` is the idiomatic Hono approach.

**Approach**:

_Test setup (follows e2e-email pattern — real Resend → real EmailTestDO → WebSocket verification):_
- Install `hono` as `devDependency` in `packages/auth` (MIT ✅, excellent Workers compat ✅)
- New directory: `packages/auth/test/hono/`
  - `wrangler.jsonc` — same bindings as `test/e2e-email/` (self-referencing `AUTH_EMAIL_SENDER` service binding, `LUMENIZE_AUTH` DO, rate limiter)
  - `test-harness.ts` — Hono-based Worker entry point: mounts `createAuthRoutes` as middleware, wires auth hooks on protected routes, exports `LumenizeAuth` + `AuthEmailSender`
  - `hono-integration.test.ts` — E2E integration test: request magic link → real email delivery → extract link → complete auth flow (same as e2e-email but routed through Hono)
- New vitest project in `vitest.config.js` (name: `hono`, testTimeout: 30000, wrangler config pointing to `test/hono/wrangler.jsonc`)
- Reuse `email-test-helpers.ts` from `test/e2e-email/` (import, not symlink)
- Run `scripts/setup-symlinks.sh` to ensure `.dev.vars` symlink is created for the new `test/hono/` directory (since it has its own `wrangler.jsonc`)

_Note: e2e-email test currently runs in ~1.5s despite 30s timeout — verify this holds for the Hono test too (seems too good to be true)._

_Hono test harness pattern:_
```
// Auth routes — createAuthRoutes as Hono middleware
app.use('/auth/*', async (c, next) => {
  const res = await authRoutes(c.req.raw);
  if (res) return res;
  await next();
});

// Protected HTTP routes — auth hooks as Hono middleware
app.use('/api/*', async (c, next) => {
  const result = await onBeforeRequest(c.req.raw, { doNamespace: ..., doInstanceNameOrId: ... });
  if (result instanceof Response) return result;
  // result is enhanced Request with Authorization header — store for downstream
  c.set('authedRequest', result);
  await next();
});

// WebSocket upgrade — detect header, call onBeforeConnect, forward to DO
app.get('/ws/:binding/:id', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected WebSocket', 426);
  const result = await onBeforeConnect(c.req.raw, { doNamespace: ..., doInstanceNameOrId: ... });
  if (result instanceof Response) return result;
  // Forward enhanced request to DO
  const stub = doNamespace.get(doNamespace.idFromName(id));
  return stub.fetch(result);
});
```

_Docs:_
- Create `website/docs/auth/hono.mdx` — "Using with Hono" page with `@check-example` annotations pointing to the test harness
- Add `'auth/hono'` to `website/sidebars.ts` in the Auth category after `'auth/getting-started'`

_Blog post:_
- Update `website/blog/2026-02-11-lumenize-auth-standalone/index.md`: change "same convention" Hono mention to "drop-in Hono integration" with link to `/docs/auth/hono`
- Remove `draft: true` from frontmatter (final step)

**Success Criteria**:
- [x] `hono` added as `devDependency` in `packages/auth`
- [x] E2E integration test in `packages/auth/test/hono/` with Hono-based test harness, real email flow
- [x] New vitest project configured in `vitest.config.js`
- [x] New `website/docs/auth/hono.mdx` page with `@check-example` annotations
- [x] `sidebars.ts` updated with `'auth/hono'` in the Auth category
- [x] Blog post updated with link to Hono docs page and "drop-in" wording
- [x] `draft: true` removed from auth standalone blog post
- [x] `npm run check-examples` passes
- [x] `npm run build` in `/website` passes
- [x] All tests pass (including new Hono e2e test)

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
