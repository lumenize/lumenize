# Nebula Outside-World Connectivity

**Status**: Design — brainstorm captured, spikes pending. Not yet reviewed (`/review-task`) or built.

## Objective

Nebula's server-side is intentionally locked down, but apps need to talk to the outside world: send/receive email, receive webhooks, run scheduled jobs, call authenticated third-party APIs. This file is the umbrella design for how we support that **without** turning the locked-down backend into a foot-gun (open proxy / SSRF cannon / shared-reputation liability).

**Thesis (the reframe):** don't build a catalog of integration *primitives* (an email service, an egress broker, a webhook framework). Build a secure **substrate** — a server-side execution surface plus a few choke points — and let the **Studio agent write the integrations as ordinary app code**. The dynamic-worker / facet lever (already chosen for the Studio engine) is what makes this possible.

## Why client-side isn't enough — the six blockers

The client (browser) can do a lot: outbound `fetch` to CORS-friendly endpoints, render UI, generate PDFs, upload to S3/R2 via a presigned URL. It fails for exactly six reasons:

| # | Blocker | What it kills |
|---|---|---|
| **B1** | Can't hold a long-lived secret (visible in the browser) | Any authenticated 3rd-party API with a static key |
| **B2** | Not addressable (no stable inbound endpoint) | Webhooks, inbound email/SMS, OAuth callbacks |
| **B3** | Not always-on (tab closes) | Cron, scheduled/delayed actions, polling |
| **B4** | No sender reputation (random IP, no SPF/DKIM/DMARC) | Email/SMS deliverability |
| **B5** | CORS-blocked (3rd-party API rejects browser origin) | A large chunk of SaaS APIs, even unauthenticated |
| **B6** | Untrusted / non-durable (can't be authoritative, dies mid-op) | Billing, signing, guaranteed delivery |

**Decision rule for any future need** — default to client-side, and only move server-side when a blocker forces it:

> Inbound? → server (B2). Time-triggered when tab may be closed? → server (B3). Needs a stored secret? → server (B1). Needs deliverability? → server (B4). CORS-hostile target? → server-proxy (B5). Must be authoritative/durable? → server (B6). **None of the above** (outbound, public, CORS-friendly, non-authoritative, tab-bounded) → leave it client-side.

## How the dynamic-worker/facet lever collapses the problem

A server-side execution context with both an `onRequest` handler and `fetch()` **dissolves B1–B5 into a single capability.** The app's server logic runs in a **DO facet** (not a fully-separate worker — the parent DO hands it capabilities via a custom `env`). This reuses the facet mechanism already validated for the Studio engine (`tasks/kimi-ui-gen-viability.md`; `packages/ts-runtime-parser-validator/src/facet-helper.ts`; `apps/nebula/src/star.ts:257`).

| Blocker | Dissolved by |
|---|---|
| B1 secrets | Facet reads the secret server-side via `env.secrets.resolve(name)` |
| B2 inbound | The facet *has* an `onRequest` — it's addressable |
| B4 deliverability | Tenant's **own** Resend account — their reputation, not ours |
| B5 CORS | Server-side `fetch` has no CORS |

What remains genuinely unsolved by `fetch` alone: **B3** (still needs the scheduler) and **B6** (still wants a durable outbox).

Email stops being something Nebula builds and becomes a **recipe the agent writes**: `fetch` Resend's send API outbound; receive Resend's forward-webhook on `onRequest` inbound. Nebula provides nothing email-specific — and carries none of the deliverability/reputation risk.

## The two decisions already pinned

### D1 — Secrets: model (b) + 3-mode resolution (Resources rejected)

The secret lives in a server-side **vault**; the facet reads it via `env.secrets.resolve(name)` and sets the header itself (model **b**). It is **never** stored in a Resource — Resources are client-synced reactive data, so a secret in one would leak to the browser.

Resolution is **configurable per secret name**, and the mode is a **Galaxy-admin governance setting**:

| Mode | Meaning |
|---|---|
| `galaxy-only` | Galaxy operator forces every tenant onto one account (their domain/reputation/bill) |
| `star-only` | Each tenant **must** BYO; no shared fallback (hard isolation) |
| `star-then-galaxy` | Tenant **may** override; inherits the Galaxy default |

The Star admin can only ever *populate* the Star-level secret; whether it's consulted is the Galaxy's policy. `env.secrets.resolve` walks the levels server-side per the configured mode and hands back the resolved plaintext. The agent never writes precedence logic and never sees the mode.

### D2 — Execution: a DO facet with custom-`env` capability injection (not a separate worker)

The agent's server code runs in a **facet of the Star DO**. The DO is the **capability broker**: it loads the facet and hands it an `env` of exactly the callbacks it's allowed:

- `env.data` — scoped reads/writes back into the Star (the mesh/full-type bridge)
- `env.secrets.resolve(name)` — the 3-mode resolver (D1)
- **egress** — a bare `fetch()` routed through a Nebula `EgressBroker` via the facet's `globalOutbound` (see below)

**The SSRF guard is structural, not bolted on — and the mechanism is now confirmed (`spike-outside-world-outbound.md`).** The Worker Loader config takes `globalOutbound: (Fetcher | null)`. Wiring a Nebula `EgressBroker` (a `WorkerEntrypoint`) as the facet's `globalOutbound` routes **every** subrequest — including a bare `fetch()` — through it, with **no bypass** (the facet has no other network; even `fetch('http://169.254.169.254/...')` reaches the broker). So the agent writes idiomatic `fetch()` and it is transparently choked — there is **no separate `env.fetch`** capability to opt into. The broker is the single enforcement point for the allow-list, the SSRF deny (internal/metadata ranges), per-tenant metering (the billing hook), and **secret-at-edge injection (option c)** — adding the `Authorization` header for blessed connectors so generated code never sees the credential. (`globalOutbound: null` = no network; omitting it = open internet — so it must always be set to the broker.)

## What Nebula owns (the substrate) — and what it doesn't

**Owns (build this):**
1. **Two-level secrets vault** + `env.secrets.resolve` (D1) — *Spike: secrets.*
2. **App-server facet runtime** — the `onRequest` contract + custom-`env` capability injection (D2).
3. **Ingress router** — owns the public URL, rate-limits, routes inbound HTTP to the right tenant's facet vs the existing synchronous SPA host. *Spike: inbound.*
4. **Egress choke point** — an `EgressBroker` (`WorkerEntrypoint`) wired as the facet's `globalOutbound`: allow-list + SSRF deny + metering hook + secret-at-edge injection. *Spike: outbound ✅.*
5. **Scheduler** — DO alarms invoking an `onSchedule` facet entry point. *Not a spike — alarms are proven; build item.*
6. **Security stdlib** — `verifyWebhook(provider, req, secret)`, `secrets.resolve`, a durable `outbox`/`durableFetch`. Keeps "secure by default" while the agent writes the glue.

**Does NOT own (agent writes as app code, drawing on recipes):** the actual integrations — email (Resend), payments (Stripe), Slack, Twilio, arbitrary REST APIs. No connector catalog to maintain.

## Three execution contexts — don't conflate them

1. **Browser SPA** (Vue, client-side) — existing.
2. **`Star.onRequest` SPA host** (`star.ts:145`) — *synchronous*, CSP-locked, serves HTML/assets.
3. **App-server facet** — *async*, reads secrets, makes egress calls, runs the agent's `onRequest`/`onSchedule`. **New.** The routing config dispatches: `/` + assets → context 2; `/_hooks/*` (or `/api/*`) → context 3.

## Sharp edges (carry these into review)

- **SSRF relocates, it doesn't vanish.** Outbound from untrusted *generated* code is the cannon. The mitigation is D2's no-ambient-`fetch` + `env.fetch` choke point. If skipped, the locked-down server is reopened.
- **The agent now writes privileged *server* code,** not just UI. Blast radius is bounded by running it in a facet isolated *from* the Star (capability-scoped `env`), consistent with the DO scope-isolation work already shipped.
- **Reentrancy / input gate.** A facet `env.data` callback reenters the parent Star while it may be mid-mutation. We depend on the *synchronous-mutator + single-threaded* invariant for ADR-005 soundness. Spikes must confirm callbacks land as separate DO events and characterize whether an in-flight facet `fetch` holds the input gate / keeps the DO billed-active.
- **ADR-003 is fine.** The facet↔DO `env` callback is *local capability transport within one DO* — same category as the per-hop awaited RPC ("transport, not architecture"). It is not a mesh hop; one-way-messages-and-continuations isn't in play.
- **B6 isn't free.** `fetch` alone is best-effort; guaranteed-delivery email/payment-confirm wants the durable outbox.

## The needs, condensed

Once the substrate exists, nearly every need is "done" or "compose two of them": Payments = ingress + egress; Slack bot = ingress + egress; Polling = scheduler + egress; OAuth-on-behalf-of-user = ingress (callback) + secrets (token store) + egress (refresh). The genuinely new primitives are few — secrets vault, ingress router, scheduler, egress choke point — which is exactly the substrate above.

## Spikes (companion files)

- `tasks/spike-outside-world-secrets.md` — **first; kicked off.** Two-level encrypted vault + 3-mode resolver + value reaches the facet, never the browser.
- `tasks/spike-outside-world-outbound.md` — **✅ done.** Egress choke point via `globalOutbound` → `EgressBroker`: a bare `fetch()` is routed through it with no bypass; allow-list + SSRF deny + null-=-no-network all confirmed + mutation-checked.
- `tasks/spike-outside-world-inbound.md` — *(to write)* public URL → facet `onRequest`; routing-config dispatch; `verifyWebhook`; input-gate behavior under a slow handler.

## Sequencing

1. App-server facet runtime + **egress choke point** (the keystone — everything rides it).
2. Two-level secrets vault + `env.secrets.resolve`.
3. Ingress router + scheduler.
4. Security stdlib (`verifyWebhook`, durable outbox).
5. **Email as the first recipe** — agent wires Resend both directions end-to-end; demo-relevant.

## Open forks (resolve before/within `/review-task`)

- **Outbound email provider** (Resend / Postmark / SES) and the **shared `nebula.app` domain vs per-tenant custom-domain** deliverability-isolation decision. The facet model makes per-tenant-account the default, which sidesteps most of this.
- **Connector altitude** — a curated catalog of blessed connectors (Stripe, Slack, Resend) with vetted security helpers vs a fully generic "describe any REST API + key." Lean: generic substrate + a small set of blessed recipes/helpers for the high-risk cases.
- **Secret-at-edge injection (option c)** — for blessed connectors, have `env.fetch` inject the credential so generated code never sees it at all. Stronger than model (b); offer it for Resend/Stripe while keeping (b) for the long tail.

## Notes

- Secrets vault encryption key is a **Workers Secret** (root `.dev.vars`, auto-symlinked; miniflare `bindings` for tests) — never committed, never in `wrangler.jsonc`.
- Per-tenant key derivation (HKDF keyed by scope) is a hardening follow-up, not v1 — limits blast radius if a ciphertext+key pair leaks.
