# Which `send_email` sends count against Cloudflare's daily quota — 2026-10-03

**Question.** CI failed twice on 2026-10-03 with `account daily sending quota exceeded`, thrown by the
`EMAIL` binding inside `POST /auth/claim-universe`. Cloudflare's limits page says sends to a
**verified destination address** never count toward the quota. Do our test recipients, per-run
`test-…@lumenize-test.dev` addresses delivered by that zone's catch-all to the `email-test` Worker,
count as verified?

**Method.** `src/index.ts` is a local-only Worker (`wrangler dev --port 8799`) with the same binding,
`{ "name": "EMAIL", "remote": true }`, and the same `send()` call shape as
`packages/email/src/cloudflare-email-transport.ts`. `drive.mts` arms an `email-test` waiter, asks the
probe to send, and reports whether the send was accepted and whether it arrived.

The quota had reset by the time this ran, so a send succeeding says nothing about whether it counted.
The discriminator is the sender instead: Cloudflare lets a sender on a domain **not** onboarded for
Email Sending reach only verified destinations — exactly the set that is free. `lumenize-test.dev` has
Email Routing and no Email Sending, so a send from `noreply@lumenize-test.dev` asks the binding
directly whether a recipient is verified, without spending quota.

## Results

| From | To | Binding answered |
|---|---|---|
| `noreply@lumenize.io` (Sending onboarded) | `quota-probe-…@lumenize-test.dev` | accepted, arrived at `email-test` |
| `noreply@lumenize-test.dev` (Routing only) | `quota-probe-…@lumenize-test.dev` | `destination address is not a verified address` |
| `noreply@lumenize-test.dev` | `test@lumenize.io` (verified) | passed the check; `permanent delivery failure` (that zone drops `test@` now) |
| `noreply@lumenize-test.dev` | `claude@lumenize.io` (pending) | `destination address is not a verified address` |
| `noreply@lumenize-test.dev` | `test+probe…@lumenize.io` | `destination address is not a verified address` |
| `noreply@lumenize-test.dev` | `Test@lumenize.io`, `test@LUMENIZE.IO` | `destination address is not a verified address` |
| `noreply@lumenize-test.dev` | `claude@lumenize.io`, after Larry opened its link | accepted, arrived at `email-test` |

`wrangler email sending send` (the REST path) accepted all four of the first sends while the quota was
not exhausted; it says nothing about counting either.

## What it means

1. **A catch-all that delivers to a Worker does not make its addresses verified.** Every test mail a
   local or CI stack sends through the binding, from `noreply@lumenize.io` to a per-run address, is an
   Email Sending send and counts against the daily quota.
2. **Verification is an exact, case-sensitive match on the whole address.** A verified `test@` does
   not cover `test+anything@`, nor a different case, so no single verified address can stand for a
   family of test addresses.
3. **Verifying an address needs a person.** `wrangler email routing addresses create <email>` sends
   Cloudflare's verification mail, which a routed address delivers to `email-test`, but its link,
   `dash.cloudflare.com/email_fwdr/verify?token=…`, answers a script-free client with a bot challenge
   ("Just a moment… Enable JavaScript and cookies"). Re-creating an existing address re-sends the mail,
   and a second re-send within minutes is refused with code 2025, "Verification email has been sent
   too recently". An account holds at most 200 verified addresses.

⇒ Staying on the binding for test mail means one of: a quota raised by Cloudflare's limit-increase
form, or a small, fixed set of person-verified addresses the tests reuse. Resend has neither limit in
our use, and production already sends through it.

## Not measured

The quota's size and its reset rule: CI was refused at 19:14Z and the probe's sends were accepted by
21:55Z, so it reset in between, which is not UTC midnight. The analytics dataset,
`emailSendingAdaptiveGroups`, has no dimension for verified, billable or quota.
