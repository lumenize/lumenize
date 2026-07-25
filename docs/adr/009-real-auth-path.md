# ADR-009: Real Auth Path over Synthetic Shortcuts

**Date**: 2026-07-06
**Status**: Accepted
**Deciders**: Larry
**Evidence**: `feedback_real_auth_path_over_shortcuts` memory; the `create-nebula-test-token` client-mint + the `/live` harness (`apps/nebula/harness/`); the 2026-07-06 mis-grounding it enabled (concluding "the user turn isn't persisted" from the mint/server path, missing the real client-login `postUserMessage`).

## Context

Repeatedly, shortcutting the real email-based login to save an automated run a few seconds has cost more than it saved — in the reviewer's time (**the bottleneck**) and, worse, in **accuracy**: a shortcut path exercises *different code* than the real one, so design reasoning grounds on the wrong behavior. The tell is a general testing prior — "email is slow/flaky, mock it" — that is **correct for most systems but miscalibrated here**. The real magic-link loop — request issued → link in hand — measures **~1.4 s on either provider** (median: Cloudflare 1451 ms / n=9, Resend 1400 ms / n=10), and **~0.9 s marginal** for an additional login inside an already-running suite. In a test lane, cold lands inside the warm spread — no cold-start penalty worth naming — and there is **no meaningful difference between Resend and Cloudflare**. (Prod's *first* send after idle is the one exception, ~7 s; see the note below. It does not touch the in-suite cost.) At ~1 s the cost argument for shortcutting is simply gone — the accuracy win dominates a price that was never being paid. Once a **catch-all** email route (`*@lumenize.io → email-test Worker`) exists, real login is frictionless for *any* address — removing the friction that made the shortcut tempting.

> **Amended 2026-07-21 — the original cost figure was wrong, and it was the sentence sessions cited to reach for a shortcut.** This ADR first claimed "**~8s on Resend and ~1-3s on Cloudflare** … warm and cold both land at ~8s", citing `apps/nebula/harness/prod.ts spin`. Two defects: that command contains **no timer** anywhere in its call path (the figure was hand-wall-clocked, bundling tsx boot, `.dev.vars` reads, a `POST /clear` and a WS handshake — a caveat the original text itself conceded), and per the config in effect on 2026-07-06 it sent via the **Cloudflare** binding, not Resend (`send_email` `EMAIL` binding, no `EMAIL_PROVIDER`; `createEmailTransport` takes `if (e.EMAIL)`) — so the one instrument named for *both* numbers could only ever have exercised one path. Re-measured with in-place instrumentation on the two `packages/auth` e2e lanes (`reportEmailLatency`, now printed on every run so this is re-derivable rather than quoted): the providers are indistinguishable at ~1.4 s. Full method, samples and caveats: the archived email-latency decision record. **The decision and the ladder below are unchanged by this correction** — but see the ⚠️ on rung 2, whose stated rationale did not survive it.
>
> **On the ~8 s (corrected twice — take the table, not a narrative).** A controlled probe (`discover` hits the *same* registry DO with **no email send**, isolating DO wake from send cost) gives: registry DO **3030 ms cold / ~50 ms warm**; `email-magic-link` **6995 ms on an already-warm DO**, recovering to **~1.2 s**. So the ~7 s is the **email-send path's first call after idle** — not DO cold start (my first correction was wrong about that) and not fictional (my earlier one was wrong about that too). ADR-009's *"email-pipeline-bound"* was closer to right than either; what it got wrong is *"warm and cold both land at ~8s"* — warm is ~6× faster. Rows to quote: **~7 s** first send after idle · **~1.2 s** warm prod magic-link · **~1.4 s** first email in a test run · **~0.9 s** each additional login in that run. Provider does not matter (1451 vs 1400 ms in isolation). ⚠️ What takes 7 s inside that first send is **still unexplained** and is a real signup-path cost — backlog.

## Decision

The **real email-based login is the default** for anything exercising auth / identity / multi-user, for the harness / e2e / `/live`, and — decisively — **as the path design reasoning grounds on.** Never conclude how the system behaves from a synthetic path. Shortcuts form a ladder, most-preferred first:

1. **Real login** (email → magic-link → cookie → token). The only path we ground behavior on. Frictionless via catch-all routing.
2. **Test-mode server-issuance** (`LUMENIZE_AUTH_TEST_MODE` / `createTestRefreshFunction`) — for isolated unit tests needing an authed identity but not the email round-trip. **Real server issuance, no email, no client mint.** This rung exists so we don't trade the shortcut tax for a **flake tax** — email is an external dependency, and an outage or non-delivery reddens an otherwise-deterministic unit suite.
   - ⚠️ **Open (2026-07-21): this rung's cost rationale did not survive re-measurement.** The Context originally justified it on "8 s is too slow to put in every unit test"; the real figure is **~0.9 s marginal** inside a running suite, so the speed argument is gone, as is the "cold-start latency" it leaned on. The **flake** argument above stands on its own and is why the rung is left in place pending review — but it was never the *written* reason. **Whether rung 2 survives is a decision for Larry, not something the measurement settles.**
3. **Client-side synthetic mint** (`create-nebula-test-token`) — last resort; each surviving use justified in-place.
4. **Negative-control mints** — deliberately *wrong-shape* tokens (base-shape, no-`access`) to prove the gateway rejects them. Real login cannot produce a wrong-shape token, so this is **not** a happy-path shortcut and stays legitimate.

The real multi-user login is **dual-use**: our testing/harness infra *and* a user-developer feature (log N users into their own preview tabs to test their access-control model; later, the substrate for user-developer automated testing). Build it in a reusable place, not per-test.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Mock/synthetic-mint by default** (the reflex) | The status quo that caused this. Divergence from the real path → mis-grounding + maintenance surface + reviewer-time tax. The seconds saved per run are dwarfed by the bottleneck's minutes. |
| **Real email in *every* test, including fast unit tests** | Trades the shortcut tax for a flake tax — email is an external dependency, and the occasional non-delivery would redden the unit suite. Rung 2 (test-mode issuance) is the escape valve. (The *latency* half of this objection was withdrawn 2026-07-21 — see the rung-2 ⚠️; only the dependency/flake half remains.) |
| **A rule in `.claude/rules/` instead of an ADR** | It's a convention *and* a grounding commitment that a fresh contributor/LLM will re-violate in week one (it just did); it must be read at `/review-task` to catch a shortcut designed into a task. A `testing.md` note can reference this ADR, but the commitment lives here. |

## Consequences

### Positive
- The divergence/mis-grounding class is closed — design reasoning grounds on real behavior.
- Less shortcut machinery to build + maintain (`create-nebula-test-token`'s correct-shape uses migrate to real login).
- The dual-use multi-user login becomes a shipped user-developer capability, not throwaway test glue.

### Negative / mitigations
- Real email is an external dependency with rare non-delivery. Latency is **not** among its costs — ~1.4 s standalone, ~0.9 s marginal (amended 2026-07-21). **Mitigation:** generous timeouts in e2e/harness; rung 2 for fast isolated units, on flake grounds rather than speed (see its ⚠️).
- Requires the catch-all route provisioned — a one-time email-config step (`lumenize.io`, an all-infra domain; reserve the apex for named identities, subdomain-isolate later only if a real inbox appears).
