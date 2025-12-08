# Email Testing Infrastructure

## Objective

Build tooling to enable live integration testing of email-based flows (like magic link auth) by:
1. Sending real emails via AWS SES
2. Receiving emails via Cloudflare Email Routing
3. Notifying tests in real-time via WebSocket when emails arrive

## Architecture

```
┌─────────────┐     POST /auth/email-magic-link     ┌─────────────┐
│   Test      │ ─────────────────────────────────▶  │ Auth DO     │
│   Client    │                                     │             │
└─────────────┘                                     └──────┬──────┘
       │                                                   │
       │  WebSocket to EmailTestDO                         │ SES
       │  (waiting for email)                              ▼
       │                                           ┌─────────────┐
       │                                           │  AWS SES    │
       │                                           └──────┬──────┘
       │                                                  │
       │                                                  │ Email to
       │                                                  │ test.email@lumenize.com
       │                                                  ▼
       │                                           ┌─────────────┐
       │                                           │  Cloudflare │
       │                                           │  Email      │
       │                                           │  Routing    │
       │                                           └──────┬──────┘
       │                                                  │
       │                                                  ▼
       │                                           ┌─────────────┐
       │ ◀───────── WebSocket notification ─────── │ EmailTestDO │
       │           (email arrived!)                │ (extends    │
       └───────────────────────────────────────────│ LumenizeBase│
                                                   └─────────────┘
```

**Test flow**:
1. Test establishes WebSocket to `EmailTestDO`
2. Test triggers magic link request (email to `test.email@lumenize.com`)
3. AWS SES sends email
4. Cloudflare Email Routing delivers to `EmailTestDO`
5. `EmailTestDO` parses email with `postal-mime`, extracts magic link
6. `EmailTestDO` sends parsed email over WebSocket to waiting test
7. Test receives magic link, clicks it, verifies full flow

## Prior Art

Existing code in `lumenize-monolith/`:
- `src/magic-link-requested-handler.ts` - AWS SES SDK usage
- `test/test-harness.ts` - Email handler skeleton (not deployed)
- `test/live-email-routing.test.ts` - Local email parsing test
- `test/simple-mime-message.ts` - MIME message builder

## Prerequisites

- [ ] AWS SES credentials (need to recreate)
- [ ] Verify `test.email@lumenize.com` is configured in Cloudflare Email Routing
- [ ] Decide: extend `tooling/test-endpoints/` or create new `tooling/email-test/`

## Phase 1: AWS SES Integration for Auth Package

**Goal**: Enable `@lumenize/auth` to send real emails via AWS SES.

**Success Criteria**:
- [ ] `SesEmailService` implementation in `packages/auth/src/email-service.ts`
- [ ] AWS credentials configured in `.dev.vars` and `.dev.vars.example`
- [ ] Auth DO can be configured to use SES in production mode
- [ ] Manual test: trigger magic link, receive real email

## Phase 2: Email Receiver DO

**Goal**: Create a DO that receives emails via Cloudflare Email Routing and notifies connected WebSocket clients.

**Success Criteria**:
- [ ] `EmailTestDO` extends `LumenizeBase` in `tooling/email-test/` (or test-endpoints)
- [ ] Parses incoming emails with `postal-mime`
- [ ] Stores recent emails in SQLite (for debugging/verification)
- [ ] WebSocket clients can subscribe to receive email notifications
- [ ] Worker `email()` handler routes to DO

## Phase 3: Deploy and Configure Email Routing

**Goal**: Deploy the email worker and configure Cloudflare Email Routing.

**Success Criteria**:
- [ ] Worker deployed to Cloudflare
- [ ] `test.email@lumenize.com` routes to the deployed worker
- [ ] Manual test: send email to test address, see it in DO storage

## Phase 4: Integration Test Helpers

**Goal**: Create test utilities for live email testing.

**Success Criteria**:
- [ ] `waitForEmail(wsClient, options)` helper function
- [ ] `extractMagicLink(email)` helper function
- [ ] Example test in `packages/auth/test/` using real email flow
- [ ] Documentation for running live tests

## Phase 5: Full Auth Flow Live Test

**Goal**: End-to-end test of magic link auth with real email.

**Success Criteria**:
- [ ] Test requests magic link
- [ ] Test receives email via WebSocket
- [ ] Test extracts and clicks magic link
- [ ] Test verifies JWT is issued
- [ ] Test can be run in CI (with secrets) or locally

## Notes

### Cloudflare Email Workers Limitation

From `test-harness.ts`: *"THIS IS NOT ACTIVE. I COULDN'T FIGURE OUT HOW TO DEPLOY AN EMAIL WORKER. I EDITED IN THE CLOUDFLARE DASHBOARD"*

Need to investigate:
- Can email workers be deployed via wrangler?
- Or must they be configured in dashboard?
- Does the worker need special configuration/entrypoint?

### AWS SES Configuration

Required environment variables:
```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=us-east-2
```

Sender email must be verified in SES: `auth@lumenize.com`

### Cloudflare Email Routing

Configuration in Cloudflare Dashboard:
- Email Routing → Routes
- `test.email@lumenize.com` → Worker: `email-test` (or similar)

