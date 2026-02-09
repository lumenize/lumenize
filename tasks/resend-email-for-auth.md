# Resend Email Integration for @lumenize/auth

**Status**: Prerequisites Complete — Ready for Phase 1

## Objective

Unblock Lumenize Mesh shipping by making email provider setup a documented, user-facing part of `@lumenize/auth`, with [Resend](https://resend.com) as the temporary default until Cloudflare ships their outgoing email offering. `@lumenize/auth` requires outgoing email for magic links, admin notifications, approval confirmations, and invites.

Every developer deploying a Lumenize Mesh application will need their own email provider. This task makes that setup path clear and tested.

## Decision Context

Shipping `@lumenize/mesh` is blocked because auth requires outgoing email and Cloudflare's email sending service is still in closed beta with no GA date. Four alternatives were evaluated:

### Resend.com as email API (CHOSEN)

Resend is a good default because it uses standard `fetch` (no SDK), has a generous free tier, works natively on Cloudflare Workers, and has clear domain verification docs.

- **Effort**: Hours for implementation, plus docs work
- **Risk**: Very low
- **Cost**: Each deployer needs their own Resend account — free tier covers 100 emails/day; $20/mo for 50K

### Future path

Ship with Resend as default now. Switch default to Cloudfare when it's GA.

## Architecture: WorkerEntrypoint Pattern

### Design rationale

Rather than having the `LumenizeAuth` DO construct email services internally (which hides configuration and prevents template customization), email sending is delegated to a **WorkerEntrypoint** that the developer-user defines and exports from their Worker. The DO calls it via a service binding (`env.AUTH_EMAIL_SENDER`).

```
WorkerEntrypoint                   (Cloudflare)
  └─ AuthEmailSenderBase           (we provide — templates, subjects, from/appName)
       └─ ResendEmailSender        (we provide — implements sendEmail() via Resend fetch)
            └─ AuthEmailSender     (developer-user — sets vars/overrides methods)
```

This gives developer-users control over:
- **From address** — set as an instance variable
- **App name** — used in default templates, set as an instance variable
- **HTML templates** — override one, several, or all template methods

Additionally, if the developer-user wants, they can extend `AuthEmailSenderBase` to use any email provider they wish

```
WorkerEntrypoint                (Cloudflare)
  └─ AuthEmailSenderBase        (we provide — templates, subjects, from/appName)
      └─ AuthEmailSender        (developer-user — sentEmail()/sets vars/overrides methods)
```

### What the developer-user writes

**Minimal (zero template code):**

```typescript
// index.ts — the file they already maintain
import { ResendEmailSender } from '@lumenize/auth';

export class AuthEmailSender extends ResendEmailSender {
  from = 'auth@myapp.com';
}
```

That's it. `ResendEmailSender` extends `WorkerEntrypoint`, has a `send(message: EmailMessage)` method that builds HTML from default templates and POSTs to Resend using `this.env.RESEND_API_KEY`.

**Customized (override one or more templates):**

```typescript
export class AuthEmailSender extends ResendEmailSender {
  from = 'auth@myapp.com';
  appName = 'My App';  // used in default templates

  magicLinkHtml(message) {
    return `<h1>Welcome to My App</h1><a href="${message.magicLinkUrl}">Sign in</a>`;
  }
  // other 3 template methods use defaults
}
```

**Bring your own provider (no Resend):**

```typescript
import { AuthEmailSenderBase } from '@lumenize/auth';

export class AuthEmailSender extends AuthEmailSenderBase {
  from = 'auth@myapp.com';

  async sendEmail(to: string, subject: string, html: string) {
    // call Postmark, SES, whatever — templates and subjects are
    // already resolved by AuthEmailSenderBase.send()
  }
}
```

**wrangler.jsonc config:**

```jsonc
{
  "services": [
    {
      "binding": "AUTH_EMAIL_SENDER",
      "service": "my-worker-name",
      "entrypoint": "AuthEmailSender"
    }
  ]
}
```

### What we export from `@lumenize/auth`

1. **`AuthEmailSenderBase`** — extends `WorkerEntrypoint`. Provides default `send(message)` that dispatches to overridable template methods and a `sendEmail(to, subject, html)` method subclasses implement. Also provides default `subject` line methods that can be overridden. Has `from` and `appName` instance variables.

2. **`ResendEmailSender`** — extends `AuthEmailSenderBase`. Implements `sendEmail()` using `fetch` against `https://api.resend.com/emails` with `this.env.RESEND_API_KEY`. Developer-users extend this class.

3. **Default template functions** — exported for users who want to compose (call the default and wrap it).

### How the DO calls it

In `LumenizeAuth`, the `#emailService` pattern is replaced with direct service binding calls:

```typescript
// In lumenize-auth.ts — each send site
try {
  await (this.env as any).AUTH_EMAIL_SENDER?.send({
    type: 'magic-link',
    to: email,
    magicLinkUrl,
  });
} catch { /* existing error handling */ }
```

When `AUTH_EMAIL_SENDER` isn't configured (no service binding), optional chaining returns `undefined` and the call is a no-op.

### Missing binding warning

`createAuthRoutes()` checks for `env.AUTH_EMAIL_SENDER` at startup (same pattern as the existing Turnstile warning). In test mode, the check is skipped. When not in test mode, a `console.warn` is emitted:

> `[lumenize/auth] AUTH_EMAIL_SENDER is not configured — magic links and invites will not be delivered. See https://lumenize.com/docs/auth/getting-started#email-provider`

This matches the Turnstile convention: warn but don't block, so developer-users can still run locally without email configured.

### What changes in `EmailMessage`

The `subject` field is removed from the `EmailMessage` union type. Subject lines are now controlled by the `AuthEmailSenderBase` class via overridable methods (e.g., `magicLinkSubject(message)`), with sensible defaults hard-coded in the base class. Developer-users override subject methods the same way they override template methods.

### RPC compatibility

`EmailMessage` is a plain object with string properties — fully compatible with Cloudflare's structured clone serialization over RPC. No special handling needed.

### Billing

The DO already `await`s email sends (lines 236, 710, 787, 831, 1168 of `lumenize-auth.ts`). Switching from `await emailService.send()` to `await env.AUTH_EMAIL_SENDER.send()` doesn't change billing. Resend responds in ~100ms. The WorkerEntrypoint itself runs under standard Workers CPU billing, not DO wall-clock billing.

## Prerequisites (for lumenize.com testing) — DONE

These are what _we_ need to verify the integration against lumenize.com. Users will follow equivalent steps for their own domain as documented in Phase 2.

- [x] Resend account created (larry@lumenize.com)
- [x] `test.lumenize.com` domain verified in Resend — Cloudflare DNS configured for sending from `test.lumenize.com`
- [x] First test email sent successfully from Resend dashboard
- [x] Resend API key generated and added to `.dev.vars` as `RESEND_API_KEY`
- [x] `.dev.vars.example` updated with `RESEND_API_KEY` template entry

## Phase 1: WorkerEntrypoint Base Classes + Resend Implementation

**Goal**: Build the `AuthEmailSenderBase` and `ResendEmailSender` classes, wire the DO to call via service binding, and unit-test the template rendering and Resend request formatting.

**Success Criteria**:
- [ ] `AuthEmailSenderBase` exported from `@lumenize/auth` — extends `WorkerEntrypoint`, dispatches `send(message)` to overridable template/subject methods, has `from` and `appName` instance variables
- [ ] `ResendEmailSender` exported from `@lumenize/auth` — extends `AuthEmailSenderBase`, implements `sendEmail()` via `fetch` to `https://api.resend.com/emails` with `this.env.RESEND_API_KEY`
- [ ] Default HTML templates for all four message types (magic link, admin notification, approval confirmation, invite) — simple, functional, no external dependencies
- [ ] Default subject line methods for all four types
- [ ] `LumenizeAuth` DO updated: replace `#emailService` with `env.AUTH_EMAIL_SENDER` service binding call; remove `setEmailService()` method
- [ ] `EmailMessage` type updated: `subject` field removed (now controlled by sender base class)
- [ ] Existing tests still pass (they use `LUMENIZE_AUTH_TEST_MODE=true` which skips email sending)
- [ ] Unit tests for template rendering and Resend request body formatting (mock `fetch`, don't call Resend)
- [ ] Default template functions exported for composability

**Files to create/modify**:
- Create `packages/auth/src/auth-email-sender-base.ts` — `AuthEmailSenderBase` class
- Create `packages/auth/src/resend-email-sender.ts` — `ResendEmailSender` class + default templates
- Modify `packages/auth/src/lumenize-auth.ts` — replace `#emailService` with service binding; remove `setEmailService()`; remove `subject` from `EmailMessage` send calls
- Modify `packages/auth/src/types.ts` — remove `subject` from `EmailMessage` union members
- Modify `packages/auth/src/index.ts` — add new exports
- Modify `packages/auth/src/email-service.ts` — remove `subject` references from `ConsoleEmailService`

**Notes**:
- The monolith's parallel auth implementation (`lumenize-monolith/src/magic-link-requested-handler.ts`) uses AWS SES directly. That's a separate system and not part of this task.
- Resend's API is `POST https://api.resend.com/emails` with `{ from, to, subject, html }` body and `Authorization: Bearer <key>` header. Standard `fetch`, no SDK.
- Users who prefer a different provider extend `AuthEmailSenderBase` and implement `sendEmail()` themselves.
- The service binding is self-referencing: `"service"` in wrangler.jsonc matches the Worker's own `"name"`.

## Phase 2: Documentation

**Goal**: Make email provider setup a documented part of the `@lumenize/auth` getting-started experience.

**Success Criteria**:
- [ ] `configuration.mdx` updated: add email provider section explaining the `AuthEmailSenderBase` / `ResendEmailSender` pattern, the `AUTH_EMAIL_SENDER` service binding, `RESEND_API_KEY` env var
- [ ] `website/docs/auth/getting-started.mdx` updated: add an "Email Provider" step walking users through: (1) Resend signup & domain verification, (2) API key setup, (3) creating their `AuthEmailSender` class, (4) adding the service binding to wrangler.jsonc
- [ ] Document template customization: how to override `magicLinkHtml()`, `adminNotificationHtml()`, etc.
- [ ] Document bring-your-own-provider: extend `AuthEmailSenderBase` instead of `ResendEmailSender`
- [ ] JSDoc on both base classes thorough enough for editor hints
- [ ] :::warning about configuring email before production (like Turnstile/rate-limiter warnings)
- [ ]  updated: add email provider setup step (since `@lumenize/auth` is the default auth for `@lumenize/mesh`, mesh users need this too)
- [ ]  Mesh `website/docs/mesh/getting-started.mdx` should reference the auth email provider docs for overrides but provide potentially duplicate instructions for the bare minimum config to get started.
- [ ] Review other mesh docs that reference auth setup for any needed email provider mentions

**Notes**:
- `configuration.mdx` is the reference; `getting-started.mdx` is the walkthrough. Both need updates.
- Templates are developer-user-overridable from day one. Document that there are default templates so users know they can defer template customization.

## Phase 3: Email Testing Infrastructure

This phase absorbs the work from `tasks/never/email-testing-infrastructure.md`. The original task was blocked on wanting to use LumenizeDO (then called LumenizeBase) for the receiver DO — that blocker is resolved. The architecture is updated for Resend instead of AWS SES.

**WARNING: Have a clean commit and record its hash before proceeding**: This phase 3 feels pretty risky with many things we've never done before. If it goes off the rails, we should be willing to revert and give up on this approach. Phases 4 and 5 do not depend on Phase 3 and remain valuable regardless.

### Architecture

The EmailTestDO lives in its own separate Worker deployment with full auth hooks installed — dogfooding LumenizeDO, LumenizeClient, LumenizeClientGateway, and `createRouteDORequestAuthHooks` for the test infrastructure itself.

**Chicken-and-egg solution**: The test client authenticates to the EmailTest mesh using `createTestRefreshFunction` from `@lumenize/mesh`. This utility mints JWTs locally using `signJwt` + the private key from `.dev.vars`. Auth hooks verify them normally against the corresponding public key — the Gateway is none the wiser. No test mode, no bypass, all production code paths exercised. The client calls `refresh` eagerly on connect, so it has a valid token before the WebSocket upgrade. See [Mesh Testing docs](https://lumenize.com/docs/mesh/testing) for full details.

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
│  createTest │                                    ┌─────────────┐
│  Refresh    │                                    │  Resend API │
│  Function() │                                    └──────┬──────┘
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
    verify JWT)      → WebSocket
                     notification
```

**Test flow**:
1. Test creates a `refresh` callback via `createTestRefreshFunction({ privateKey })` — private key from `.dev.vars`
2. LumenizeClient connects to EmailTestDO (through Gateway, auth hooks verify the locally-minted JWT — full mesh dogfooding)
3. Test POSTs magic link request to the auth Worker (email to `test.email@lumenize.com`)
4. Auth DO sends email via Resend (through the `AUTH_EMAIL_SENDER` service binding)
5. Cloudflare Email Routing delivers to EmailTest Worker's `email()` handler
6. `EmailTestDO` parses email with `postal-mime`, extracts magic link URL
7. `EmailTestDO` sends parsed email over WebSocket to waiting test (via LumenizeDO → Gateway → LumenizeClient)
8. Test extracts magic link URL from the parsed email, then uses `Browser.fetch` to GET it on the auth Worker (simulating the user clicking the link in their email client — `Browser` handles cookies so the auth response's `Set-Cookie` for refresh token is captured automatically). Test verifies the full auth flow: token exchange, JWT claims, refresh token rotation.

### Phase 3a: EmailTestDO + Deployment

**Goal**: Build a LumenizeDO that receives emails via Cloudflare Email Routing and notifies connected LumenizeClients. Deploy as a separate Worker with full auth hooks.

**Success Criteria**:
- [ ] `EmailTestDO` extends `LumenizeDO` — location TBD (probably `tooling/email-test/`)
- [ ] Parses incoming emails with `postal-mime`
- [ ] Stores recent emails in SQLite (for debugging/verification)
- [ ] LumenizeClient subscribers receive email arrival notifications via the mesh
- [ ] Worker `email()` handler routes inbound email to the DO
- [ ] Worker has `createRouteDORequestAuthHooks` installed — test clients authenticate via `createTestRefreshFunction` from `@lumenize/mesh`
- [ ] Worker deployed to Cloudflare
- [ ] `test.email@lumenize.com` routes to the deployed worker via Cloudflare Email Routing
- [ ] Manual verification: send email to test address → see it in DO storage

**Notes**:
- Prior art exists in `lumenize-monolith/test/test-harness.ts` — has a working `email()` handler with `postal-mime` parsing and a `SimpleMimeMessage` builder for constructing test emails.
- **Email worker deployment is resolved**: `wrangler deploy` deploys the Worker with an `email()` handler normally. However, **inbound email routing** (binding `test.email@lumenize.com` to the Worker) must be configured in the Cloudflare dashboard — there is no wrangler.jsonc config for inbound email routing. This is a one-time manual step. Local dev works via `wrangler dev` which exposes `/cdn-cgi/handler/email` for testing with raw MIME messages.
- `lumenize-monolith/test/simple-mime-message.ts` provides a reusable MIME message builder. Consider extracting it to a shared test utility.
- `lumenize-monolith/test/live-email-routing.test.ts` has a local email parsing test.
- `createTestRefreshFunction` from `@lumenize/mesh` handles the JWT minting. In a vitest/cloudflare:test environment it auto-reads `JWT_PRIVATE_KEY_BLUE` from env; for deployed tests, pass `privateKey` explicitly from `.dev.vars`. The corresponding public key is configured in the EmailTest Worker's env for hook verification.

### Phase 3b: Test Helpers + End-to-End Auth Flow Test

**Goal**: Build test utilities and an automated end-to-end test of the full magic link auth flow with real email delivery.

**Success Criteria**:
- [ ] `waitForEmail(client, options)` helper — subscribes via LumenizeClient to EmailTestDO, waits for matching email, returns parsed content
- [ ] `extractMagicLink(email)` helper — pulls magic link URL from parsed email body
- [ ] End-to-end test: request magic link → email delivered via Resend → received by EmailTestDO → test extracts and clicks magic link → exchange for tokens → refresh token works → JWT contains expected claims
- [ ] WebSocket auth flow tested: access token used in subprotocol → Gateway accepts connection
- [ ] `createRouteDORequestAuthHooks` verifies the JWT correctly (both `onBeforeRequest` and `onBeforeConnect`)
- [ ] Error cases verified: expired magic link, invalid token, rate limiting
- [ ] Re-login flow tested: refresh token expires → `onLoginRequired` fires → user goes through magic link flow again via email infrastructure → new tokens → reconnect
- [ ] `refresh: '/auth/refresh-token'` string form tested end-to-end: client uses a real refresh token (obtained via magic link) to call the real auth endpoint for token rotation
- [ ] Test can be run locally (with secrets in `.dev.vars`) and eventually in CI

**Notes**:
- This replaces the manual "trigger magic link, check your inbox, eyeball it" approach. Every future auth change gets regression coverage.
- The test needs Resend credentials and Cloudflare Email Routing configured — document the required secrets for local and CI environments.
- The test exercises two separate auth paths: (1) `createTestRefreshFunction`-minted JWTs for the EmailTestDO mesh connection, and (2) real magic-link-issued JWTs from the auth Worker. This validates both the JWT verification pipeline and the full auth issuance flow.

## Phase 4: Mesh Client Token Refresh Test

**Goal**: Verify `LumenizeClient`'s token refresh mechanism works end-to-end with `@lumenize/auth`. Does not depend on Phase 3.

**Success Criteria**:
- [ ] `LumenizeClient` configured with `createTestRefreshFunction` connects successfully and passes auth hooks
- [ ] Token expiry triggers automatic refresh without dropping the WebSocket connection
- [ ] Gateway re-verifies the refreshed JWT correctly
- [ ] A simple mesh call (Client → Gateway → DO → response) works with auth enabled

**Notes**:
- This is the critical path test: auth + mesh working together. If this works, we're unblocked for shipping.
- Uses `createTestRefreshFunction` to mint JWTs locally — no email infrastructure needed. The test exercises the same auth hooks and JWT verification pipeline as production.
- The `refresh: '/auth/refresh-token'` string form (where the client calls the real auth endpoint) requires a real refresh token, which requires a real magic link flow. That end-to-end test lives in Phase 3b.
- The `refresh` endpoint is served by the auth routes (`createAuthRoutes`), which proxies to the auth DO's refresh token rotation logic.

## Phase 5: Revisit Testing Utilities

**Goal**: Evaluate whether `ConsoleEmailService`, `MockEmailService`, and `HttpEmailService` should be updated, replaced, or deprecated in light of the WorkerEntrypoint pattern.

**Success Criteria**:
- [ ] Evaluate whether existing tests should use the pluggable WorkerEntrypoint system instead of `LUMENIZE_AUTH_TEST_MODE=true`
- [ ] Decide fate of `MockEmailService` — possibly replace with a test `AuthEmailSender` that collects messages
- [ ] Decide fate of `ConsoleEmailService` — possibly replace with a development `AuthEmailSender` that logs
- [ ] Decide fate of `HttpEmailService` — still useful internally for `ResendEmailSender`, but may no longer need to be a public export
- [ ] Decide fate of `EmailService` interface and `createDefaultEmailService()` — likely deprecated in favor of the WorkerEntrypoint pattern
- [ ] Update or remove `setEmailService()` references from backlog and docs
- [ ] Clean up any dead code from the old pattern

**Notes**:
- This phase exists to avoid blocking Phase 1 with testing design decisions. The old utilities still work during the transition.
- The WorkerEntrypoint pattern may provide a cleaner testing story: configure a test service binding that points to a mock `AuthEmailSender` in the test Worker.

## Follow-on Considerations

- **Cloudflare outgoing email service**: When it reaches GA, we can create a `CloudflareEmailSender` extending `AuthEmailSenderBase`. The WorkerEntrypoint pattern makes this a clean addition — developer-users just change which class they extend. Template customization via HTMLRewriter could be layered in at that point.
- **Provider-agnostic guidance**: Docs should make clear that Resend is a recommended default, not a requirement. Users with existing email infrastructure extend `AuthEmailSenderBase` directly.

## Related

- `tasks/never/email-testing-infrastructure.md` — Subsumed into Phase 3 of this task
- `tasks/nebula-auth.md` — Future auth evolution for multi-tenant Nebula platform
- `tasks/todos-for-initial-mesh-release.md` — Release checklist (this task feeds into it)
- `website/docs/auth/configuration.mdx` — Env vars reference (needs email provider section)
- `website/docs/auth/getting-started.mdx` — Setup walkthrough (needs email provider step)
- `website/docs/mesh/getting-started.mdx` — Mesh setup walkthrough (needs email provider reference)
- `packages/auth/src/email-service.ts` — `HttpEmailService`, `ConsoleEmailService`, `MockEmailService` (to be revisited in Phase 5)
- `packages/auth/src/types.ts` — `EmailMessage` union type (subject field removed in Phase 1)
- `packages/mesh/src/create-test-refresh-function.ts` — `createTestRefreshFunction` for locally-minted JWTs in tests
- `website/docs/mesh/testing.mdx` — Testing docs covering `createTestRefreshFunction` usage
- `packages/fetch/src/fetch-executor-entrypoint.ts` — Prior art: WorkerEntrypoint with self-referencing service binding
- `packages/mesh/test/for-docs/calls/` — Prior art: SpellCheckWorker, AnalyticsWorker patterns
- `lumenize-monolith/test/test-harness.ts` — Prior art: `email()` handler with `postal-mime`, deployment notes
- `lumenize-monolith/test/simple-mime-message.ts` — Prior art: MIME message builder for test emails
- `lumenize-monolith/test/live-email-routing.test.ts` — Prior art: local email parsing test
