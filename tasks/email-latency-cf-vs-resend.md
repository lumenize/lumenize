# Email latency — Cloudflare vs Resend, measured

**Status:** ACTIVE — measurement task, spun off 2026-07-21 from the `testing.md` client-first default.

**Question:** how long does a real magic-link round trip actually take on each provider, and can the fast one be the local default?

## Why this matters more than a perf nit

`testing.md` now makes *"drive a real `NebulaClient` through the real login"* the **default** tier for Nebula behavior. That default only holds if the round trip is cheap enough that nobody reaches for a shortcut — and reaching for shortcuts is exactly what produced the login-shortcut era (low fidelity → real bugs through, ossified fixtures, deferred building what the feature needed to be usable).

⚠️ **The number is load-bearing beyond this task.** [ADR-009](../docs/adr/009-real-auth-path.md) justifies its rung-2 (test-mode server issuance) partly on *"a real login round-trip is ~8s … the reason rung 2 exists for fast units."* If the local path is ~1s, that justification mostly evaporates and the ADR's cost line should be rewritten — it is the sentence a future session will cite to reach for a shortcut.

## ⚠️ NOT an experiment directory — the apparatus already exists

Two comparable lanes are already built and run the same magic-link loop:

| Lane | Provider | Binding |
|---|---|---|
| `packages/auth/test/e2e-email` | Cloudflare | `send_email` **with `remote: true`** |
| `packages/auth/test/e2e-email-resend` | Resend | none (REST) |

Building a parallel spike under `experiments/` would be a throwaway artifact measuring something we can measure directly — the exact anti-pattern `workflow.md` § unlearning tax now warns about ("a test is a consumer"). **Measure the real lanes.**

## Method

1. **Baseline both**, several runs each, warm and cold — `testing.md` notes first-run-after-idle is a cold start, not a bug, and Resend in particular has an idle penalty. Report median *and* first-run separately; a default is chosen on the median, but a developer feels the cold one.
2. **Time the loop, not the suite** — instrument from magic-link request to link receipt, so setup/teardown and pool startup don't contaminate it.
3. **Answer the `remote: true` question** (the standing OPEN item in `cf-email-sending-vs-routing`): the CF lane declares `remote: true` today, but nobody has tried without it. It gates two things — whether a local fast path needs stored creds at all, and whether a hosted-CI binding is possible. ⚠️ `remote: true` binds at **pool load**, so a creds failure kills the whole project, not one test (`vitest-remote-binding-load-time`).
4. **Confirm `lumenize.io` is verified** in Email Routing — the whole CF path depends on it, and it is listed as unconfirmed.

## Success criteria

- Median and first-run latency for both providers, from the same loop, stated with run counts.
- A yes/no on whether the CF send binding requires `remote: true`.
- A recommendation on the local default, with the gating shape named (opt-out flag, per `testing.md` — the constrained lane sets it; capable lanes stay untouched).
- If CF wins decisively: the concrete edit to ADR-009's cost line, so the stale justification does not survive.

## What is already settled — do not re-derive

- ✅ **No 200/day concern.** The beta cap is on the arbitrary-recipient **Email Sending** feature. Verified addresses/domains send via **Routing** instead, so it never touches `*@lumenize.io` test email — double-confirmed with Cloudflare employees. This has been misread repeatedly; if you find yourself about to write "beta 200/day" as a caveat here, stop.
- ✅ **The transport is already provider-agnostic.** `createEmailTransport` selects by env: an `EMAIL` binding → Cloudflare; no binding or `EMAIL_PROVIDER=resend` → Resend (`auth-email-sender-base.ts:67-71`). Switching is a binding, not a redesign.
- ✅ **The gating shape exists.** `packages/auth/vitest.config.js` already uses the opt-out flag `LUMENIZE_NO_CF_REMOTE`, set only by the secret-less Claude-hosted lane, with a loud warning when coverage is dropped. Copy that shape; do not invent a new one.
- **Why Nebula went all-Resend originally:** reaching CF email via its **REST API** needs a highly-privileged CF key, stored plaintext in hosted environments — a far bigger blast radius than Resend's email-only key. That argument is about the **REST** path and hosted envs; it does **not** apply to a local binding authed by OAuth, which is what this task is testing.

## Relationships
- Feeds the backlog item "Switch local Nebula test email from Resend to Cloudflare".
- Feeds a possible ADR-009 cost-line rewrite (see above).
- Resolves the standing OPEN question in the `cf-email-sending-vs-routing` memory.
