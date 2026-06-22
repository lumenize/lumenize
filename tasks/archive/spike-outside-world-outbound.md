# Spike: Outside-World Outbound / Egress Choke Point

> 🗄️ **Archived 2026-06-22.** Spike complete (✅ 2026-06-17); result (`globalOutbound` → `EgressBroker`) folded into `nebula-outside-world.md` + `nebula-outside-world-build.md`. Frozen — do not update.

**Status**: Active — exploratory; the second-built of three substrate spikes for `tasks/nebula-outside-world.md`. Not for hand-review. ✅ DONE 2026-06-17.

**Context**: Nebula apps make outbound calls (Resend, Stripe, any REST API) from agent-written server code running in a **DO facet**. The central risk is that outbound `fetch` from *untrusted generated code* is an SSRF cannon (cloud metadata, internal services, cross-tenant). This spike answers the umbrella's single most important open question — **what network authority does a facet have by default, and can a bare `fetch()` bypass a Nebula-controlled egress path?** — and proves the choke point.

## Goal

1. Confirm a facet can reach a CORS-hostile API a browser can't (B5 — the CORS win).
2. Prove **all** facet outbound — including a bare `fetch()` — can be funneled through a Nebula-controlled choke point with **no bypass**.
3. Prove the choke point enforces an allow-list + denies internal/metadata ranges (the SSRF guard).
4. Characterize the facet's default network authority.

## Result — `globalOutbound` is the mechanism

The Worker Loader config takes `globalOutbound?: (Fetcher | null)` (confirmed in the generated `WorkerLoaderWorkerCode` type). Three states, all confirmed under vitest-pool-workers:

| `globalOutbound` | Facet's `fetch()` reaches |
|---|---|
| omitted | the open internet (unrestricted — the default; dangerous for generated code) |
| `null` | nothing — `fetch()` errors (no ambient network) |
| a `Fetcher` (our `EgressBroker`) | **only** that Fetcher — every subrequest, including a bare `fetch()`, is routed through it |

**The key finding:** wiring a Nebula `EgressBroker` (a `WorkerEntrypoint`) as the facet's `globalOutbound` makes a **bare `fetch()` in agent code transparently the controlled path** — there is no separate `env.fetch` capability the agent must opt into, and **no way to bypass it** (the facet has no other network). Even a `fetch('http://169.254.169.254/...')` is delivered to the broker (workerd does not pre-block it), so the broker is the single enforcement point. This is cleaner than the umbrella's original option-(a)/(b) framing: the agent writes idiomatic `fetch`, and it is structurally choked.

## Code

`apps/nebula/test/test-apps/egress-choke/` (own wrangler: `LOADER` + `EgressProbeDO` + a self-ref `EGRESS` service binding → the `EgressBroker` WorkerEntrypoint; new `egress-choke` vitest project). Hermetic — the broker returns synthetic markers (`egress-allowed:<host>`) so the spike needs no real external network; the marker can only have come from the broker, which is what proves interception.

## Success criteria

- [x] A bare `fetch()` to an allow-listed host is routed through the broker (returns the broker's marker, not the real site).
- [x] An internal/metadata address (`169.254.169.254`) is denied by the SSRF branch specifically (`egress-denied:internal`) — proves it reached the broker and was caught there, not pre-blocked.
- [x] A non-allow-listed public host is denied (default-deny).
- [x] `globalOutbound: null` leaves the facet with no network (`fetch()` errors).
- [x] Each guard independently mutation-checked: disabling `isInternal` flips only the SSRF test; bypassing the allow-list flips only the default-deny test; forcing `globalOutbound: null` flips all three broker-routed tests. 4 tests green, stable across 3 runs.

## What this resolves for the design

- **Egress choke point = `globalOutbound` → EgressBroker.** Not an injected `env.fetch`. Updates umbrella D2.
- **The broker is the egress execution point.** In production its *allowed* path does the real `fetch` (the spike stubs it), so the actual outbound is billed to a Nebula Worker, the facet stays isolated, and **the CORS win is definitional** (server-side fetch, no CORS).
- **The broker is also where the rest of the egress policy lives**: per-tenant allow-lists, metering (the billing hook), and **secret-at-edge injection (umbrella option c)** — add the `Authorization` header for blessed connectors so generated code never sees the credential at all.

## Open questions (deferred)

- **Per-tenant allow-list + credential injection** — the spike uses a static global allow-list and synthetic responses. Real version keys the allow-list/credentials by tenant (ties to Spike A's secrets vault + `nebula-tenant-ai-billing.md` for metering).
- **Reentrancy / wall-clock** — the broker's real `fetch` is async; characterize whether it holds the parent DO's input gate / billing while in flight (shared with the secrets Stage 3 reentrancy question).
- **Streaming / large bodies, non-GET methods, headers passthrough** — the spike only does GET with a marker body.

## Dependencies / sequencing

Independent of the inbound spike. Shares the facet-loading mechanism with Spike A (secrets). The credential-injection variant depends on Spike A Stage 3 (real vault).
