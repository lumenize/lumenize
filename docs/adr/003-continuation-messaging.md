# ADR-003: Continuation-Based Messaging — No Cross-Hop Request/Response

**Date**: 2026-06-11 (records a commitment in force since Mesh's design)
**Status**: Accepted
**Deciders**: Larry
**Evidence / history**: `.claude/rules/mesh.md` (day-to-day enforcement), `website/docs/mesh/calls.mdx` § Direct Delivery, `packages/mesh/src/lmz-api.ts` (`callRawImpl`), `tasks/on-hold/mesh-overload-backpressure-handling.md`

## Context

A distributed flow touches many nodes: client → Gateway → Star → Worker → back to some node. Coupled request/response across that path means every intermediate holds state — and an open RPC stub, which bills wall-clock time — until the deepest call unwinds; it fights DO hibernation and eviction; and it simply doesn't exist on the WebSocket legs, where every frame is a one-way message. Mesh had to pick one messaging model that works identically across all legs.

## Decision

**Mesh flows are one-way messages plus continuations; nothing in the architecture depends on request/response across hops.**

- A call names its *final* destination via a continuation (`lmz.ctn()`); multi-hop flows hand off forward (client → Star → Worker → client) and never unwind back through intermediates (direct delivery).
- Results are deliveries, not returns: the 4-arg `lmz.call` result handler, `svc.broadcast`'s `onResult`, and the client's `CALL_RESPONSE` message are all one-way deliveries to wherever the result is needed.
- `callContext` (identity, provenance, state) rides every hop automatically — that, not a held channel, is what makes flows composable.
- At the developer surface this is transparent: an awaited client call is sugar over send-plus-result-delivery, indistinguishable from two one-way calls. No user-developer code can observe, or couple to, a held cross-hop channel.
- No session or pipelining RPC (RpcTarget, Cap'n Web): cross-node calls are independent, self-contained envelopes.

### The per-hop transport exception

Within a single DO/Worker hop, the transport *is* an awaited Workers RPC: `callRawImpl` does `await stub.__executeOperation(envelope)` and that hop's result or error rides back in the RPC response. The await spans exactly one hop — never a path. We have considered converting even this to two one-way calls; since no user-developer code could tell the difference, that remains an open mechanism choice (it would mainly relocate error/overload classification — see the backpressure design), not a revision of this decision. The WS legs have no such exception — there is nothing to await.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| Coupled request/response across hops (nested awaited RPC) | Every intermediate stays resident holding open stubs (wall-clock billing) until the deepest call returns; results backtrack through nodes that don't need them; impossible on the WS legs anyway. |
| Promise-pipelined RPC sessions (RpcTarget, Cap'n Web) | Stateful sessions fight hibernation/eviction and have brittle stub lifecycles. Independent, self-contained calls survive all of that. |
| Two models — request/response between DOs, one-way over WS | Two mental models and two error paths for the same flow, with the seam exactly where Nebula lives (client ↔ Star). |

## Consequences

### Positive
- Direct delivery: results go straight to their consumer (the canonical spell-check reports to the client, not back through the document DO).
- DOs stay hibernation-friendly and avoid wall-clock billing across long flows; no node sits resident waiting on a deep call.
- One model everywhere — client code and DO code compose the same way, and awaiting is always available as sugar on top.
- Broadcast falls out of the same primitive: N one-way calls with optional result handlers.

### Negative
- "Did it land?" needs explicit machinery (4-arg result handlers, `onErrorOnly`) instead of an implicit await — a fire-and-forget error is silently lost unless a handler is attached.
- Flows are harder to trace than a call stack; `callContext.callChain` exists precisely to compensate.
- Write retry/backpressure cannot lean on a transport response end-to-end; it must be designed at the outcome level (overload/backpressure design + ADR-005's replay idempotency).
