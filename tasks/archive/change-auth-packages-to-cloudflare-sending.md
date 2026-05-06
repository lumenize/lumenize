# Switch Auth Packages to Cloudflare Email Sending

**Status**: Complete — all e2e suites pass end-to-end (Cloudflare + Resend + Hono). See "Resolved blocker" below.
**Branch**: `claude/epic-mirzakhani-db4ad4` (worktree)

## Goal

Replace Resend with Cloudflare's newly open-beta Email Sending service as the default (and recommended) email transport in `@lumenize/auth` and `@lumenize/nebula-auth`. Cloudflare's binding-based model eliminates the API-key/REST-call story and keeps everything in the Workers platform.

## Why This Is a Clean Migration

Current architecture already has the right seam:
- `AuthEmailSenderBase` (abstract `WorkerEntrypoint`) owns templates, subjects, dispatch.
- `ResendEmailSender extends AuthEmailSenderBase` is ~30 lines of `fetch` to Resend — the only coupling point.
- `NebulaEmailSender extends ResendEmailSender` just overrides `from` and `appName`.

So the migration is: add a sibling `CloudflareEmailSender extends AuthEmailSenderBase`, repoint `NebulaEmailSender` at it, and make Cloudflare the documented default. Transport swap at a single seam.

## Key Fact Differences (Resend → Cloudflare)

Only differences that matter to our migration. Both providers' wire APIs support cc/bcc/attachments/etc.; our package interface only uses `{to, subject, html, from, replyTo, appName}` and that doesn't change. `AuthEmailSenderBase` and `sendEmail()` signature are untouched.

| | Resend | Cloudflare Email Sending |
|---|---|---|
| Transport | REST `fetch` + `RESEND_API_KEY` secret | `env.EMAIL.send(...)` binding (type `SendEmail`) |
| Config surface | Secret in `.dev.vars` | `send_email` entry in `wrangler.jsonc` |
| Domain setup | Resend dashboard verifies DNS | Cloudflare onboards domain, adds SPF/DKIM/DMARC/MX |
| Plan gate | Resend free tier (100/day) | Workers **Paid plan** (entry tier $5/mo) |
| Errors | HTTP status + JSON body | Thrown `Error` with `.code` (e.g. `E_SENDER_NOT_VERIFIED`, `E_RATE_LIMIT_EXCEEDED`) |

## Design Decisions

1. **Keep `ResendEmailSender`, move it to its own docs page.** Not removed. `@lumenize/auth` getting-started and `@lumenize/mesh` getting-started both lead exclusively with Cloudflare. Resend gets a standalone page (likely `website/docs/auth/using-resend-instead.mdx` or similar) linked from configuration. **Action**: audit every `Resend` reference across the repo (5 `.mdx` files identified: `auth/getting-started`, `auth/configuration`, `auth/auth-flow`, `auth/hono`, `mesh/getting-started`) — each reference must either (a) live on the new standalone Resend page, or (b) be removed/replaced with Cloudflare.

2. **Sending domain: `lumenize.io`.** Already onboarded for Email Routing; piggybacking for Sending.

3. **Non-breaking migration.** Existing deployments on `ResendEmailSender` + `RESEND_API_KEY` keep working unchanged. Only docs/samples/defaults switch to Cloudflare. No deprecation warning at runtime.

4. **Paid-plan admonition** in `@lumenize/auth` getting-started: admonition that mentions the Paid-plan requirement and the low cost ($5/mo entry tier), plus a line in the blog post. No top-of-page warning. Mesh admonition audit captured as separate backlog item.

5. **Test sender/recipient address: `test@lumenize.io`.** Already wired as the Email Routing custom address → EmailTestDO. Package code stays address-agnostic (the `from` field lives on the test-harness subclass, not in the package). If Cloudflare rejects sender==recipient inside the test flow, fall back to a distinct sender like `auth@lumenize.io` and note in task file. Not a package-level concern — purely test harness.

## Scope Correction

There is **no `@lumenize/nebula-auth` getting-started doc** (Nebula is an application/platform, not a standalone package). Only `packages/nebula-auth/src/nebula-email-sender.ts` needs to repoint to `CloudflareEmailSender`. Documentation updates are limited to `@lumenize/auth` docs and the Resend reference in `@lumenize/mesh` getting-started. The existing nebula-auth flows doc doesn't mention Resend and needs no change.

## High-Level Phases

### Phase 1 — Implementation
- Add `CloudflareEmailSender` in `packages/auth/src/` mirroring `ResendEmailSender` shape but using `env.EMAIL.send(...)`. Map `EmailMessage` error codes to useful thrown errors.
- Repoint `NebulaEmailSender` to extend `CloudflareEmailSender`. Delete the Resend-specific dependency only if we're dropping Resend; otherwise leave both options available.
- Export `CloudflareEmailSender` from `@lumenize/auth` index.
- Update `.dev.vars.example` (Resend key becomes optional/alternative; note Cloudflare needs no secret).
- Update sample `wrangler.jsonc` files that ship with the packages.

### Phase 2 — E2E Test Framework
The existing framework is the crown jewel — it flows real emails through Cloudflare Email Routing → deployed `EmailTestDO` → WebSocket back to the test. It already depends on Cloudflare Email receiving, so Cloudflare sending is a natural fit.
- Update `test/e2e-email/test-harness.ts` `AuthEmailSender` to extend `CloudflareEmailSender`.
- Update `test/e2e-email/wrangler.jsonc` — add `send_email` binding, drop `RESEND_API_KEY` dependency from this path.
- Add a second e2e suite that still exercises `ResendEmailSender` (smaller, but kept honest).
- Run full e2e suites for both `packages/auth` and `packages/nebula-auth`. Do not mock. Do not skip. If anything is flaky, fix the flake, don't hide it.

### Phase 3 — Documentation
- `website/docs/auth/getting-started.mdx` — rewrite Email Provider section (lines ~98-193) to lead with Cloudflare. Add Paid-plan admonition (mentions $5/mo entry tier). Strip Resend details — they move to the new standalone page.
- `website/docs/auth/configuration.mdx` — update class hierarchy table, environment variable table, bindings table. `RESEND_API_KEY` becomes optional with pointer to the Resend page.
- `website/docs/auth/auth-flow.mdx` and `website/docs/auth/hono.mdx` — update any Resend mentions to Cloudflare (or remove if not load-bearing).
- `website/docs/mesh/getting-started.mdx` section 8a — same treatment as auth/getting-started. Leads with Cloudflare, links to standalone Resend page.
- **New**: `website/docs/auth/using-resend-instead.mdx` (or similar slug — decide during implementation) — consolidates the removed Resend content. Add to `website/sidebars.ts`.
- All new code examples use `@check-example` pointing to real tests (no `@skip-check` left behind).
- Final audit: `grep -r -i "resend" website/` and review each hit.

### Phase 4 — Blog Post
- New post under `/website/blog/2026-MM-DD-auth-now-on-cloudflare-email/` matching recent post style (frontmatter, narrative, code examples).
- Angle: "We use Cloudflare Email Service now that sending is in open beta — here's what changed and why it's nicer." Keep it honest about the Paid plan tradeoff.

### Phase 5 — Verification & Wrap-up
- `npm run type-check` clean.
- `npm run test:code` passes (all packages).
- `npm run test:doc` passes (no `@skip-check` debt added).
- `npm run check-examples` green.
- `cd website && npm run build` succeeds.
- All e2e email tests run green against both senders.
- Manual smoke: deploy a test Worker with new binding, send to a real inbox, inspect headers (DKIM/SPF pass).
- Update `MEMORY.md` if any durable lessons emerge; otherwise leave memory alone.

## Out of Scope
- Attachments, cc/bcc, inline images — Cloudflare supports them but auth package doesn't need them. Won't add. (Future work if someone asks.)
- Removing Resend entirely (see Q1).
- Cloudflare Email *receiving* changes — already used by the test harness and working.

## Resolved blocker: Domain onboarding for Email Sending

Phase 2 initially failed with `"destination address is not a verified address"` from the real Cloudflare Email Sending service. Root cause: `lumenize.io` had been onboarded for Email **Routing** but not for Email **Sending** — those are separate dashboard flows with separate DNS records.

**What the user did to unblock:** Dashboard → Email Services → Email Sending → Onboard Domain → `lumenize.io`. Cloudflare added SPF, DKIM, DMARC, and `cf-bounce` MX records automatically.

**Result:** All 160 tests pass across 11 test files, including both Cloudflare e2e tests, the Resend e2e smoke test, and the Hono integration e2e test. Real end-to-end email delivery confirmed.

## Risk / Things That Could Bite

- **Domain onboarding for Sending** on `lumenize.io`: onboarded for Email Routing already, but Sending may need an additional opt-in step in the dashboard. If so, tests fail with `E_SENDER_NOT_VERIFIED`. I'll flag it the moment the first e2e run fails; you handle the dashboard step.
- **Paid plan gate** on the account running tests. Confirm before Phase 2.
- **Error-shape differences**: Resend returns HTTP errors; Cloudflare throws `Error` with `.code`. The current `ResendEmailSender.sendEmail()` throws on non-OK response too, so callers in `AuthEmailSenderBase.send()` already handle thrown errors — but I'll audit once to be sure nothing is HTTP-shape-dependent.
- **Same-address sender/recipient** (`test@lumenize.io` → `test@lumenize.io`): may trip sender-loop protection or Email Routing rules. If so, split to `auth@lumenize.io` → `test@lumenize.io` and move on.
