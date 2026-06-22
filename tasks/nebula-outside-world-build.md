# Nebula Outside-World — Productionization Plan

**Status**: Design — phased build plan. **NOT started. Do NOT build yet.** Gated on (a) the in-flight Studio/branch work settling, and (b) a `/review-task` pass (the open forks below must close first).

**Design & decisions**: `tasks/nebula-outside-world.md` (umbrella — B1–B6 blockers, D1 secrets, D2 facet+`globalOutbound`).
**Proven mechanisms** (spikes, all green + mutation-checked, 2026-06-17):
- `tasks/archive/spike-outside-world-secrets.md` — AES-256-GCM vault + 3-mode resolver (`apps/nebula/test/spike-secrets-vault/`); facet env-injection + isolation (`apps/nebula/test/test-apps/secrets-facet/`).
- `tasks/archive/spike-outside-world-outbound.md` — egress choke point via `globalOutbound`→`EgressBroker` (`apps/nebula/test/test-apps/egress-choke/`).
- *(to write)* `tasks/spike-outside-world-inbound.md` — prerequisite for Phase 4.

## Objective

Promote the proven substrate into real Nebula platform code so the Studio agent can write server-side app logic (`onRequest`/`onSchedule` handlers, outbound `fetch`, secret use) that is secure by default. Build the **substrate**; integrations (email, payments, …) stay agent-written recipes.

## Prerequisites (before "go")

- [ ] `/review-task` panel — and the **Open forks** below resolved.
- [ ] The user's in-flight branch work (Studio compile-pipeline / app-versioning / self-hosted-assets) settled — several phases touch `star.ts`.
- [ ] Inbound spike written + green (gates Phase 4 only; Phases 1–3 don't need it).
- [ ] Confirm the **reentrancy / input-gate** answer (see Phase 2) — it may constrain the facet design, so resolve it early.

## Implementation Phases

Ordered by readiness (1–3 are spike-proven; 4–5 need their own gates). Each is independently shippable.

### Phase 1 — Two-level secrets vault → real Galaxy + Star
**Goal**: Promote the vault from `test/` to `src/`; store per-tenant secrets encrypted at rest in the tenant's own DO; resolve across levels per the Galaxy-governed mode.

**Promotes**: `apps/nebula/test/spike-secrets-vault/vault.ts` → `apps/nebula/src/`.

**Success criteria**:
- [ ] `@mesh(requireAdmin)` `setGalaxySecret` / `setStarSecret` seal into KV (dedicated keys — never readable via `getGalaxyConfig`); mode set per-secret-name in Galaxy config by the Galaxy admin.
- [ ] Star-side `resolveSecret(name)` honors all 3 modes, doing a mesh call to Galaxy for the galaxy level (Star decrypts; both share the master key).
- [ ] Master key from the `NEBULA_SECRETS_KEY` Workers Secret (root `.dev.vars` + miniflare bindings for tests; `wrangler secret put` for prod) — never committed.
- [ ] A non-admin cannot set or read a secret; cross-tenant resolution is impossible (rides DO scope isolation).
- [ ] **No-leak**: the secret never appears in a Resource read or the `Star.onRequest` SPA body (the Stage-3 assertion the spike deferred).

### Phase 2 — App-server facet runtime (the keystone)
**Goal**: The Star loads the agent's server code as a facet and hands it a capability `env`. Everything downstream rides this.

**Promotes**: the facet-load + env-injection pattern from `apps/nebula/test/test-apps/secrets-facet/` (and `packages/ts-runtime-parser-validator/src/facet-helper.ts`).

**Success criteria**:
- [ ] Star loads the app-server facet with a custom `env`: `env.data` (the mesh/full-type bridge — reuse the Studio engine's), `env.secrets.resolve` (Phase 1), and `globalOutbound` = the `EgressBroker` (Phase 3).
- [ ] The facet has **no ambient** `fetch`, no master key, no parent bindings beyond what's injected (the spike's isolation property, now on the real Star).
- [ ] **Reentrancy / input-gate characterized**: a facet `env.data` callback + the broker's async `fetch` must not violate the synchronous-mutator + single-threaded invariant ADR-005 depends on. Document whether callbacks land as separate DO events and whether in-flight facet I/O holds the input gate / keeps the Star billed-active. *This is the riskiest unknown — if it bites, it reshapes the facet boundary.*

### Phase 3 — Egress broker (`EgressBroker` as `globalOutbound`)
**Goal**: All facet outbound funnels through a Nebula-controlled choke point.

**Promotes**: `apps/nebula/test/test-apps/egress-choke/` (the `EgressBroker` WorkerEntrypoint + self-ref service binding).

**Success criteria**:
- [ ] `EgressBroker` wired as the facet's `globalOutbound`; a bare `fetch()` in agent code is routed through it (no bypass).
- [ ] **Per-tenant** allow-list (from connector config / the vault), not a static global one; default-deny + internal/metadata SSRF deny.
- [ ] Allowed path does the **real** `fetch` (the spike stubbed it); response streamed back; non-GET methods + headers pass through.
- [ ] **Metering hook** — per-tenant egress counted (ties to `tasks/nebula-tenant-ai-billing.md`).
- [ ] **Secret-at-edge injection (option c)** for blessed connectors — the broker adds the `Authorization` header so generated code never sees the credential (depends on Phase 1).

### Phase 4 — Ingress router (GATED on the inbound spike)
**Goal**: A stable public URL delivers inbound HTTP (webhooks, inbound email, OAuth callbacks) to the tenant's app-server facet as an `onRequest`.

**Success criteria**:
- [ ] Public scheme (e.g. `/{u}.{g}/_hooks/{name}`) routes to the **async** app-server facet `onRequest` — distinct from the **synchronous** CSP-locked `Star.onRequest` SPA host (don't conflate; the routing config dispatches).
- [ ] Rate-limit / flood-protect before invoking the facet (cost guard).
- [ ] A `verifyWebhook(provider, req, secret)` stdlib helper (Phase 6) is the blessed path; idempotency rides ADR-005 eTags.

### Phase 5 — Scheduler (alarms; no spike needed)
**Goal**: Per-tenant scheduled work (`onSchedule`) for cron-class needs (daily pulls, reminders).

**Success criteria**:
- [ ] A `scheduled-job` resource on the Star; `this.svc.alarms.schedule(...)` fires an `onSchedule` facet entry through the same `env`.
- [ ] Timezone handling + missed-alarm/retry policy defined.

### Phase 6 — Security stdlib
**Goal**: Verified helpers for the security-sensitive 5%, so agents write glue without foot-guns.

**Success criteria**:
- [ ] `verifyWebhook(provider, req, secret)` — constant-time, replay-windowed.
- [ ] `durableFetch` / outbox — guaranteed delivery (Queues or alarm-driven retry) + ADR-005 idempotency, so a transient provider 500 or closed tab doesn't drop a send (B6).

### Phase 7 — Studio-agent docs
**Goal**: Agent-facing reference so the Studio LLM knows how to use the substrate. **Audience is the hosted LLM, not a human** (`feedback_nebula_docs_audience_is_llm`): establish patterns once, skip footgun warnings.

**Promotes to**: `website/docs/nebula/` (`.md`). Consider drafting the **API surface first** (docs-first) to pin the agent's view before implementation — the agent only ever sees `onRequest`/`onSchedule`, `env.secrets.resolve(name)`, idiomatic `fetch` (and that hosts are allow-listed), and the route/schedule config — never the facet/`globalOutbound` mechanism.

**Success criteria**:
- [ ] Pages for: server handlers (`onRequest`/`onSchedule`), secrets use, outbound `fetch` (allow-list behavior), route/schedule config, and at least one end-to-end **recipe** (email via Resend, both directions).
- [ ] `@check-example`-validated where code blocks appear.

### Phase 8 (optional capstone) — Email recipe end-to-end
**Goal**: Prove the whole stack with the lead use case — agent wires Resend outbound (REST) + inbound (forward webhook → `onRequest`), tenant's own account/domain.

## Open forks (resolve in `/review-task`)
- **Outbound email provider** (Resend / Postmark / SES) + **shared `nebula.app` domain vs per-tenant custom domains** (deliverability isolation). The facet model defaults to per-tenant accounts, sidestepping most of this.
- **Connector altitude** — curated blessed-connector catalog (vetted helpers) vs fully generic "any REST API + key". Lean: generic substrate + a few blessed recipes/helpers for the high-risk cases.
- **Per-tenant key derivation** (HKDF keyed by scope) — v1 or follow-up. Limits blast radius if the master key + one ciphertext leak.
- **Physical placement** — which pieces live on Star vs Galaxy (vault levels, facet host, scheduler).
- **Durable outbox mechanism** — Cloudflare Queues vs alarm-driven retry.

## Notes
- The spikes are tracked under `apps/nebula/test/` with 2 dedicated vitest projects (`secrets-facet`, `egress-choke`) **excluded from `npm test`**. On promotion, the productionized code moves to `src/` with integration tests in the `baseline` test-app (and the spike projects can be retired).
- **Type-check debt (noted 2026-06-17):** the spike test-apps fail the repo-wide `npm run type-check` (they're excluded from `npm test` but NOT from the type-check) — `test/spike-secrets-vault/vault.ts` (`Uint8Array` → `BufferSource`: the `SharedArrayBuffer`-vs-`ArrayBuffer` lib mismatch, ×2) and `test/test-apps/{secrets-facet,egress-choke}/index.ts` (`Env` → `Record<string, unknown>` cast). Fix on promotion, or sooner if a green repo type-check is needed: route the cast through `unknown` (`as unknown as Record<…>`) and hand WebCrypto a concrete `ArrayBuffer`-backed view.
- This is substrate; **email/payments/Slack are agent recipes**, not Nebula-owned code (the whole point of the substrate-not-primitives thesis).
