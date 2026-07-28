# A standards-conformant MCP server: Streamable-HTTP + `subscriptions/listen`

**Status:** On hold (2026-07-28). Proof-of-principle to regain **MCP Transport working-group standing** — the WG abandoned WebSockets, so a conformant `subscriptions/listen` implementation is the re-entry currency. Pinned business decision: **ship to production but discourage adoption via true-cost pricing** (~$4/mo per continuously-connected gateway); efficiency is an explicit non-goal. Not on the pre-alpha critical path.

**Objective — let any unmodified standard MCP client read and `subscriptions/listen` to a Lumenize/Nebula resource over the ratified MCP Streamable-HTTP transport (POST + SSE), receiving `notifications/resources/updated`, by teaching the Gateway to terminate MCP HTTP alongside its existing WebSocket role.**

## Context and current state

**Built already:**
- **The Gateway** — `LumenizeClientGateway`, a zero-storage hibernatable-WS bridge and trust boundary, 1:1 per client, whose `fetch()` today accepts *only* WebSocket upgrades (non-WS gets `426`). It rebuilds `callContext` from the **verified** connection identity, discarding client-supplied fields. Subclassable via `onBeforeAccept` / `onBeforeCallToMesh` / `onBeforeCallToClient` — `NebulaClientGateway` proves the pattern with zero raw-DO code.
- **The subscription substrate** — Nebula's `Star.subscribe(...)` (`@mesh()`, returns `void`), the `Subscribers` SQL registry (stores the confined authz verdict for per-push re-authorization), `svc.broadcast` fanout, and the client-side `handleResourceUpdate(rt, rid, Snapshot)` push handler. Recovery is **client re-subscribe** on reconnect, driven by the Gateway's `subscriptionRequired` signal.
- **The result/push transport** — a client-originated call's result already **fires back to the Gateway** (`__handleResponse`) via `call` continuation, and the mesh→client push path (`__executeOperation` → `incoming_call`) already exists. The Gateway is a stateless relay of both.
- **Prior art** — a full MCP-over-WebSocket JSON-RPC server in `lumenize-monolith/` (`lumenize-server.ts` dispatch incl. `initialize`/`resources/read`; `notification-service.ts` emitting `notifications/resources/updated`; `entity-uri-router.ts` partial RFC-6570; `entity-subscriptions.ts`). Legacy, **not precedent**, but a working reference for the JSON-RPC half.

**Missing:**
1. An HTTP branch in the Gateway's `fetch()` terminating MCP Streamable-HTTP: JSON-RPC `POST` → JSON response; `subscriptions/listen` `POST` → a held-open SSE stream (`text/event-stream`), first frame `notifications/subscriptions/acknowledged`. (The 2026 stateless revision removed the GET endpoint — all POST.)
2. A JSON-RPC ↔ mesh translation core: MCP `method`/`params` encoded as an OCAN chain against `Star`; request `id` ↔ `callId`; `resources/read` → Star read; `subscriptions/listen` `resourceSubscriptions:[uri…]` → one `Star.subscribe` per URI.
3. Rendering of `Snapshot` pushes as `notifications/resources/updated` JSON-RPC onto the held SSE stream — the Gateway branches on connection protocol at its push/`__handleResponse` door.
4. A URI scheme mapping MCP resource URIs ↔ `(resourceType, resourceId)` on a Star.
5. MCP-client → Gateway-instance addressing (an MCP client has no `{sub}.{tabId}`).
6. An auth bridge: `Authorization: Bearer` / OAuth (or the 2026 per-request `_meta`) ↔ the Gateway's verified identity.
7. A JSON projection at the MCP boundary (MCP is JSON-only; Lumenize round-trips full structured-clone).
8. A metering hook for connected-gateway time (the pricing basis).

## Design intent, constraints, and future state

This is a **standards-conformance proof, not a product feature.** Its entire value is that an *unmodified* standard MCP client — the `@modelcontextprotocol/sdk` — can `subscriptions/listen` against a Lumenize resource and receive `notifications/resources/updated`. Every choice optimizes for **"a stock client works, unmodified"** over efficiency or adoption.

Load-bearing claims (each falsifiable, so review can check them):

- **The ratified transport is the only one that earns WG credit.** MCP Streamable-HTTP (POST + SSE) is what a stock client speaks and what the WG recognizes; a WebSocket binding earns nothing here. So the transport is HTTP/SSE, terminated at the Gateway.
- **`subscriptions/listen`'s semantics already exist in the substrate** — long-lived opt-in channel, per-URI subscription, server-push-on-change, recovery-by-client-re-subscribe are all present in Star's subscribe/broadcast plus the Gateway's `subscriptionRequired` signal. This task adds a **protocol skin**, not a subscription system. The invariant it leans on: **the subscription registry and fanout are owned by `Star`; the Gateway only relays the push.**
- **The Gateway holds the SSE stream and is therefore resident for the connection's life.** SSE has no hibernation; the DO is resident-while-connected and **evicts** (does not hibernate) when the connection drops — the connection does not survive eviction. This is the cost, accepted rather than engineered away.
- **Cost is a ceiling proportional to connected time.** ~$4/mo per gateway is one continuously-open subscription for a month; realized cost tracks actual connected hours. The ceiling is reached only by continuously-connected hosts (server-side agents, pooled connectors); a sleep-capable holder drops the connection and stops the meter. True-cost pricing is the deliberate discouragement, and it self-targets the always-on consumers that actually pin the DO.

Invariants the phases must honor:

- **Authority stays where it is.** The Gateway remains the trust boundary — identity from the verified connection, never client-supplied — and every resource operation is authorized by `Star`'s existing per-operation guards. The MCP edge adds a protocol, not an authority path.
- **No held reply channel across a hop.** Gateway↔Star hops use `call` continuation fire-back; the Gateway awaits only the early-ack, never a result. An SSE-holding DO must not *also* hold a Promise across the Star hop.
- **The MCP edge projects to JSON; the interior stays structured-clone.** The JSON projection is confined to the external MCP boundary — no internal Lumenize surface degrades to JSON.
- **Addressing resolves off the real substrate** — the URI scheme and session addressing map onto `Star`'s `(resourceType, resourceId)` and the verified identity; the never-built generic mesh `ResourcesHost` / `lmz.resources()` framework is not a dependency.

**Constraints (cite, do not restate):** ADR-002 (structured-clone round-trip — the MCP edge is the documented external projection, the interior is unaffected), ADR-003 (continuation-only — `call`, not `callAsync`), ADR-007 (shared comms/guards core; a node-owned non-mesh HTTP surface is the last-resort exception and earns its own security review — that review is a phase here; the Gateway hand-building envelopes is the already-sanctioned raw exception), ADR-009 (real-path grounding — conformance is tested against the real `@modelcontextprotocol/sdk`, never a hand-rolled client), ADR-010 (resource URIs carry opaque keys, not natural/mutable attributes). Rules: `raw-comm.md` (the Gateway's `fetch()` routing + hibernation-WS), `security.md` (the new HTTP surface's trust boundary), `mesh.md` (the Gateway is not a mesh participant).

**Open questions (must be decided; each gates a phase):**
1. **MCP-client → Gateway-instance addressing.** A stock client has no `{sub}.{tabId}`; the instance must derive from the verified auth identity and/or an MCP session handle. The chosen scheme gates the routing phase.
2. **Auth bridge shape.** The 2026 spec is stateless-first (per-request `_meta`, optional OAuth resource-server); which of Bearer / OAuth / per-request `_meta` we accept gates the auth phase.

**Future state:**
- Makes possible a conformant MCP resource server any standard client or agent can consume.
- ⚠️ Design consideration: factor the JSON-RPC translation (URI scheme, method→chain, `Snapshot`→resource-contents) so it does **not** bind to the SSE carrier — a future carrier, if the WG ever ratifies one, grafts onto the same core.
- ⚠️ Design consideration: MCP `tools` and MRTR (elicitation/sampling) are out of scope, but the request-dispatch shape should not foreclose them — they are the same `call`-fire-back pattern with a different method map.
- ⚠️ Design consideration: pin the implemented MCP spec revision in this file, so a spec bump is a visible diff rather than silent drift.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| Transport is MCP Streamable-HTTP (POST + SSE) | MCP-over-WebSocket — the WG abandoned WS, so it earns no standing and stock clients don't speak it; Streamable-HTTP is the only ratified transport |
| Terminate MCP HTTP at the Gateway (`MCPClientGateway extends LumenizeClientGateway`) | A separate Worker route or new DO — the Gateway is already the 1:1 per-client trust boundary and the node Star's fanout pushes to; a separate surface duplicates the boundary and re-implements the push relay |
| Gateway↔Star hops use `call` continuation fire-back | `callAsync` — the Gateway is a DO; awaiting a result across the hop strands a Promise on eviction (ADR-003), and `callAsync` is a client-only affordance anyway |
| Map onto the real `Star` resource system | The generic mesh `ResourcesHost`/`lmz.resources()` framework — never built; depending on it blocks this behind a separate large build |
| JSON projection confined to the MCP edge | A JSON-only interior path — violates ADR-002; the projection is external-protocol-only |
| Ship to prod, meter + price at true cost (~$4/mo ceiling) | (a) Stay iceboxed — forfeits the WG standing that is the whole point; (b) subsidize the cost — invites adoption of a deliberately-inefficient path |
| Efficiency is a non-goal; SSE residency accepted | Engineer hibernation for SSE — impossible on Workers today; chasing it was the original icebox blocker and would defer the proof indefinitely |
| Conformance tested against the real `@modelcontextprotocol/sdk` | A hand-rolled MCP client — ADR-009; a hand-rolled client encodes our assumptions, not the spec's, and conformance is the deliverable |
| Delete `mesh-resources.md` outright | Keep a deferred generic-framework stub — the framework lost to Nebula's implementation; git history preserves it |

## Phases

1. **MCP HTTP ingress: terminate, authenticate, address.** The Gateway's `fetch()` gains an MCP branch that accepts an authenticated Streamable-HTTP `POST`, resolves it to a Gateway instance derived from the *verified* identity, and answers discovery so a stock client learns `resources.subscribe` is supported. Resolves both open questions.
   - **Success criteria (capable of failing):**
     - A `POST` bearing a valid credential is accepted and routed to an instance keyed by the verified identity; the same identity's second connection resolves to the *same* instance.
     - A `POST` with a missing/invalid credential is rejected at the boundary **and reaches no `Star` call and creates no instance state** (assert the absent downstream effect, not the HTTP status).
     - Discovery (`server/discover`/`initialize`) advertises the `resources.subscribe` capability.
   - **Mutation note:** leaving `fetch()` WS-only (today's `426`) reds the accept criterion; dropping the auth check lets an unauthenticated POST reach `Star`, reding the rejection criterion; omitting the capability reds discovery.

2. **Translation core + `resources/read`.** A carrier-independent layer maps MCP `{id, method, params}` ↔ an OCAN chain against `Star` (`id`↔`callId`), with a URI scheme resolving `(resourceType, resourceId)`; `resources/read` returns a real Star resource projected to MCP resource-contents. Hop uses `call` fire-back.
   - **Success criteria (capable of failing):**
     - `resources/read` of an existing resource whose value contains a Map + Date + cycle returns valid MCP JSON contents **and** the stored `Star` value stays structured-clone unchanged (both halves asserted).
     - `resources/read` of a missing resource returns the spec's not-found error (`-32602`; accept `-32002` for back-compat), never an empty contents array.
     - The Gateway holds **no** pending Promise across the Star hop — the result arrives through the fire-back door (asserted via an eviction-simulation between hop and result).
     - Every registered `(resourceType, resourceId)` round-trips through the URI parser/builder.
   - **Mutation note:** passing the structured-clone value through un-projected throws on the cycle; returning `[]` for missing reds not-found; switching the hop to an awaited call reds the eviction-simulation; dropping a URI segment reds the round-trip.

3. **`subscriptions/listen` + held SSE + update push.** A `subscriptions/listen` POST opens a held SSE stream (first frame `notifications/subscriptions/acknowledged`), fans one `Star.subscribe` per `resourceSubscriptions` URI, and renders each Star `handleResourceUpdate` push as a `notifications/resources/updated` frame on that stream. Grounded on the real SDK.
   - **Success criteria (capable of failing):**
     - A listen with N URIs writes N `Subscribers` rows across the target Star(s) and emits `notifications/subscriptions/acknowledged` as the first frame.
     - After a *different* client upserts a watched resource, the real-SDK listener receives a `notifications/resources/updated` frame for that URI, and a follow-up `resources/read` returns the new value.
     - The writer's own upsert is **not** echoed to its own subscription (BroadcastChannel semantics, matching the substrate).
     - After the SSE connection drops, a subsequent fanout attempt removes the subscriber rows via the existing drop-on-failed-fanout path (assert rows gone).
   - **Mutation note:** skipping the per-URI `Star.subscribe` fan reds the row/ack criterion; writing the rendered frame to the wrong socket (or not at all) reds the update criterion; echoing own writes reds BroadcastChannel; ignoring the abort leaves subscriber rows.

4. **Connected-time metering (pricing basis).** Resident-DO time while an MCP SSE stream is held is metered per verified identity, emitting the usage signal the billing lane consumes — no invoicing here.
   - **Success criteria (capable of failing):**
     - A held subscription accrues metered connected-time; closing the stream stops accrual (metered interval matches connected interval within tolerance).
     - Metered time is attributed to the caller's verified identity, not a shared bucket.
   - **Mutation note:** metering wall-clock regardless of connection state keeps accruing after disconnect; attributing to a constant collapses two identities' usage.

5. **ADR-007 security review of the new HTTP surface.** The node-owned MCP surface passes a dedicated review: trust boundary (identity from the verified credential only), authz (every op runs Star's guard), and the new attack surface (unauth POST, cross-identity addressing, SSE exhaustion).
   - **Success criteria (capable of failing):**
     - Inventory: every MCP method the dispatcher exposes resolves to a guarded `Star` operation; none reaches storage un-guarded.
     - A cross-identity probe: identity A cannot address or read identity B's gateway/resources via a forged session handle or URI.
     - A single identity cannot open unbounded concurrent SSE streams against one gateway (an enforced cap).
   - **Mutation note:** adding an ungated passthrough method reds the inventory; deriving the instance from a client-supplied field (not the verified identity) lets A reach B; removing the cap lets unbounded streams pin unbounded memory.

6. **End-to-end conformance against the real `@modelcontextprotocol/sdk`.** An unmodified SDK client completes discover → `resources/read` → `subscriptions/listen` → observes `notifications/resources/updated` → clean teardown, over Streamable-HTTP against a running Gateway.
   - **Success criteria (capable of failing):**
     - The unmodified SDK completes the full flow, asserted on the *SDK's* observed state (it received and parsed the update), not our internal logs.
     - The test pins the MCP spec revision it validates against, so a spec bump is a visible diff.
   - **Mutation note:** any nonconformance — wrong content-type, missing ack frame, wrong error code — makes the SDK reject; bumping the pinned revision without matching behavior reds conformance.

## Non-goals
- **MCP `tools` / tool-calling and MRTR (elicitation/sampling).** Deferred — home: the intent's design consideration that the dispatch shape (same `call`-fire-back, different method map) doesn't foreclose them.
- **Efficiency / SSE hibernation.** Dropped, not deferred — impossible on Workers today; accepting the residency cost is the premise.
- **A WebSocket (or other) MCP transport binding.** Dropped — the WG abandoned WS; the carrier-independent translation core keeps a future binding cheap (intent design consideration).
- **Reviving the generic mesh `ResourcesHost` framework.** Dropped — `mesh-resources.md` is deleted; git history is the only home.
- **The HTTP-REST resources transport.** Out of scope — home: `tasks/on-hold/http-transport.md` (the sibling; note it has *no* HTTP subscribe, which this task's SSE `subscriptions/listen` is the first to provide).
- **Invoicing / billing UI.** Deferred — home: `tasks/on-hold/nebula-tenant-ai-billing.md`; this task only emits the metering signal (Phase 4).
- **Generic / non-Nebula-Star MCP exposure.** Deferred — binds to `Star` today; generalize later only with a consumer (YAGNI gates capability, not generality).

## Relationships
- **Deletes** `tasks/icebox/mesh-resources.md` (unbuilt generic-framework design that lost to Nebula's implementation). Salvaged here: the lumenize-monolith prior-art pointers, the multi-transport "protocol skin dispatches to one handler" idea, and the `subscriptionRequired` re-subscribe recovery model. The rest is dropped; git history retains it.
- **Moves** `tasks/icebox/http-transport.md` → `tasks/on-hold/http-transport.md` — the sibling non-WS transport, kept as adjacent reference. Gap to note: that file's REST design has no HTTP subscribe; this task's SSE `subscriptions/listen` is the first HTTP-side subscribe.
- **References (does not duplicate)** `tasks/icebox/lmz-call-eviction-safe-by-default.md` — the framework-default form of the `call`-not-`callAsync` discipline applied manually here; MCP-as-systematic-consumer is one of that file's promote-out triggers.
- **Feeds** `tasks/on-hold/nebula-tenant-ai-billing.md` — Phase 4's metering signal is the connected-time input to that lane; no invoicing here.
- **Backlog:** repointed the stale `tasks/icebox/http-transport.md` path (row 51) in `tasks/nightly/backlog.md` to `tasks/on-hold/`; the backlog has no `mesh-resources` reference.
- **Prior art (read-only):** `lumenize-monolith/` MCP-over-WS server (`lumenize-server.ts`, `notification-service.ts`, `entity-uri-router.ts`, `entity-subscriptions.ts`) — legacy, not precedent.
- **Un-skip obligations owned in other lanes:** none.
