# ADR-009: Real Auth Path over Synthetic Shortcuts

**Date**: 2026-07-06
**Status**: Accepted
**Deciders**: Larry
**Evidence**: `feedback_real_auth_path_over_shortcuts` memory; the `create-nebula-test-token` client-mint + the `/live` harness (`apps/nebula/harness/`); the 2026-07-06 mis-grounding it enabled (concluding "the user turn isn't persisted" from the mint/server path, missing the real client-login `postUserMessage`).

## Context

Repeatedly, shortcutting the real email-based login to save an automated run a few seconds has cost more than it saved — in the reviewer's time (**the bottleneck**) and, worse, in **accuracy**: a shortcut path exercises *different code* than the real one, so design reasoning grounds on the wrong behavior. The tell is a general testing prior — "email is slow/flaky, mock it" — that is **correct for most systems but miscalibrated here**. A full real-login round-trip measures, end-to-end **~8s on Resend and ~1-3s on Cloudflare** (2026-07-06, prod `apps/nebula/harness/prod.ts spin`), and it's **email-pipeline-bound, not cold-start** — warm and cold both land at ~8s (~6.6s of it pure I/O wait). The send currently goes via **Resend** (cross-provider: Resend → SES → CF Email Routing inbound → Worker); a **Cloudflare Email Sending** (`send_email`) path is arbitrary-capable and CF→CF-faster — a revisit-later optimization, currently gated on **CF Email Sending's beta 200/day limit** (Resend is GA with no hard limit, just cross-provider slower). ~8s is *negligible where real login matters* (harness / e2e / `/live` / grounding are minutes-scale) and the accuracy win dominates — but it is also **why rung 2 below exists**: 8s is too slow to put in every unit test. (A standalone measurement pays fresh process + WS-connect overhead; an *in-flight* warm test sees a smaller marginal email cost.) Once a **catch-all** email route (`*@lumenize.io → email-test Worker`) exists, real login is frictionless for *any* address — removing the friction that made the shortcut tempting.

## Decision

The **real email-based login is the default** for anything exercising auth / identity / multi-user, for the harness / e2e / `/live`, and — decisively — **as the path design reasoning grounds on.** Never conclude how the system behaves from a synthetic path. Shortcuts form a ladder, most-preferred first:

1. **Real login** (email → magic-link → cookie → token). The only path we ground behavior on. Frictionless via catch-all routing.
2. **Test-mode server-issuance** (`LUMENIZE_AUTH_TEST_MODE` / `createTestRefreshFunction`) — for isolated unit tests needing an authed identity but not the email round-trip. **Real server issuance, no email, no client mint.** This rung exists so we don't trade the shortcut tax for a **flake tax** (email is an external dependency with cold-start latency).
3. **Client-side synthetic mint** (`create-nebula-test-token`) — last resort; each surviving use justified in-place.
4. **Negative-control mints** — deliberately *wrong-shape* tokens (base-shape, no-`access`) to prove the gateway rejects them. Real login cannot produce a wrong-shape token, so this is **not** a happy-path shortcut and stays legitimate.

The real multi-user login is **dual-use**: our testing/harness infra *and* a user-developer feature (log N users into their own preview tabs to test their access-control model; later, the substrate for user-developer automated testing). Build it in a reusable place, not per-test.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Mock/synthetic-mint by default** (the reflex) | The status quo that caused this. Divergence from the real path → mis-grounding + maintenance surface + reviewer-time tax. The seconds saved per run are dwarfed by the bottleneck's minutes. |
| **Real email in *every* test, including fast unit tests** | Trades the shortcut tax for a flake tax — email is an external dependency; cold-starts and the occasional non-delivery would make the unit suite flaky. Rung 2 (test-mode issuance) is the escape valve. |
| **A rule in `.claude/rules/` instead of an ADR** | It's a convention *and* a grounding commitment that a fresh contributor/LLM will re-violate in week one (it just did); it must be read at `/review-task` to catch a shortcut designed into a task. A `testing.md` note can reference this ADR, but the commitment lives here. |

## Consequences

### Positive
- The divergence/mis-grounding class is closed — design reasoning grounds on real behavior.
- Less shortcut machinery to build + maintain (`create-nebula-test-token`'s correct-shape uses migrate to real login).
- The dual-use multi-user login becomes a shipped user-developer capability, not throwaway test glue.

### Negative / mitigations
- Real email is an external dependency with a ~8s pipeline latency (warming doesn't help — it's I/O-bound, not cold-start) and rare non-delivery. **Mitigation:** rung 2 for fast isolated units; generous timeouts in e2e/harness (where ~8s is negligible anyway).
- Requires the catch-all route provisioned — a one-time email-config step (`lumenize.io`, an all-infra domain; reserve the apex for named identities, subdomain-isolate later only if a real inbox appears).
