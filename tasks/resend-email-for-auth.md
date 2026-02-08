# Resend Email Integration for @lumenize/auth

**Status**: Prerequisites Complete — Ready for Phase 1

## Objective

Unblock Lumenize Mesh shipping by making email provider setup a documented, user-facing part of `@lumenize/auth`, with [Resend](https://resend.com) as the recommended default. `@lumenize/auth` requires outgoing email for magic links, admin notifications, approval confirmations, and invites. The `HttpEmailService` class and `EmailService` interface already exist — what's missing is a convenience factory for Resend, documentation guiding users through email provider setup, and end-to-end verification that it all works.

Every developer deploying a Lumenize Mesh application will need their own email provider. This task makes that setup path clear and tested.

## Decision Context

Shipping `@lumenize/mesh` is blocked because auth requires outgoing email and Cloudflare's email sending service is still in closed beta with no GA date. Four alternatives were evaluated:

### Option 1: Resend.com as email API (CHOSEN)

`HttpEmailService` in `packages/auth/src/email-service.ts` was designed for exactly this — its docstring even uses Resend as the example. Instantiate `HttpEmailService` with Resend's endpoint and API key, map the four `EmailMessage` types to Resend's request format, document the setup for users, done. No changes to `@lumenize/auth`'s public API. Users (or we) can swap to a different provider later by writing a new `EmailService` implementation. Resend is a good documented default because it uses standard `fetch` (no SDK), has a generous free tier, works natively on Cloudflare Workers, and has clear domain verification docs.

- **Effort**: Hours for implementation, plus docs work
- **Risk**: Very low
- **Cost**: Each deployer needs their own Resend account — free tier covers 100 emails/day; $20/mo for 50K

### Option 2: OAuth2 (Google/GitHub) — Deferred

Replaces the "front door" (magic links → OAuth) while keeping the "back office" (subject management, JWT minting, refresh tokens, access gate). Requires new OAuth endpoints (redirect, callback, PKCE, token exchange), OAuth app registration with providers, and account-linking logic. Good future addition as a second login method, especially GitHub for developer audiences.

- **Effort**: Days to a week+
- **Risk**: Medium

### Option 3: Passkeys (WebAuthn) — Deferred

Best security model but has a bootstrapping problem: initial registration requires identifying the user first (via email or OAuth), so you still need another auth method. Also requires credential storage in the auth DO, recovery flows, and client-side WebAuthn API integration. Better as a third login method added later.

- **Effort**: 1–2 weeks
- **Risk**: Medium-high

### Option 4: External auth provider (Auth0) — Not Recommended

Auth0 and OIDC providers do expose public keys via `/.well-known/jwks.json` (answering the feasibility question), so the mesh client's custom `refresh` function could work with Auth0-issued JWTs. However, using Auth0 duplicates what `@lumenize/auth` already provides (subject management, access gate, refresh token rotation, key rotation, delegation) while adding cost and vendor lock-in. The hybrid approach (Auth0 for identity → auth DO mints its own JWT) adds complexity for marginal benefit.

- **Effort**: Medium
- **Risk**: Low-medium but architecturally awkward

### Future path

Ship with Resend now (Option 1). Add OAuth as a second login method later (Option 2). Consider passkeys as a third method once bootstrapping is solved (Option 3).

## Prerequisites (for lumenize.com testing) — DONE

These are what _we_ need to verify the integration against lumenize.com. Users will follow equivalent steps for their own domain as documented in Phase 2.

- [x] Resend account created (larry@lumenize.com)
- [x] `test.lumenize.com` domain verified in Resend — Cloudflare DNS configured for sending from `test.lumenize.com`
- [x] First test email sent successfully from Resend dashboard
- [x] Resend API key generated and added to `.dev.vars` as `RESEND_API_KEY`
- [x] `.dev.vars.example` updated with `RESEND_API_KEY` template entry

## Phase 1: Resend Convenience Factory + Verification

**Goal**: Provide a `createResendEmailService(options)` factory that users can call with their Resend API key and sender address, and verify it works end-to-end against lumenize.com.

**Success Criteria**:
- [ ] `createResendEmailService({ apiKey, from })` factory exported from `@lumenize/auth` — handles all four `EmailMessage` types with sensible HTML templates
- [ ] `RESEND_API_KEY` environment variable convention established (consistent with existing `TURNSTILE_SECRET_KEY`, `JWT_*` naming)
- [ ] HTML email templates render properly for all four message types (magic link, admin notification, approval confirmation, invite)
- [ ] Unit tests with `MockEmailService` still pass (no regressions)

**Notes**:
- The monolith's parallel auth implementation (`lumenize-monolith/src/magic-link-requested-handler.ts`) uses AWS SES directly. That's a separate system from `@lumenize/auth` and is not part of this task.
- `HttpEmailService` uses standard `fetch` internally — no SDK dependency needed. Resend's API is just `POST https://api.resend.com/emails` with JSON body. The factory wraps `HttpEmailService` with the Resend endpoint and a `buildBody` that maps all four `EmailMessage` discriminants.
- Users who prefer a different provider (AWS SES, Postmark, Mailgun, etc.) can implement `EmailService` directly or use `HttpEmailService` with their own config. The factory is a convenience, not a requirement.
- Consider whether the factory should live in `email-service.ts` alongside the existing classes, or in a separate `resend.ts` file. Keeping it in `email-service.ts` is simpler; separating avoids implying Resend is privileged.
- Real end-to-end verification happens in Phase 3 via the email testing infrastructure, not manually here.

## Phase 2: Documentation

**Goal**: Make email provider setup a documented part of the `@lumenize/auth` getting-started experience, so users deploying their own Lumenize Mesh application know what to do.

**Success Criteria**:
- [ ] `configuration.mdx` updated: add email provider section to the env vars table (`RESEND_API_KEY`), explain the `EmailService` interface and the `createResendEmailService` factory, note that `ConsoleEmailService` (the default) logs instead of sending — users must configure a real provider before deploying
- [ ] `getting-started.mdx` updated: add an "Email Provider" step (alongside existing Key Generation, Turnstile, Rate Limiting steps) walking users through Resend signup, domain verification, API key setup, and wiring in the factory
- [ ] JSDoc on `createResendEmailService` is thorough enough to stand alone (users who skip the docs should still be able to figure it out from editor hints)
- [ ] Note in docs that Resend is the documented default but any `EmailService` implementation works — link to `HttpEmailService` for users who want to bring their own provider
- [ ] Consider adding a :::warning similar to the Turnstile/rate-limiter warnings: "Without a configured email service, magic links and invites will not be delivered. Configure an email provider before deploying to production."

**Notes**:
- The existing docs already follow this pattern well — Turnstile and rate limiting are both documented as "recommended, with a warning if not configured." Email service should follow the same pattern.
- `configuration.mdx` is the reference; `getting-started.mdx` is the walkthrough. Both need updates.
- HTML email templates are hard-coded for now. The factory accepts a `from` address but not custom templates. Template customization is deferred — Cloudflare's outgoing email service (when it ships) is likely to include HTMLRewriter-based template support, which would be the right foundation for that feature.

## Phase 3: Email Testing Infrastructure

This phase absorbs the work from `tasks/never/email-testing-infrastructure.md`. The original task was blocked on wanting to use LumenizeDO (then called LumenizeBase) for the receiver DO — that blocker is resolved. The architecture is updated for Resend instead of AWS SES.

### Architecture

The EmailTestDO lives in its own separate Worker deployment with full auth hooks installed — dogfooding LumenizeDO, LumenizeClient, LumenizeClientGateway, and `createRouteDORequestAuthHooks` for the test infrastructure itself.

**Chicken-and-egg solution**: The test client authenticates to the EmailTest mesh using a `refresh` callback that mints JWTs locally with `signJwt` and the private key from `.dev.vars`. The hooks verify these JWTs normally against the public key — the Gateway is none the wiser. No auth bypass, no special routing. The `refresh` callback is called eagerly on connect, so the client has a valid token before the WebSocket upgrade.

```
                          EmailTest Worker               Auth Worker
                          (separate deployment,           (system under test)
                           full auth hooks)

┌─────────────┐                                    ┌─────────────┐
│   Test      │─── POST /auth/email-magic-link ──▶ │ Auth DO     │
│   Client    │                                    │             │
│             │                                    └──────┬──────┘
│  Lumenize-  │                                           │ Resend
│  Client w/  │                                           ▼
│  self-mint  │                                    ┌─────────────┐
│  refresh()  │                                    │  Resend API │
│             │                                    └──────┬──────┘
│             │                                           │ test.email
│             │                                           │ @lumenize.com
│             │                                           ▼
│             │                                    ┌─────────────┐
│             │                                    │  Cloudflare │
│             │                                    │  Email      │
│             │                                    │  Routing    │
│             │                                    └──────┬──────┘
│             │                                           │
│             │   ┌──────────────┐                        │
│             │◀──│ EmailTestDO  │◀───── email() ─────────┘
│             │   │ (extends     │
└─────────────┘   │ LumenizeDO)  │
   LumenizeClient │              │
   via Gateway    └──────────────┘
   (auth hooks      postal-mime
    verify self-     → WebSocket
    minted JWT)      notification
```

**Test flow**:
1. Test configures LumenizeClient with a `refresh` callback that mints JWTs using `signJwt` + private key from `.dev.vars`
2. LumenizeClient connects to EmailTestDO (through Gateway, auth hooks verify the self-minted JWT — full mesh dogfooding)
3. Test POSTs magic link request to the auth Worker (email to `test.email@lumenize.com`)
4. Auth DO sends email via Resend
5. Cloudflare Email Routing delivers to EmailTest Worker's `email()` handler
6. `EmailTestDO` parses email with `postal-mime`, extracts magic link URL
7. `EmailTestDO` sends parsed email over WebSocket to waiting test (via LumenizeDO → Gateway → LumenizeClient)
8. Test receives magic link, clicks it on the auth Worker, verifies full auth flow

### Phase 3a: EmailTestDO + Deployment

**Goal**: Build a LumenizeDO that receives emails via Cloudflare Email Routing and notifies connected LumenizeClients. Deploy as a separate Worker with full auth hooks.

**Success Criteria**:
- [ ] `EmailTestDO` extends `LumenizeDO` — location TBD (probably `tooling/email-test/`)
- [ ] Parses incoming emails with `postal-mime`
- [ ] Stores recent emails in SQLite (for debugging/verification)
- [ ] LumenizeClient subscribers receive email arrival notifications via the mesh
- [ ] Worker `email()` handler routes inbound email to the DO
- [ ] Worker has `createRouteDORequestAuthHooks` installed — test clients authenticate via self-minted JWTs
- [ ] Worker deployed to Cloudflare
- [ ] `test.email@lumenize.com` routes to the deployed worker via Cloudflare Email Routing
- [ ] Manual verification: send email to test address → see it in DO storage

**Notes**:
- Prior art exists in `lumenize-monolith/test/test-harness.ts` — has a working `email()` handler with `postal-mime` parsing and a `SimpleMimeMessage` builder for constructing test emails. The handler was never successfully deployed via wrangler ("I COULDN'T FIGURE OUT HOW TO DEPLOY AN EMAIL WORKER. I EDITED IN THE CLOUDFLARE DASHBOARD"). Investigate whether wrangler now supports email worker deployment or whether dashboard configuration is still required.
- `lumenize-monolith/test/simple-mime-message.ts` provides a reusable MIME message builder. Consider extracting it to a shared test utility.
- `lumenize-monolith/test/live-email-routing.test.ts` has a local email parsing test.
- The self-minting `refresh` callback pattern: `refresh: async () => { const jwt = await signJwt(payload, await importPrivateKey(key)); return { access_token: jwt, sub: 'test-harness' }; }`. Uses `signJwt` and `importPrivateKey` from `@lumenize/auth`. The private key comes from `.dev.vars` (same key pair whose public half is configured in the EmailTest Worker's env for hook verification).

### Phase 3b: Test Helpers + End-to-End Auth Flow Test

**Goal**: Build test utilities and an automated end-to-end test of the full magic link auth flow with real email delivery.

**Success Criteria**:
- [ ] `waitForEmail(client, options)` helper — subscribes via LumenizeClient to EmailTestDO, waits for matching email, returns parsed content
- [ ] `extractMagicLink(email)` helper — pulls magic link URL from parsed email body
- [ ] End-to-end test: request magic link → email delivered via Resend → received by EmailTestDO → test extracts and clicks magic link → exchange for tokens → refresh token works → JWT contains expected claims
- [ ] WebSocket auth flow tested: access token used in subprotocol → Gateway accepts connection
- [ ] `createRouteDORequestAuthHooks` verifies the JWT correctly (both `onBeforeRequest` and `onBeforeConnect`)
- [ ] Error cases verified: expired magic link, invalid token, rate limiting
- [ ] Test can be run locally (with secrets in `.dev.vars`) and eventually in CI

**Notes**:
- This replaces the manual "trigger magic link, check your inbox, eyeball it" approach. Every future auth change gets regression coverage.
- The test needs Resend credentials and Cloudflare Email Routing configured — document the required secrets for local and CI environments.
- The test exercises two separate auth paths: (1) self-minted JWTs for the EmailTestDO mesh connection, and (2) real magic-link-issued JWTs from the auth Worker. This is good — it validates both the JWT verification pipeline and the full auth issuance flow.

## Phase 4: Mesh Client Token Refresh Test

**Goal**: Verify `LumenizeClient`'s token refresh mechanism works end-to-end with `@lumenize/auth`, using the email testing infrastructure from Phase 3.

**Success Criteria**:
- [ ] `LumenizeClient` configured with `refresh: '/auth/refresh-token'` (string form) connects successfully
- [ ] Token expiry triggers automatic refresh without dropping the WebSocket connection
- [ ] Gateway re-verifies the refreshed JWT correctly
- [ ] A simple mesh call (Client → Gateway → DO → response) works with auth enabled

**Notes**:
- This is the critical path test: auth + mesh working together. If this works, we're unblocked for shipping.
- Uses the email testing infrastructure from Phase 3 to programmatically obtain tokens (no manual email checking).
- The custom `refresh` function form (`() => Promise<string>`) doesn't need testing here — it's the same code path on the client side, just a different token source.
- The `refresh` endpoint is served by the auth routes (`createAuthRoutes`), which proxies to the auth DO's refresh token rotation logic.

## Follow-on Considerations

- **Email template customization**: Templates are hard-coded for now. When Cloudflare's outgoing email service ships, it's likely to include HTMLRewriter-based template support — that would be the right time to add template customization to the factory. Until then, hard-coded templates with a configurable `from` address are sufficient.
- **Cloudflare email service**: When Cloudflare's outgoing email service reaches GA, we can add a `createCloudflareEmailService` factory alongside Resend. The `EmailService` interface makes this a clean addition. Template customization would naturally come with that effort.
- **Provider-agnostic guidance**: The docs should make clear that Resend is a recommended default, not a requirement. Users with existing email infrastructure (SES, Postmark, SendGrid, etc.) should feel empowered to implement `EmailService` or use `HttpEmailService` directly.

## Related

- `tasks/never/email-testing-infrastructure.md` — Subsumed into Phase 3 of this task
- `tasks/nebula-auth.md` — Future auth evolution for multi-tenant Nebula platform
- `tasks/todos-for-initial-mesh-release.md` — Release checklist (this task feeds into it)
- `website/docs/auth/configuration.mdx` — Env vars reference (needs email provider section)
- `website/docs/auth/getting-started.mdx` — Setup walkthrough (needs email provider step)
- `packages/auth/src/email-service.ts` — `HttpEmailService`, `ConsoleEmailService`, `MockEmailService`
- `packages/auth/src/types.ts` — `EmailService` interface and `EmailMessage` union type
- `lumenize-monolith/test/test-harness.ts` — Prior art: `email()` handler with `postal-mime`, deployment notes
- `lumenize-monolith/test/simple-mime-message.ts` — Prior art: MIME message builder for test emails
- `lumenize-monolith/test/live-email-routing.test.ts` — Prior art: local email parsing test
