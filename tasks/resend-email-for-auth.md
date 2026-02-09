# Resend Email Integration for @lumenize/auth

**Status**: Phase 1 Complete — Ready for Phase 2

## Objective

Unblock Lumenize Mesh shipping by making email provider setup a documented, user-facing part of `@lumenize/auth`, with [Resend](https://resend.com) as the temporary default until Cloudflare ships their outgoing email offering. `@lumenize/auth` requires outgoing email for magic links, admin notifications, approval confirmations, and invites.

Every developer deploying a Lumenize Mesh application will need their own email provider. This task makes that setup path clear and tested.

## Decision Context

Shipping `@lumenize/mesh` is blocked because auth requires outgoing email and Cloudflare's email sending service is still in closed beta with no GA date. Four alternatives were evaluated and Resend was chosen:

### Resend.com as email API (CHOSEN)

Resend is a good default because it uses standard `fetch` (no SDK), has a generous free tier, works natively on Cloudflare Workers, and has clear domain verification docs.

- **Effort**: Hours for implementation, plus docs work
- **Risk**: Very low
- **Cost**: Each deployer needs their own Resend account — free tier covers 100 emails/day; $20/mo for 50K

### Future path

Ship with Resend as default now. Switch default to Cloudflare when it's GA.

## Architecture: WorkerEntrypoint Pattern

### Design rationale

Rather than having the `LumenizeAuth` DO construct email services internally (which hides configuration and prevents template customization), email sending is delegated to a **WorkerEntrypoint** that the developer-user defines and exports from their Worker. The DO calls it via a service binding (`env.AUTH_EMAIL_SENDER`).

```
WorkerEntrypoint                   (Cloudflare)
  └─ AuthEmailSenderBase           (we provide — templates, subjects, from/replyTo/appName)
       └─ ResendEmailSender        (we provide — implements sendEmail() via Resend fetch)
            └─ AuthEmailSender     (developer-user — sets vars/overrides methods)
```

`AuthEmailSenderBase` extends `WorkerEntrypoint` directly — **not** `LumenizeWorker` — because `@lumenize/auth` must not depend on `@lumenize/mesh`. This means no `this.lmz.call()` or mesh infrastructure; the DO communicates with the entrypoint via plain Workers RPC.

This gives developer-users control over:
- **From address** — bare email address, set as an instance variable (required). `ResendEmailSender` constructs Resend's `from` field as `"${appName} <${from}>"` (e.g., `"Lumenize <auth@myapp.com>"`). For bring-your-own-provider, `sendEmail()` receives the bare `from` in the `ResolvedEmail` object and the subclass formats it however their provider expects
- **Reply-to address** — defaults to `no-reply@{domain from 'from'}`, overridable instance variable
- **App name** — used in default templates and Resend `From:` display name, defaults to `'Lumenize'`, overridable instance variable
- **HTML templates** — override one, several, or all template methods

Additionally, if the developer-user wants, they can extend `AuthEmailSenderBase` to implement support for any email provider they wish

```
WorkerEntrypoint                (Cloudflare)
  └─ AuthEmailSenderBase        (we provide — templates, subjects, from/replyTo/appName)
      └─ AuthEmailSender        (developer-user — sendEmail()/sets vars/overrides methods)
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
  replyTo = 'support@myapp.com';  // default: no-reply@myapp.com
  appName = 'My App';  // default: 'Lumenize', used in default templates

  magicLinkHtml(message) {
    return `<h1>Welcome to My App</h1><a href="${message.magicLinkUrl}">Sign in</a>`;
  }
  // other 4 template methods use defaults
}
```

**Bring your own provider (no Resend):**

```typescript
import { AuthEmailSenderBase } from '@lumenize/auth';

export class AuthEmailSender extends AuthEmailSenderBase {
  from = 'auth@myapp.com';

  async sendEmail(email: ResolvedEmail) {
    const { to, subject, html, from, replyTo } = email;
    // call Postmark, SES, whatever — everything is resolved
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

1. **`AuthEmailSenderBase`** — extends `WorkerEntrypoint`. Provides default `send(message)` that dispatches to overridable template methods, assembles a `ResolvedEmail` object, and calls abstract `sendEmail(email: ResolvedEmail)`. Has `from` (required), `replyTo` (defaults to `no-reply@{domain}`), and `appName` (defaults to `'Lumenize'`) instance variables. Provides 10 overridable methods (5 template + 5 subject). **Error semantics**: `send()` does not add its own error wrapping — it lets whatever `sendEmail()` throws bubble up to the caller (the DO's try/catch). The base class's job is dispatch and template rendering, not error policy.

2. **`ResendEmailSender`** — extends `AuthEmailSenderBase`. Implements `sendEmail(email)` using `fetch` against `https://api.resend.com/emails` with `this.env.RESEND_API_KEY`. Constructs `"${email.appName} <${email.from}>"` for Resend's `from` field. Throws on non-2xx response. Developer-users extend this class.

3. **`ResolvedEmail`** — the object passed to `sendEmail()`. Contains everything needed to send one email:

    ```typescript
    interface ResolvedEmail {
      to: string;        // recipient
      subject: string;   // resolved by subject method
      html: string;      // resolved by template method
      from: string;      // bare email address from instance variable
      replyTo: string;   // resolved default or override
      appName: string;   // for providers that use it (e.g., From: display name)
    }
    ```

4. **Default template functions** — exported for users who want to compose (call the default and wrap it).

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

**Why `(this.env as any)`**: The `AUTH_EMAIL_SENDER` binding lives in the *developer-user's* wrangler.jsonc (self-referencing their Worker), not in the auth *library's* wrangler.jsonc. The auth library's `Env` type won't include it, so the cast is required. The developer-user's own code gets full typing because `wrangler types` adds it to *their* `Env`.

When `AUTH_EMAIL_SENDER` isn't configured (no service binding), optional chaining returns `undefined`. In that case, the DO logs the email type and recipient at debug level (matching the current `ConsoleEmailService` behavior) so developers see feedback during local development. This preserves the dev-logging experience from the old `#emailService` default.

### Missing binding warning

`createAuthRoutes()` checks for `env.AUTH_EMAIL_SENDER` at startup (same pattern as the existing Turnstile warning). In test mode, the check is skipped. When not in test mode, a `console.warn` is emitted:

> `[lumenize/auth] AUTH_EMAIL_SENDER is not configured — magic links and invites will not be delivered. See https://lumenize.com/docs/auth/getting-started#email-provider`

This matches the Turnstile convention: warn but don't block, so developer-users can still run locally without email configured.

### What changes in `EmailMessage`

The `subject` field is removed from all union members. The `invite` type is split into `invite-existing` (notification to already-verified users) and `invite-new` (onboarding link for new/unverified users) because they have different semantics: `invite-existing` links to the app redirect URL (no token), while `invite-new` contains a one-time invite token that activates the account. Sending the same template for both is a footgun — new users need to understand they must click that specific link.

**New `EmailMessage` type (5 members, no `subject`):**

```typescript
export type EmailMessage =
  | { type: 'magic-link'; to: string; magicLinkUrl: string }
  | { type: 'admin-notification'; to: string; subjectEmail: string; approveUrl: string }
  | { type: 'approval-confirmation'; to: string; redirectUrl: string }
  | { type: 'invite-existing'; to: string; redirectUrl: string }
  | { type: 'invite-new'; to: string; inviteUrl: string };
```

Subject lines are now controlled by `AuthEmailSenderBase` via overridable methods, with sensible defaults. Developer-users override subject methods the same way they override template methods.

### Overridable methods (10 total)

All methods receive the corresponding `EmailMessage` variant as their argument.

**Template methods** (return HTML string):
1. `magicLinkHtml(message)` — login link email
2. `adminNotificationHtml(message)` — new signup notification to admins
3. `approvalConfirmationHtml(message)` — account approved notification
4. `inviteExistingHtml(message)` — notification to already-verified user ("you've been added, come check it out")
5. `inviteNewHtml(message)` — onboarding email for new/unverified user ("click to activate your account")

**Subject methods** (return string):
6. `magicLinkSubject(message)` — default: `'Your login link'`
7. `adminNotificationSubject(message)` — default: `` `New signup: ${message.subjectEmail}` ``
8. `approvalConfirmationSubject(message)` — default: `'Your account has been approved'`
9. `inviteExistingSubject(message)` — default: `"You've been invited"`
10. `inviteNewSubject(message)` — default: `"You've been invited"`

### RPC compatibility

`EmailMessage` is a plain object with string properties — fully compatible with Cloudflare's structured clone serialization over RPC. No special handling needed.

### Billing

The DO already `await`s email sends (5 call sites in `lumenize-auth.ts`: magic-link, approval-confirmation, invite-existing, invite-new, admin-notification). Switching from `await emailService.send()` to `await env.AUTH_EMAIL_SENDER.send()` doesn't change billing. Resend responds in ~100ms. The WorkerEntrypoint itself runs under standard Workers CPU billing, not DO wall-clock billing.

## Prerequisites (for lumenize.com testing) — DONE

These are what _we_ need to verify the integration against lumenize.com. Users will follow equivalent steps for their own domain as documented in Phase 3.

- [x] Resend account created (larry@lumenize.com)
- [x] `test.lumenize.com` domain verified in Resend — Cloudflare DNS configured for sending from `test.lumenize.com`
- [x] First test email sent successfully from Resend dashboard
- [x] Resend API key generated and added to `.dev.vars` as `RESEND_API_KEY`
- [x] `.dev.vars.example` updated with `RESEND_API_KEY` template entry

## Phase 1: WorkerEntrypoint Base Classes + Resend Implementation

**Goal**: Build the `AuthEmailSenderBase` and `ResendEmailSender` classes, wire the DO to call via service binding, and unit-test the template rendering and Resend request formatting.

**Success Criteria**:
- [x] `AuthEmailSenderBase` exported from `@lumenize/auth` — extends `WorkerEntrypoint` (not `LumenizeWorker`), dispatches `send(message)` to the 10 overridable template/subject methods, assembles `ResolvedEmail`, calls abstract `sendEmail(email: ResolvedEmail)`. Has `from` (required via `abstract`), `replyTo` (default: `no-reply@{domain}`), and `appName` (default: `'Lumenize'`) instance variables
- [x] `ResolvedEmail` interface exported from `@lumenize/auth` — `{ to, subject, html, from, replyTo, appName }`
- [x] `ResendEmailSender` exported from `@lumenize/auth` — extends `AuthEmailSenderBase`, implements `sendEmail(email)` via `fetch` to `https://api.resend.com/emails` with `this.env.RESEND_API_KEY`, throws on non-2xx
- [x] Default HTML templates for all five message types (magic link, admin notification, approval confirmation, invite-existing, invite-new) — simple, functional, no external dependencies
- [x] Default subject line methods for all five types
- [x] `LumenizeAuth` DO updated: replace `#emailService` with `env.AUTH_EMAIL_SENDER` service binding call; remove `setEmailService()` method; add debug-level logging when binding is missing (preserves dev feedback from old `ConsoleEmailService` default)
- [x] `EmailMessage` type updated: `subject` field removed; `invite` split into `invite-existing` and `invite-new` (5 union members total — see "What changes in EmailMessage" above)
- [x] Existing tests still pass (they use `LUMENIZE_AUTH_TEST_MODE=true` which skips email sending) — 149/149 passing across 6 test files
- [ ] Unit tests for template rendering and Resend request body formatting (mock `fetch`, don't call Resend) — **deferred to Phase 2** (the new code paths aren't exercised by existing tests since test mode returns before email sending; unit tests for templates/Resend formatting will be written alongside the email testing infrastructure)
- [x] Default template functions exported for composability

**Files to create/modify**:
- Create `packages/auth/src/auth-email-sender-base.ts` — `AuthEmailSenderBase` class
- Create `packages/auth/src/resend-email-sender.ts` — `ResendEmailSender` class + default templates
- Modify `packages/auth/src/lumenize-auth.ts` — replace `#emailService` with service binding; remove `setEmailService()`; remove `subject` from send calls; split invite sends into `invite-existing` and `invite-new` types; add debug logging fallback when binding is missing
- Modify `packages/auth/src/types.ts` — remove `subject` from `EmailMessage` union members; split `invite` into `invite-existing` and `invite-new`; add `ResolvedEmail` interface
- Modify `packages/auth/src/index.ts` — add new exports
- Leave `packages/auth/src/email-service.ts` mostly untouched — the `EmailMessage` type change propagates automatically; the fate of these old classes is deferred to Phase 4

**Notes**:
- The monolith's parallel auth implementation (`lumenize-monolith/src/magic-link-requested-handler.ts`) uses AWS SES directly. That's a separate system and not part of this task.
- Resend's API is `POST https://api.resend.com/emails` with `{ from, to, subject, html, reply_to }` body and `Authorization: Bearer <key>` header. Standard `fetch`, no SDK. `ResendEmailSender` constructs Resend's `from` as `"${email.appName} <${email.from}>"` from the `ResolvedEmail` object.
- Users who prefer a different provider extend `AuthEmailSenderBase` and implement `sendEmail()` themselves.
- The service binding is self-referencing: `"service"` in wrangler.jsonc matches the Worker's own `"name"`.
- Test mode (`LUMENIZE_AUTH_TEST_MODE=true`) returns the magic link URL in the response *before* the email send is attempted, so none of the new service binding code is exercised by existing tests. The unit tests for template rendering are the Phase 1 coverage for the new code. End-to-end coverage comes in Phase 2 (email testing infrastructure).

## Phase 2: Email Testing Infrastructure

This phase absorbs the work from `tasks/never/email-testing-infrastructure.md`. The original task envisioned using LumenizeDO + Gateway + mesh for the receiver — that was dropped in favor of a plain `DurableObject` with Hibernation WebSocket API. The mesh stack is well-exercised elsewhere; this is focused test infrastructure. The architecture is updated for Resend instead of AWS SES.

**WARNING: Have a clean commit and record its hash before proceeding**: This phase feels pretty risky with many things we've never done before. If it goes off the rails, we should be willing to revert and give up on this approach. **Abort criteria**: If getting Cloudflare Email Routing to deliver to the Worker takes more than 4 hours, defer to manual testing and move on to Phase 3 (docs). Phases 3 and 4 do not depend on Phase 2 and remain valuable regardless.


### Architecture

The EmailTestDO is a plain `DurableObject` (not LumenizeDO) in its own Worker deployment. It uses a hard-coded instance name (`"email-inbox"`) so all emails go to one DO — avoiding orphaned storage from dynamic instance names. No Gateway, no auth hooks, no mesh — this is internal test infrastructure, not a dogfooding target. The mesh stack is already well-exercised by the mesh test suite.

The DO uses the Hibernation WebSocket API to push parsed emails to connected test clients in real time (no polling). Tests open a WebSocket before triggering the magic link, then await the push notification.

```
                          EmailTest Worker               Auth Worker
                          (separate deployment,           (system under test)
                           plain DurableObject)

┌─────────────┐                                    ┌─────────────┐
│   Test      │─── POST /auth/email-magic-link ──▶ │ Auth DO     │
│   Client    │                                    │             │
│             │                                    └──────┬──────┘
│             │                                           │ Resend
│  WebSocket  │                                           ▼
│  (native,   │                                    ┌─────────────┐
│   no mesh)  │                                    │  Resend API │
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
│             │   │ extends      │
└─────────────┘   │ DurableObject│
   native         │              │
   WebSocket      └──────────────┘
   push             postal-mime
                    → SQLite store
                    → WebSocket push
```

**Test flow**:
1. Test opens a native WebSocket to the EmailTest Worker (`/ws` on the hard-coded `"email-inbox"` instance)
2. Test POSTs magic link request to the auth Worker (email to `test.email@lumenize.com`)
3. Auth DO sends email via Resend (through the `AUTH_EMAIL_SENDER` service binding)
4. Cloudflare Email Routing delivers to EmailTest Worker's `email()` handler
5. Worker routes to `EmailTestDO("email-inbox")`, which parses with `postal-mime` and stores in KV (array of parsed email objects)
6. `EmailTestDO` pushes parsed email JSON to all connected WebSocket clients via `getWebSockets()`
7. Test receives the push, extracts magic link URL from parsed email HTML
8. Test uses `Browser.fetch` to GET the magic link URL on the auth Worker (simulating the user clicking the link — `Browser` handles cookies so the `Set-Cookie` for refresh token is captured). Test verifies the full auth flow: token exchange, JWT claims, refresh token rotation.

### Phase 2a: EmailTestDO + Local Verification

**Goal**: Build the EmailTestDO, Worker entry point, and local test that exercises the `email()` handler with synthetic MIME messages. Commit when passing.

**Success Criteria**:
- [ ] `EmailTestDO` extends `DurableObject` — in `tooling/email-test/`, hard-coded instance name `"email-inbox"`
- [ ] `postal-mime` installed as a dependency of `tooling/email-test/` (MIT-0 license, zero deps, ~4.5K SLOC — too large to copy, Cloudflare-recommended for Email Workers)
- [ ] `SimpleMimeMessage` copied from monolith into `tooling/email-test/src/` with attribution (60 lines, MIME builder — opposite of postal-mime which is a parser)
- [ ] Parses incoming emails with `postal-mime`
- [ ] Stores recent emails in KV as a growing array of parsed email objects (no SQLite — KV starts clean each vitest run, simpler than schema management)
- [ ] Hibernation WebSocket API: test clients connect to `/ws`, DO pushes parsed email JSON to all connected sockets on arrival
- [ ] Worker `email()` handler routes inbound email to the `"email-inbox"` DO instance
- [ ] Local test: build synthetic MIME with `SimpleMimeMessage` → POST to built-in `/cdn-cgi/handler/email` endpoint (Cloudflare's local dev support for Email Workers, added April 2025) → verify postal-mime parsing → verify DO KV storage → verify WebSocket push
- [ ] Wrangler name: `"email-test"` (matches directory name)
- [ ] Committed before proceeding to deployment

**Notes**:
- Prior art exists in `lumenize-monolith/test/test-harness.ts` — has a working `email()` handler with `postal-mime` parsing.
- `SimpleMimeMessage` (from `lumenize-monolith/test/simple-mime-message.ts`) is a MIME *builder* for constructing test emails. `postal-mime` is a MIME *parser* for reading inbound emails. Both are needed.
- `lumenize-monolith/test/live-email-routing.test.ts` has a local email parsing test pattern.
- No auth hooks, no Gateway, no mesh on this Worker — it's internal test infrastructure. Auth is tested on the auth Worker side (the system under test).
- **Local email testing**: Cloudflare added local dev support for Email Workers (April 2025). `wrangler dev` exposes `/cdn-cgi/handler/email` — POST raw MIME with `?from=...&to=...` query params to trigger the `email()` handler. This replaces the monolith's custom `/test-email-routing` endpoint.
- **DO stub shortcut**: Use `env.EMAIL_TEST_DO.getByName('email-inbox')` instead of the longer `env.EMAIL_TEST_DO.idFromName('email-inbox')` + `.get()` chain.

### Phase 2a-deploy: Deploy + Email Routing Configuration

**Goal**: Deploy the EmailTest Worker to Cloudflare and configure Email Routing to deliver inbound emails to it. This is where the 4-hour abort clock starts.

**Success Criteria**:
- [ ] Worker (`"email-test"`) deployed to Cloudflare via `wrangler deploy`
- [ ] Cloudflare Email Routing configured in dashboard: `test.email@lumenize.com` → EmailTest Worker (manual step — no wrangler.jsonc config for inbound email routing)
- [ ] Manual verification: send real email to `test.email@lumenize.com` → see it in DO storage (via logs or a debug endpoint)

**Notes**:
- **Email worker deployment**: `wrangler deploy` handles the Worker + `email()` handler. The **inbound email routing** (binding `test.email@lumenize.com` to the Worker) is a one-time manual dashboard step. The monolith hit this same issue — the comment in `test-harness.ts` says "I COULDN'T FIGURE OUT HOW TO DEPLOY AN EMAIL WORKER. I EDITED IN THE CLOUDFLARE DASHBOARD."
- This phase involves back-and-forth: agent does code/deploy, user does dashboard configuration (DNS verification, email routing rules).
- If this takes >4 hours, abort and proceed to Phase 3 (docs). The local infrastructure from Phase 2a is still valuable.

### Phase 2b: Test Helpers + End-to-End Auth Flow Test

**Prerequisite**: Phase 2a committed, Phase 2a-deploy verified (real email delivered to DO). Commit 2a-deploy before starting 2b.

**Goal**: Build test utilities and an automated end-to-end test of the full magic link auth flow with real email delivery.

**Success Criteria**:
- [ ] `waitForEmail(ws, options)` helper — opens native WebSocket to EmailTestDO, waits for matching email push, returns parsed content
- [ ] `extractMagicLink(email)` helper — pulls magic link URL from parsed email HTML
- [ ] End-to-end test: request magic link → email delivered via Resend → received by EmailTestDO → WebSocket push → test extracts and clicks magic link → exchange for tokens → refresh token works → JWT contains expected claims
- [ ] Error cases verified: expired magic link, invalid token, rate limiting
- [ ] Test can be run locally (with secrets in `.dev.vars`) and eventually in CI

**Notes**:
- This replaces the manual "trigger magic link, check your inbox, eyeball it" approach. Every future auth change gets regression coverage.
- The test needs Resend credentials and Cloudflare Email Routing configured — document the required secrets for local and CI environments.
- The test exercises real magic-link-issued JWTs from the auth Worker — no test mode, no bypass.

## Phase 3: Documentation

**Goal**: Make email provider setup a documented part of the `@lumenize/auth` getting-started experience.

**Success Criteria**:
- [ ] `configuration.mdx` updated: add email provider section explaining the `AuthEmailSenderBase` / `ResendEmailSender` pattern, the `AUTH_EMAIL_SENDER` service binding, `RESEND_API_KEY` env var
- [ ] `website/docs/auth/getting-started.mdx` updated: add an "Email Provider" step walking users through: (1) Resend signup & domain verification, (2) API key setup, (3) creating their `AuthEmailSender` class, (4) adding the service binding to wrangler.jsonc
- [ ] Document template customization: how to override `magicLinkHtml()`, `adminNotificationHtml()`, `inviteExistingHtml()`, `inviteNewHtml()`, etc.
- [ ] Document bring-your-own-provider: extend `AuthEmailSenderBase` instead of `ResendEmailSender`
- [ ] JSDoc on both base classes thorough enough for editor hints
- [ ] :::warning about configuring email before production (like Turnstile/rate-limiter warnings)
- [ ] Mesh `website/docs/mesh/getting-started.mdx` updated: reference auth email provider docs for overrides but provide potentially duplicate instructions for the bare minimum config to get started (since `@lumenize/auth` is the default auth for `@lumenize/mesh`, mesh users need this too)
- [ ] Review other mesh docs that reference auth setup for any needed email provider mentions

**Notes**:
- `configuration.mdx` is the reference; `getting-started.mdx` is the walkthrough. Both need updates.
- Templates are developer-user-overridable from day one. Document that there are default templates so users know they can defer template customization.

## Phase 4: Revisit Testing Utilities

**Goal**: Evaluate whether `ConsoleEmailService`, `MockEmailService`, and `HttpEmailService` should be updated, replaced, or deprecated in light of the WorkerEntrypoint pattern.

**Success Criteria**:
- [ ] Evaluate whether existing tests should use the pluggable WorkerEntrypoint system instead of `LUMENIZE_AUTH_TEST_MODE=true`
- [ ] Decide fate of `MockEmailService` — possibly replace with a test `AuthEmailSender` that collects messages
- [ ] Decide fate of `ConsoleEmailService` — possibly replace with a development `AuthEmailSender` that logs
- [ ] Decide fate of `HttpEmailService` — still useful internally for `ResendEmailSender`, but may no longer need to be a public export
- [ ] Decide fate of `EmailService` interface and `createDefaultEmailService()` — likely deprecated in favor of the WorkerEntrypoint pattern
- [ ] Evaluate `packages/auth/src/email-service.ts` as a whole — Phase 1 left it untouched (the `EmailMessage` type change propagates automatically), but this is where to clean up or deprecate the old classes
- [ ] Update or remove `setEmailService()` references from backlog and docs
- [ ] Clean up any dead code from the old pattern

**Notes**:
- This phase exists to avoid blocking Phase 1 with testing design decisions. The old utilities still work during the transition.
- The WorkerEntrypoint pattern may provide a cleaner testing story: configure a test service binding that points to a mock `AuthEmailSender` in the test Worker.
- **Invite split impact**: Phase 1's `invite` → `invite-existing` / `invite-new` split changes the `EmailMessage` type. Any code checking `.type === 'invite'` (e.g., `MockEmailService.getLatestFor()` consumers, `ConsoleEmailService` switch cases) will get compile errors that guide the fix. Verify all switch/case exhaustiveness checks still pass after cleanup.

## Follow-on Considerations

- **Cloudflare outgoing email service**: When it reaches GA, we can create a `CloudflareEmailSender` extending `AuthEmailSenderBase`. The WorkerEntrypoint pattern makes this a clean addition — developer-users just change which class they extend. Template customization via HTMLRewriter could be layered in at that point.
- **Provider-agnostic guidance**: Docs should make clear that Resend is a recommended default, not a requirement. Users with existing email infrastructure extend `AuthEmailSenderBase` directly.
- **Mesh client token refresh lifecycle test**: The successful refresh → reconnect → continued calls scenario is not tested in the mesh suite. Tracked in `tasks/backlog.md` under "Lumenize Mesh". This was originally Phase 4 of this task but was dropped because it's a mesh concern, not an auth/email concern.

## Related

- `tasks/never/email-testing-infrastructure.md` — Subsumed into Phase 2 of this task
- `tasks/nebula-auth.md` — Future auth evolution for multi-tenant Nebula platform
- `tasks/todos-for-initial-mesh-release.md` — Release checklist (this task feeds into it)
- `website/docs/auth/configuration.mdx` — Env vars reference (needs email provider section)
- `website/docs/auth/getting-started.mdx` — Setup walkthrough (needs email provider step)
- `website/docs/mesh/getting-started.mdx` — Mesh setup walkthrough (needs email provider reference)
- `packages/auth/src/email-service.ts` — `HttpEmailService`, `ConsoleEmailService`, `MockEmailService` (to be revisited in Phase 4)
- `packages/auth/src/types.ts` — `EmailMessage` union type (subject removed, invite split in Phase 1)
- `packages/mesh/src/create-test-refresh-function.ts` — `createTestRefreshFunction` for locally-minted JWTs in tests
- `website/docs/mesh/testing.mdx` — Testing docs covering `createTestRefreshFunction` usage
- `packages/fetch/src/fetch-executor-entrypoint.ts` — Prior art: WorkerEntrypoint with self-referencing service binding
- `packages/mesh/test/for-docs/calls/` — Prior art: SpellCheckWorker, AnalyticsWorker patterns
- `lumenize-monolith/test/test-harness.ts` — Prior art: `email()` handler with `postal-mime`, deployment notes
- `lumenize-monolith/test/simple-mime-message.ts` — Prior art: MIME message builder for test emails
- `lumenize-monolith/test/live-email-routing.test.ts` — Prior art: local email parsing test
