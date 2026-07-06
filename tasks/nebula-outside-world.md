# Nebula Outside-World Connectivity

**Status**: Design + phased build plan — **reactive on demand** (no longer "do not build"): Larry expects first pre-alpha users to ask for outside-world capabilities (one wants `fetch`, another email). Pick up per user demand, but **gated on a `/review-task` pass** (the Open forks below must close first) + the in-flight Studio/branch work settling (several phases touch `star.ts`). Spikes proven + mutation-checked (2026-06-17); not yet `/review-task`'d or built. Parent index: [`nebula-pre-alpha-fast-follow.md`](nebula-pre-alpha-fast-follow.md).

## The simplification (why this project is small)

**Don't build a catalog of integration *primitives*** (an email service, an egress broker, a webhook framework). Build a thin secure **substrate** — a server-side execution surface plus a few choke points — and let the **Studio agent write the integrations as ordinary app code.**

The lever that makes this possible: a server-side execution context with both an `onRequest` handler and `fetch()` **dissolves blockers B1–B5 into a single capability.** The app's server logic runs in a **DO facet** of the Star (not a separate worker — the parent DO hands it capabilities via a custom `env`), reusing the facet mechanism already validated for the Studio engine. Wiring a Nebula `EgressBroker` as the facet's `globalOutbound` routes **every** subrequest — including a bare `fetch()` — through one choke point with **no bypass**, so the agent writes idiomatic `fetch()` and it is *transparently* SSRF-guarded, metered, and (for blessed connectors) credential-injected. There is **no separate `env.fetch` to opt into.**

Email stops being something Nebula builds and becomes a **recipe the agent writes**: `fetch` Resend outbound, receive Resend's forward-webhook on `onRequest` inbound. Nebula owns none of the deliverability/reputation risk — the tenant uses their own account.

**Second consumer of the same substrate:** the Studio AI's own outside-world tools (`web_search`, `fetch_url`) ride the same `EgressBroker` + secrets vault — see [`reference/nebula-agentic-engine-design.md`](reference/nebula-agentic-engine-design.md) § *Studio AI tool surface*. This file's primary subject is *generated-app* connectivity; the agent's tools are a distinct-but-substrate-sharing consumer (and the LLM-picks-the-URL `fetch_url` case leans hard on the SSRF deny).

## Why client-side isn't enough — the six blockers + decision rule

The browser can do a lot (outbound `fetch` to CORS-friendly endpoints, UI, PDFs, presigned-URL uploads). It fails for exactly six reasons:

| # | Blocker | What it kills |
|---|---|---|
| **B1** | Can't hold a long-lived secret (visible in the browser) | Any authenticated 3rd-party API with a static key |
| **B2** | Not addressable (no stable inbound endpoint) | Webhooks, inbound email/SMS, OAuth callbacks |
| **B3** | Not always-on (tab closes) | Cron, scheduled/delayed actions, polling |
| **B4** | No sender reputation (random IP, no SPF/DKIM/DMARC) | Email/SMS deliverability |
| **B5** | CORS-blocked (3rd-party rejects browser origin) | A large chunk of SaaS APIs, even unauthenticated |
| **B6** | Untrusted / non-durable (can't be authoritative, dies mid-op) | Billing, signing, guaranteed delivery |

**Decision rule for any future need** — default to client-side, only move server-side when a blocker forces it:

> Inbound? → server (B2). Time-triggered when the tab may be closed? → server (B3). Needs a stored secret? → server (B1). Needs deliverability? → server (B4). CORS-hostile target? → server-proxy (B5). Must be authoritative/durable? → server (B6). **None of the above** (outbound, public, CORS-friendly, non-authoritative, tab-bounded) → leave it client-side.

The facet lever dissolves B1 (facet reads the secret server-side), B2 (the facet *has* an `onRequest`), B4 (tenant's own account/reputation), B5 (server-side `fetch` has no CORS). What `fetch` alone leaves genuinely unsolved: **B3** (needs the scheduler) and **B6** (wants a durable outbox).

## The two pinned decisions

### D1 — Secrets: server-side vault + 3-mode resolution (Resources rejected)

The secret lives in a server-side **vault**; the facet reads it via `env.secrets.resolve(name)` and sets the header itself. It is **never** stored in a Resource (Resources are client-synced → a secret there leaks to the browser). Resolution mode is **configurable per secret name**, a **Galaxy-admin governance setting**:

| Mode | Meaning |
|---|---|
| `galaxy-only` | Galaxy operator forces every tenant onto one account (their domain/reputation/bill) |
| `star-only` | Each tenant **must** BYO; no shared fallback (hard isolation) |
| `star-then-galaxy` | Tenant **may** override; inherits the Galaxy default |

The Star admin can only ever *populate* the Star-level secret; whether it's consulted is Galaxy policy. `env.secrets.resolve` walks the levels server-side per the mode and hands back the resolved plaintext. The agent never writes precedence logic and never sees the mode.

### D2 — Execution: a DO facet with custom-`env` capability injection (not a separate worker)

The agent's server code runs in a **facet of the Star DO**, which is the **capability broker** — it loads the facet and hands it an `env` of exactly the callbacks it's allowed:
- `env.data` — scoped reads/writes back into the Star (the mesh/full-type bridge)
- `env.secrets.resolve(name)` — the 3-mode resolver (D1)
- **egress** — a bare `fetch()` routed through the `EgressBroker` via the facet's `globalOutbound` (no separate `env.fetch` capability)

**The SSRF guard is structural, not bolted on** (mechanism confirmed by the outbound spike): the Worker Loader config takes `globalOutbound: (Fetcher | null)`. The facet has no other network, so even `fetch('http://169.254.169.254/...')` reaches the broker. The broker is the single enforcement point for the allow-list, the SSRF deny (internal/metadata ranges), per-tenant metering (the billing hook), and **secret-at-edge injection** (adding the `Authorization` header for blessed connectors so generated code never sees the credential). `globalOutbound: null` = no network; omitting it = open internet — so it must always be set to the broker.

## What Nebula owns (the substrate) — and what it doesn't

**Owns (build this):** two-level secrets vault + `env.secrets.resolve`; app-server facet runtime (`onRequest`/`onSchedule` contract + custom-`env`); ingress router (owns the public URL, rate-limits, dispatches inbound to the right facet vs the synchronous SPA host); egress choke point (`EgressBroker` as `globalOutbound`); scheduler (DO alarms → `onSchedule`); security stdlib (`verifyWebhook`, durable `outbox`/`durableFetch`).

**Does NOT own (agent writes as app code, drawing on recipes):** the actual integrations — email (Resend), payments (Stripe), Slack, Twilio, search, arbitrary REST. No connector catalog to maintain.

## Three execution contexts — don't conflate

1. **Browser SPA** (Vue, client-side) — existing.
2. **`Star.onRequest` SPA host** (`star.ts:145`) — *synchronous*, CSP-locked, serves HTML/assets — existing.
3. **App-server facet** — *async*, reads secrets, makes egress calls, runs the agent's `onRequest`/`onSchedule` — **new.** Routing dispatches: `/` + assets → context 2; `/_hooks/*` (or `/api/*`) → context 3.

## Sharp edges (carry into `/review-task`)

- **SSRF relocates, it doesn't vanish.** Outbound from untrusted *generated* code is the cannon; the mitigation is D2's no-ambient-`fetch` + `globalOutbound` choke point. Skip it and the locked-down server is reopened.
- **The agent now writes privileged *server* code,** not just UI. Blast radius is bounded by the capability-scoped facet `env` (the DO scope-isolation work already shipped).
- **Reentrancy / input gate (the riskiest unknown).** A facet `env.data` callback reenters the parent Star while it may be mid-mutation; ADR-005 soundness depends on the synchronous-mutator + single-threaded invariant. Confirm callbacks land as separate DO events and characterize whether an in-flight facet `fetch` holds the input gate / keeps the DO billed-active. *If it bites, it reshapes the facet boundary — resolve early.*
- **ADR-003 is fine.** The facet↔DO `env` callback is local capability transport within one DO — not a mesh hop; one-way-messages-and-continuations isn't in play.
- **B6 isn't free.** `fetch` alone is best-effort; guaranteed-delivery email/payment-confirm wants the durable outbox (ties to [`on-hold/mesh-call-durable.md`](on-hold/mesh-call-durable.md)).

## Proven mechanisms (spikes — all green + mutation-checked 2026-06-17)

- [`archive/spike-outside-world-secrets.md`](archive/spike-outside-world-secrets.md) — AES-256-GCM two-level vault + 3-mode resolver (`apps/nebula/test/spike-secrets-vault/`); facet env-injection + isolation (`apps/nebula/test/test-apps/secrets-facet/`).
- [`archive/spike-outside-world-outbound.md`](archive/spike-outside-world-outbound.md) — egress choke via `globalOutbound`→`EgressBroker` (`apps/nebula/test/test-apps/egress-choke/`): a bare `fetch()` routed through it with no bypass; allow-list + SSRF deny + null-=-no-network all confirmed.
- *(to write)* `spike-outside-world-inbound.md` — public URL → facet `onRequest`; routing-config dispatch; `verifyWebhook`; input-gate behavior under a slow handler. **Prerequisite for Phase 4 only.**

## Demand-priority ordering (Larry 2026-06-23) — distinct from the phase order

User-facing value lands roughly **`fetch` → email → search → secrets (last)**. This is *capability* priority, not *phase* order: the phases have hard dependencies (the facet keystone + egress broker underpin all of fetch/email/search), and the secrets **vault infra** (Phase 1) is a dependency of secret-at-edge injection even though the user-facing **bring-your-own-key** capability is the lowest priority. **`search` is an egress recipe** — call a search API through the broker, key in the vault; shares substrate with the engine's `web_search` tool. At `/review-task`, weigh re-sequencing the phases toward this demand order (e.g. a minimal `fetch`-to-allow-listed-public-URL slice before the full vault UX).

## Prerequisites (before "go")

- [ ] `/review-task` panel — and the **Open forks** below resolved.
- [ ] In-flight Studio/branch work (compile-pipeline / app-versioning / self-hosted-assets) settled — several phases touch `star.ts`.
- [ ] Inbound spike written + green (gates Phase 4 only; Phases 1–3 don't need it).
- [ ] Confirm the **reentrancy / input-gate** answer early (see Phase 2 / Sharp edges) — it may constrain the facet design.

## Implementation Phases

Ordered by readiness (1–3 are spike-proven; 4–5 need their own gates). Each is independently shippable. On promotion, productionized code moves from `apps/nebula/test/` to `src/` with integration tests in the `baseline` test-app (the spike projects can then be retired).

### Phase 1 — Two-level secrets vault → real Galaxy + Star
**Goal**: Promote the vault from `test/` to `src/`; store per-tenant secrets encrypted at rest in the tenant's own DO; resolve across levels per the Galaxy-governed mode.
**Promotes**: `apps/nebula/test/spike-secrets-vault/vault.ts` → `apps/nebula/src/`.
**Success criteria**:
- [ ] `@mesh(requireAdmin)` `setGalaxySecret` / `setStarSecret` seal into KV (dedicated keys — never readable via `getGalaxyConfig`); mode set per-secret-name in Galaxy config by the Galaxy admin.
- [ ] Star-side `resolveSecret(name)` honors all 3 modes (mesh call to Galaxy for the galaxy level; Star decrypts; both share the master key).
- [ ] Master key from the `NEBULA_SECRETS_KEY` Workers Secret (root `.dev.vars` + miniflare bindings for tests; `wrangler secret put` for prod) — never committed.
- [ ] A non-admin cannot set or read a secret; cross-tenant resolution is impossible (rides DO scope isolation).
- [ ] **No-leak**: the secret never appears in a Resource read or the `Star.onRequest` SPA body (the Stage-3 assertion the spike deferred).

### Phase 2 — App-server facet runtime (the keystone)
**Goal**: The Star loads the agent's server code as a facet and hands it a capability `env`. Everything downstream rides this.
**Promotes**: the facet-load + env-injection pattern from `apps/nebula/test/test-apps/secrets-facet/` (and `packages/ts-runtime-parser-validator/src/facet-helper.ts`).
**Success criteria**:
- [ ] Star loads the facet with custom `env`: `env.data` (reuse the Studio engine's mesh/full-type bridge), `env.secrets.resolve` (Phase 1), `globalOutbound` = the `EgressBroker` (Phase 3).
- [ ] The facet has **no ambient** `fetch`, no master key, no parent bindings beyond what's injected (the spike's isolation property, now on the real Star).
- [ ] **Reentrancy / input-gate characterized** (see Sharp edges) — document whether callbacks land as separate DO events and whether in-flight facet I/O holds the input gate / keeps the Star billed-active. *The riskiest unknown — if it bites, it reshapes the facet boundary.*

### Phase 3 — Egress broker (`EgressBroker` as `globalOutbound`)
**Goal**: All facet outbound funnels through a Nebula-controlled choke point.
**Promotes**: `apps/nebula/test/test-apps/egress-choke/` (the `EgressBroker` WorkerEntrypoint + self-ref service binding).
**Success criteria**:
- [ ] `EgressBroker` wired as the facet's `globalOutbound`; a bare `fetch()` in agent code is routed through it (no bypass).
- [ ] **Per-tenant** allow-list (from connector config / the vault), not a static global one; default-deny + internal/metadata SSRF deny.
- [ ] Allowed path does the **real** `fetch` (the spike stubbed it); response streamed back; non-GET methods + headers pass through.
- [ ] **Metering hook** — per-tenant egress counted (ties to [`on-hold/nebula-tenant-ai-billing.md`](on-hold/nebula-tenant-ai-billing.md)).
- [ ] **Secret-at-edge injection** for blessed connectors — the broker adds the `Authorization` header so generated code never sees the credential (depends on Phase 1).

### Phase 4 — Ingress router (GATED on the inbound spike)
**Goal**: A stable public URL delivers inbound HTTP (webhooks, inbound email, OAuth callbacks) to the tenant's app-server facet as an `onRequest`.
**Success criteria**:
- [ ] Public scheme (e.g. `/{u}.{g}/_hooks/{name}`) routes to the **async** facet `onRequest` — distinct from the **synchronous** CSP-locked `Star.onRequest` SPA host (the routing config dispatches; don't conflate).
- [ ] Rate-limit / flood-protect before invoking the facet (cost guard).
- [ ] `verifyWebhook(provider, req, secret)` (Phase 6) is the blessed path; idempotency rides ADR-005 eTags.

### Phase 5 — Scheduler (alarms; no spike needed)
**Goal**: Per-tenant scheduled work (`onSchedule`) for cron-class needs (daily pulls, reminders).
**Success criteria**:
- [ ] A `scheduled-job` resource on the Star; `this.svc.alarms.schedule(...)` fires an `onSchedule` facet entry through the same `env`.
- [ ] Timezone handling + missed-alarm/retry policy defined.

### Phase 6 — Security stdlib
**Goal**: Verified helpers for the security-sensitive 5%, so agents write glue without foot-guns.
**Success criteria**:
- [ ] `verifyWebhook(provider, req, secret)` — constant-time, replay-windowed.
- [ ] `durableFetch` / outbox — guaranteed delivery (Queues or alarm-driven retry) + ADR-005 idempotency, so a transient provider 500 or closed tab doesn't drop a send (B6). See [`on-hold/mesh-call-durable.md`](on-hold/mesh-call-durable.md).

### Phase 7 — Studio-agent docs
**Goal**: Agent-facing reference so the Studio LLM knows how to use the substrate. **Audience is the hosted LLM, not a human** (`feedback_nebula_docs_audience_is_llm`): establish patterns once, skip footgun warnings. Consider drafting the **API surface first** (docs-first) to pin the agent's view before implementation — the agent only ever sees `onRequest`/`onSchedule`, `env.secrets.resolve(name)`, idiomatic `fetch` (and that hosts are allow-listed), and the route/schedule config — never the facet/`globalOutbound` mechanism.
**Promotes to**: `website/docs/nebula/` (`.md`).
**Success criteria**:
- [ ] Pages for: server handlers (`onRequest`/`onSchedule`), secrets use, outbound `fetch` (allow-list behavior), route/schedule config, and at least one end-to-end **recipe** (email via Resend, both directions).
- [ ] `@check-example`-validated where code blocks appear.

### Phase 8 (optional capstone) — Email recipe end-to-end
**Goal**: Prove the whole stack with the lead use case — agent wires Resend outbound (REST) + inbound (forward webhook → `onRequest`), tenant's own account/domain.

## Open forks (resolve in `/review-task`)

- **Generated-app email path** — Nebula-mediated `this.svc.email` (Nebula's account) vs the **tenant's-own-account-via-`EgressBroker`** recipe (B4 reputation isolation), or **both** (platform/framework email via `this.svc.email`, generated-app email via the tenant recipe). Either way, `@lumenize/email`'s provider-agnostic transports ([`archive/lumenize-email.md`](archive/lumenize-email.md)) are the building block, and this project is the first real consumer of the deferred mesh `this.svc.email` capability.
- **Outbound email provider** (Resend / Postmark / SES) + **shared `nebula.app` domain vs per-tenant custom domains** (deliverability isolation). The facet model defaults to per-tenant accounts, sidestepping most of this.
- **Connector altitude** — a curated blessed-connector catalog (vetted helpers for Stripe/Slack/Resend) vs fully generic "describe any REST API + key." Lean: generic substrate + a small set of blessed recipes/helpers for the high-risk cases.
- **Per-tenant key derivation** (HKDF keyed by scope) — v1 or hardening follow-up. Limits blast radius if the master key + one ciphertext leak.
- **Physical placement** — which pieces live on Star vs Galaxy (vault levels, facet host, scheduler).
- **Durable outbox mechanism** — Cloudflare Queues vs alarm-driven retry.

## Notes

- The genuinely new primitives are few — secrets vault, ingress router, scheduler, egress choke point. Every higher need is "compose two": payments = ingress + egress; Slack bot = ingress + egress; polling = scheduler + egress; OAuth-on-behalf-of-user = ingress (callback) + secrets (token store) + egress (refresh).
- **Search recipe** (demand-priority before secrets): "let my app search the web" = call a search API (SerpApi/Brave/Google, like vibesdk's `web-search.ts`) **through the `EgressBroker`** (allow-list the provider host) with the key **from the vault** (likely `galaxy-only` = platform pays, per-tenant metering → [`on-hold/nebula-tenant-ai-billing.md`](on-hold/nebula-tenant-ai-billing.md)); format results to markdown. **Shares substrate with the engine's own `web_search` tool** — the difference is consumer (generated app vs the codegen loop), not mechanism. The high-risk "LLM/app picks a URL" SSRF case is `fetch_url`, not a fixed-provider search.
- Secrets vault encryption key is a **Workers Secret** (root `.dev.vars`, auto-symlinked; miniflare `bindings` for tests) — never committed, never in `wrangler.jsonc`.
- **Type-check debt (2026-06-17):** the spike test-apps fail the repo-wide `npm run type-check` (excluded from `npm test`, NOT from the type-check) — `test/spike-secrets-vault/vault.ts` (`Uint8Array` → `BufferSource`, ×2) and `test/test-apps/{secrets-facet,egress-choke}/index.ts` (`Env` → `Record<string, unknown>` cast). Fix on promotion (route the cast through `unknown`; hand WebCrypto a concrete `ArrayBuffer`-backed view), or sooner if a green repo type-check is needed.
