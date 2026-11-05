# Mesh — `callDurable` (guaranteed delivery)

**Status**: **ON HOLD** — deferred 2026-07-01 from the continuation-only refactor ([`../archive/mesh-continuation-only-calls.md`](../archive/mesh-continuation-only-calls.md)). This is the **guaranteed-delivery tier**: an **additive layer** on the best-effort primitive built there, *not* a different mechanism. `callDurable` = best-effort `call` **+ a persisted backstop + an alarm**, wrapping the *same* traveling-handler / non-`@mesh`-sink primitive (parent D3/D5/D10 — D4 merged into D5). Building best-effort first paints us into no corner.
**Why deferred**: pre-alpha needs **no hard delivery guarantee** — best-effort `call` + Flow-C socket re-resolution + Child-3 subscription-reconcile covers every current flow and already kills "thinking forever."
**Revive when**: a flow needs *at-least-once* delivery surviving the **callee vanishing entirely**, or an **external side effect** delivered exactly/at-least once — e.g. `tasks/nebula-outside-world.md` (webhooks/email/cron), or fixing `@lumenize/fetch`'s ~90s flaw by rebuilding it on `callDurable`. **Revived for Mesh 1.0 (Larry, 2026-10-13):** it lands before `@lumenize/mesh` 1.0.0-alpha.1 is published, as [mesh-1-alpha.md](../mesh-1-alpha.md) § *Item 11: Durable calls* says, whether or not the outside-world work needs it by then.
**Packages**: `packages/mesh/` — `callDurable` is the generic primitive, built **fresh** here (not a patch of `@lumenize/fetch`'s hand-rolled double-duty alarm — that flaw is the *cautionary tale*, see Phase 0). `@lumenize/fetch` is NOT deprecated (best-effort-adapted to the new mesh, stays published); it could later be rebuilt on `callDurable` as a consumer.
**Related**: parent [`../archive/mesh-continuation-only-calls.md`](../archive/mesh-continuation-only-calls.md) (best-effort primitive + the D-numbers referenced here), [`../archive/mesh-client-callasync.md`](../archive/mesh-client-callasync.md) (the best-effort **client** awaitable `callAsync`, LANDED 2026-07-03 — its **foundation for the client tier**: a client-side `callDurable` (D9) is `callAsync` + a persisted `#pendingAsyncCalls` map + reconcile-on-reload, since the browser has no reliable alarm), [`mesh-overload-backpressure-handling.md`](mesh-overload-backpressure-handling.md) (owns overload/retry classification — the retry knob here is that task), [`../../docs/adr/005-optimistic-concurrency-etags.md`](../../docs/adr/005-optimistic-concurrency-etags.md) (replay-idempotency = the substrate that makes write-retry safe)

---

## Findings from the reload detour (2026-10-13)

A draft for a Client's durable outbox, `mesh-client-calls-survive-a-reload.md`, ran from 2026-10-12 to 2026-10-13 and was set aside. The problem that started it, a page losing an unsaved write when an ontology or build change reloads it, was then to be solved inside Resources by carrying the writes across the reload, and on 2026-10-13 that carry moved past pre-alpha as well, to be solved for every Star at once beside this file ([nebula-pre-alpha-fast-follow.md](../nebula-pre-alpha-fast-follow.md) § *Item 4: The prod ontology install path*). What it found in the code, for whoever revives this file:

- **An answer held for a reloading page is best effort.** `ClientGateway.receiveFireBack` sends on whatever socket the host thinks is open, and an unloading page's socket still looks open, so the answer goes down a closing socket and is lost. One later than the 5 s grace period is dropped. A resend, not the held answer, is what carries a call across a reload.
- **A stored `callAsync` frame is answered into nothing on a new load.** Its handler, `__settleCallAsync(callId)`, names a Promise in the old page's memory, and every write a Client sends goes through `callAsync` today. Two shapes survive this: answers matched by `callId` across loads, with every follow-up a Client method carrying the state it reads, or each load sending its stored calls again through the owner that made them and awaiting its own answers. The second keeps `callAsync` and the `loadId` rule as they are.
- **Nothing in a Client's frame depends on time,** because the Gateway stamps identity from the socket's current token on every frame. So a resend runs as whoever holds the socket now, and stored calls are keyed by the Client's address, `alice.9f2c41aa`, never by the tab: a duplicated tab gets a copy of `sessionStorage`, and another person can sign in on the same tab.
- **`sessionStorage` carries a call across a reload but not a closed tab.** Storing one is a synchronous `setItem` of the frame the Client already serializes. IndexedDB survives a closed tab, but every write to it is asynchronous, and every tab of an origin shares it.
- **A Durable Object's stored envelope does depend on time.** It carries the original `originAuth`, `exp` included, and no node re-checks `exp` on a hop, so a resend after an outage acts on an expired token's claims unless it is refused or pinned, as a turn pins its authority at its post (`security.md`).
- **On a node, the exposed window is the callee's chain after its early ack,** which a reset or a deploy kills before the fire-back; `waitUntil` holds the dispatch hop itself. The one node-side call that waits on an answer and cannot heal itself is the node invite, whose rows stay `pending` when the facade's answer is lost (`backlog.md` § *Nebula Auth*).
- **No callee keeps state per call, so a stored call cannot wedge the node it names.** A caller's outbox that sends one call at a time per node can stall behind one that never ends, so every stored call must end: answered, refused, or given up after a bounded number of sends.
- **The `newETag` replay check reads only the current snapshot.** Widening it to a resource's history misses one case: the same person writing again within the coalesce window, an hour by default, overwrites the row in place (`Snapshots`' `#writeSnapshot`).
- **A page's writes to different resources can commit out of order.** They go out in parallel and interleave at the validator's `await` on the Star. Nothing depends on that order today, since ADR-006 puts related writes in one transaction.
- **The reconnect half is already decided:** `backlog.md` § *Lumenize Mesh*'s receipt for every call, which has the Client resend any call its socket lost, and inventories which calls are safe to repeat.
- **Prior art:** Akka's reliable delivery, whose `EventSourcedProducerQueue` stores each message before sending it, records its confirmation, and on restart sends again whatever was never confirmed.

---

## Why best-effort already covers pre-alpha (the deferral rationale)

- **Client flows** — a lost response re-resolves to the current socket by callId on reconnect (parent Flow C), or the client reconciles against a durable server Resource via its subscription (Child-3 pattern). The client never hangs.
- **Idempotent re-issue** — ADR-005 forward-only eTags make a re-issued write safe, so "fire again on reconnect" is the client's recovery, not a server guarantee.
- **Every current awaited-`callRaw` site is best-effort-reconcilable** (DAG mutators, DevStudio sequences; chat already shipped on durable `Message` + subscription).

`callDurable` earns its cost only when *neither* holds: the caller needs the handler to run **even if the callee never responds** (callee vanished), or an **external side effect** must be delivered at-least-once. Pre-alpha has no such flow; the outside-world work does.

---

## Decisions (deferred from the parent — restated with context)

| Decision | Choice |
|---|---|
| **Backstop location** | **[FORK]** *callee-guaranteed* (caller still holds ZERO state; the callee persists the traveling handler + alarms to always fire back) vs *caller-guaranteed* (caller persists a backstop record + alarm — stronger, survives the callee vanishing entirely — but a durable write). Both on-thesis: persisted **data + alarm**, never a held Promise. |
| **API shape** | **4-arg only** (pinned 2026-07-02 with the parent's method split) — a "must-happen fire-and-forget" is modeled as a 4-arg with an ack handler. Attaches at the parent's named seams: SEAM A wraps `#dispatchEnvelope` (caller-side persist+alarm, cancel on `__handleResponse`); SEAM B wraps the fire-back inside `executeEnvelope` (callee-side). The parent's **early-ack** (D15) applies: the backstop alarm is armed **before** dispatch and outlives the early ack, so it still fires if the callee acks then vanishes. |
| **Retry** | A `callDurable` knob, **off by default, never on `.overloaded`** (retry worsens overload). Needs durable state → only exists in this tier. Leans on ADR-005 replay-idempotency; classification per the backpressure task (do not re-litigate its settled thinking). |
| **Client-side durability** | The client **cannot** be the guarantor — `setTimeout` dies on tab discard/reload; no reliable browser alarm (SW idle-kill; Periodic Background Sync PWA-only/~12h; Background Sync connectivity-only). So a client `callDurable` = **persist intent + reconcile on reconnect** against a server-side durable record (the DO owns the alarm); Web Push for server→client wake if ever needed. In practice: callee-guaranteed / reconcile only. (IndexedDB-backed local pending only as a last resort for a hypothetical flow with **no** durable server record to reconcile against — none in Nebula so far.) The best-effort client story is the parent's D8. |
| **MIT placement** | **`@lumenize/mesh`** — generic plumbing, built fresh (not by patching `@lumenize/fetch`'s hand-rolled alarm). |

---

## Sequence — `callDurable` (4-arg + persisted backstop + alarm)

> Moved here from the parent (framing S1). Reuses `call()`'s methods — **early-ack** (parent D15), the traveling handler (DO/Worker) / client-in-heap (D16) — and attaches persistence at named **SEAMS**. The backstop-location fork (SEAM A vs SEAM B) is the open decision above.

```mermaid
sequenceDiagram
    autonumber
    box rgb(232,240,254) Caller node
    participant U as user code
    participant CALL as callDurable()
    participant DISP as dispatchEnvelope (private)
    participant SINK as __handleResponse
    end
    box rgb(255,244,229) Callee node
    participant XOP as __executeOperation
    participant XENV as executeEnvelope
    end
    Note over U,XENV: callDurable = 4-arg + a persisted backstop + alarm. Reuses call()'s methods, plus SEAMS.
    U->>CALL: callDurable(binding, instance, remote, handler)
    Note over CALL,DISP: SEAM A (caller-guaranteed) — persist backstop + set alarm BEFORE dispatch
    CALL->>DISP: envelope {remote, HANDLER, returnAddr}
    DISP->>XOP: await stub.__executeOperation(envelope)
    XOP-->>DISP: EARLY ACK (parent D15) — caller freed, backstop alarm still armed
    Note over XOP,XENV: SEAM B (callee-guaranteed) — persist handler + alarm, guarantee the fire-back
    XENV->>SINK: fire filled handler into __handleResponse (executeEnvelope requireMeshDecorator FALSE)
    Note over CALL,SINK: SEAM A cancel — __handleResponse cancels the caller backstop/alarm (idempotent, ADR-005)
    SINK->>U: handler(result)
    Note over U,XENV: backstop location (SEAM A vs SEAM B) = the open FORK in the Decisions table above
```

---

## Phase 0 — Spike: de-risk durable delivery **[Exploratory — GATING for this increment]**
**Goal**: prove the load-bearing brick — concurrent alarm-backed durable delivery — **built fresh in `@lumenize/mesh`** (the generic primitive, not a patch of `@lumenize/fetch`'s hand-rolled alarm, which is the *cautionary tale* — see criterion 1).

**Success Criteria** (capable-of-failing tests + a captured findings note):
- [ ] **Separate timers by concern from the start.** The `@lumenize/fetch` **double-duty alarm** (`.claude/rules/mesh.md` §Two-one-way) is the cautionary reference: one timer served *both* the operation-timeout and the executor-liveness backstop — which is why it broke past ~90s and for concurrent in-flight requests. The fresh design must not repeat it.
- [ ] **Concurrent durable delivery proven**: N in-flight durable calls on one caller DO all deliver; survive an induced hibernation between dispatch and response; past-budget + long-running deliveries land.
- [ ] **Durable-path forgery**: a response for an unknown/duplicate durable-call id is rejected (the durable tier DOES keep a persisted backstop record to check against — unlike best-effort); responder identity checkable (inherits parent D5's gate: responses dispatch via `executeEnvelope`, so `onBeforeCall`/`requirePassage` identifies the responder; @mesh allowlist off).
- [ ] Findings note: mechanism that worked + alternatives that failed → reference memory or rule.

## Phase 1 — `callDurable` (storage tier) + retry
**Success Criteria**:
- [ ] Persisted backstop + alarm (fixed Phase-0 mechanism); resolve callee- vs caller-guaranteed.
- [ ] `retry` knob: off by default, **never** on `.overloaded`; ADR-005 idempotency; backpressure classification.
- [ ] Client durability = persist + reconcile (**no client alarm**).

## Phase 2 — Migrate the deferred sites + docs
**Success Criteria**:
- [ ] (Optional) rebuild `@lumenize/fetch` on `callDurable` — replace its hand-rolled double-duty alarm with the generic primitive (fixes its ~90s flaw). fetch is a *consumer* of this tier, not its foundation.
- [ ] Any flow that turned out to need a guarantee, migrated to `callDurable`.
- [ ] Docs: `callDurable` section in `calls.mdx`.
