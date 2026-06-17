# Mesh Overload & Retry Handling (CF `.overloaded` / `.retryable`)

**Status**: On Hold — thinking settled (2026-06-09); Phase 3 (eTag replay-idempotency) verified present in `resources.ts` 2026-06-15, rest not started
**Packages**: `packages/mesh/` (call boundary + WS upgrade), `apps/nebula/` (client UX + idempotency), `packages/structured-clone/` (only for the minted typed error)
**Related**: `tasks/on-hold/mesh-resilience-testing.md` (how we'd test this), `tasks/nebula-tenant-ai-billing.md` (multi-tenant load is when this matters)
**Relevant engine**: `packages/mesh/src/lmz-api.ts` (`callRaw` boundary, `lmz-api.ts:305`), `packages/mesh/src/lumenize-client.ts` (reconnect backoff `:824`, wake-up sensing `:840`), `packages/mesh/src/lumenize-worker.ts` (WS upgrade), `apps/nebula/src/nebula-client.ts` (serial txn queue `:751`, eTag idempotency / conflict retry `:1020`)

## Goal

Make the Mesh **overload-aware**: gate retry/backpressure on Cloudflare's thrown-error
properties (`.overloaded`, `.retryable`) at the call boundary and WS-upgrade path,
*without* introducing blind retries. Today Lumenize source inspects none of these.

## Settled thinking (do not re-litigate)

1. **CF signals overload/transient as thrown-`Error` properties, not headers.** Same for
   `stub.fetch()` and `stub.method()`: a rejected/thrown `Error` with `.overloaded === true`
   (admission/load-shed) or `.retryable === true` (transient), plus `.remote`. There is **no
   backpressure HTTP header**. Messages: `"Durable Object is overloaded. {Too many requests
   queued | Too much data queued | Requests queued for too long | Too many requests for the
   same object within a 10 second window}."`
   ([CF error-handling docs](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/))

2. **The signal is infra-minted *locally* at the calling isolate's RPC/fetch boundary — it is
   NOT a mesh-hop payload.** In `A → B → C`, when `C` is overloaded, `B`'s `stub` call rejects
   *inside B* with a fresh `Error` carrying `.overloaded`. So sensing/acting happens inside
   `lmz.callRaw`'s try/catch (`lmz-api.ts:305`) and inside the Worker during WS upgrade —
   **no `@lumenize/structured-clone` involved for sensing.** SC only matters if we choose to
   *mint our own typed error* (e.g. `MeshOverloadedError`) and propagate it up to the
   originating app — and that shape is ours, so we never depend on CF's raw property
   surviving a hop. (This retracts the earlier "verify the property survives the hop"
   concern — it was misframed.)

3. **Asymmetry to respect (doc-grounded):** per CF's
   [error-handling page](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/),
   `.overloaded === true` "should not be retried"; `.retryable === true` is "suggested to be retried
   **if requests to the Durable Object are idempotent**, or can be applied multiple times without
   changing the response… If requests are not idempotent, then you will need to decide what is best
   for your application." So idempotency is a *documented precondition* for retry, not our invention.
   (The deeper *rationale* — a mutation that persisted but whose success response was lost — is general
   distributed-systems reasoning, not a CF sentence; CF's **output gate** mitigates the opposite
   direction by withholding the response until the write is durable. See `rules-of-durable-objects`.)
   Nebula transactions satisfy the precondition via client `newETag` idempotency; general raw mesh
   calls do not.

4. **What exists today** (audited): exponential-backoff WS reconnect keyed on *close code*
   (`lumenize-client.ts:824`, **no jitter** → thundering-herd after a Gateway restart, worsened
   by wake-up sensing at `:840`); bounded disconnect queue (max 100); serial Nebula txn queue
   (self-throttles naturally); eTag-conflict retry capped at 5 (`nebula-client.ts:1020`). None
   keyed on `.overloaded`/`.retryable`. The `.overloaded` handling in `agents`/`partyserver`
   lives on the **in-app-AI / Think-shim path** (`agents` is a direct dep of `apps/nebula`),
   **not on the Mesh wire**.

5. **DECISION (2026-06-09, revised same day): Mesh exposes a `call()` option `{ readOnly: true }`;
   the *caller declares* read-only-ness and `callRaw` owns the backoff/jitter retry, gated on it.**
   Supersedes the earlier "no flag — pure app-layer" stance. The flag was first rejected as YAGNI when
   its only consumer was the Nebula write; **reads change that** — reads are a large, structurally
   read-only (hence idempotent) population, so the flag is a real primitive, not indirection for one
   caller. It dissolves the "mesh can't know idempotency" objection: the mesh doesn't *infer* anything,
   the caller *asserts* read-only-ness — which it legitimately, and *safely*, can.
   **Why `readOnly`, not `idempotent`:** `readOnly ⊂ idempotent`, and read-only-ness is *structurally
   obvious* whereas idempotency is subtle (`newETag` makes a *write* idempotent non-obviously). Naming
   the flag after the checkable *sufficient* condition rather than the subtle *actual* requirement is
   the safer footgun posture — "is this read-only?" is far less error-prone for an app author (often the
   hosted LLM) to answer than "is this idempotent?" The one idempotent-but-*mutating* caller (the eTag
   write) does **not** use this flag (below), so the generality `idempotent` would buy is unused.
   Constraints on the design:
   - **Acting locus = `callRaw` itself — DO-side AND client-side alike (one place).** An earlier draft
     restricted retry to the client to dodge in-DO wall-clock billing; **reversed.** That billing is
     incurred only when a downstream is *overloaded* — rare, bounded, logged — and the input gate is
     already open for the duration of the `await`, so a backoff merely *extends* an already-open
     window, it doesn't open a new one. Not worth distorting the architecture. *Further refinement
     (deferred):* a recent-overload **circuit breaker** — a counter (an instance var is fine; its
     reset on hibernate/restart is *desirable* for a recent-rate signal) that backs off harder / sheds
     once overloads spike. That's how we honor CF's "retrying an overloaded DO worsens it" at scale.
   - **Two independent axes, both required to retry — this is why the flag exists.** The CF error
     *property* is the server's signal ("is this failure transient/overloaded?"); the *flag* is the
     caller's knowledge ("is repeating this call safe?"). The `readOnly` flag gates the whole thing;
     within it, treatment is **per-property, not one boolean** (`.retryable` and `.overloaded` are set
     in mutually-exclusive cases — transient-failure vs overload — so `&&` would never fire):
       - `readOnly && retryable` → retry, backoff + jitter (the canonical CF "retry if idempotent").
       - `readOnly && overloaded` → retry, **longer** bounded backoff. ⚠️ **Deliberate softening:**
         CF says overloaded *"should not be retried."* We retry-with-long-backoff (+ circuit breaker)
         for UX, honoring the spirit (don't add load while overloaded). Strict-CF alternative =
         **don't** retry overloaded; surface/shed immediately. **Decide this explicitly.**
       - else (non-retryable: bug, validation, `!readOnly`) → surface, never auto-retry.
     Without `callRaw` doing this, the flag is pointless — flag and callRaw-handling stand or fall together.
   - **Footgun guard (locus-independent).** Default off. **Structurally-read API paths set the flag
     internally** — client read/subscribe, and any DO read-method surface — so app authors (often the
     hosted LLM) never hand-judge read-only-ness for the common case. The flag's *public* surface earns
     its keep only for hand-written read-only DO→DO calls. Loud docs for manual use.
   - **Nebula write does NOT set the flag — ALL its retry is app-level, in ONE loop.** Both triggers —
     transport (`.overloaded`/`.retryable`) and semantic eTag *conflict* — resubmit the *same*
     transaction, so both live in the existing client-side conflict-resolver loop
     (`nebula-client.ts:1020`) with one backoff budget and one `maxRetries` cap (this resolves the
     earlier "two interacting retry budgets" awkwardness — there is only one). It reuses a shared
     backoff+jitter *utility*, not the `callRaw` flag path. Retry stays client-side = outside the
     overloaded Star, where `newETag` lives. The mesh flag and the app loop are genuinely *different
     mechanisms*: reads have no conflict concept; the write's retry is inseparable from conflict
     resolution, which the mesh structurally cannot do (it knows no eTags). **The write's app-level
     retry still depends on the Phase 3 server-side replay-idempotency check** — that is what makes
     resubmitting the same `newETag` safe.

   Mesh's non-retry obligation is unchanged: **tag the error once at the catch point** into a stable
   typed shape that survives the wire to the client (Phase 1).

## The real enablers: (a) error classification that survives to the client, (b) a caller-declared `{ readOnly: true }` flag acted on in `callRaw` (DO + client), (c) server-side replay-idempotency of `newETag` (backs the app-level write retry), (d) jitter. NOT mesh *inferring* idempotency, and NOT raw CF-property survival.

## Phases (draft — refine at review)

### Phase 1: Mesh classifies the overload signal (the only mesh-layer work)
- [ ] At the catch point where a downstream `stub` call rejects, tag CF `.overloaded`/`.retryable`
      into a **stable typed error** we own (`MeshOverloadedError` / `code:'OVERLOADED'` + `'RETRYABLE'`).
      Tagging sites: the Gateway's RPC catch (`lumenize-client-gateway.ts:604` — **primary, client-facing**),
      `lmz-api.ts:305`, and the Star transaction handler. No retry here.
- [ ] **WS carrier already exists — confirm, don't build.** The Gateway already forwards a thrown RPC
      error to the client as `CALL_RESPONSE {success:false, error: preprocess(error)}` over the WS
      (`lumenize-client-gateway.ts:604–615`); client postprocesses at `lumenize-client.ts:1126`. So the
      transport plumbing is in place — the open question is only whether `.overloaded`/`.retryable`
      **own-properties survive** it. Two sub-cases:
  - **Common (overloaded Star):** CF rejects the *Gateway's own* RPC → error minted locally at the
    Gateway catch with the property intact → only needs to survive the WS `preprocess`/`postprocess`
    (SC "preserves all custom own properties" — assert it). This is the same SC question, now anchored.
  - **Deep (overload below the Star):** error rides the Gateway←Star CF-RPC hop first, where raw-RPC
    own-property survival is **under-documented** (`raw-comm.md`) — the genuinely-uncertain path.
- [ ] Capable-of-failing test: force an overload, assert the **client** receives the typed tag
      (not a generic error), via the `CALL_RESPONSE` error path. This is the real "survives the hop"
      concern — on *our* shape, not CF's.

### Phase 2: `{ readOnly: true }` flag + `callRaw` retry (the read-only mechanism — DO + client)
- [ ] Add `readOnly?: boolean` to `CallOptions`; thread through `call()`/`callRaw`. Default off.
- [ ] Implement the flag-gated retry in `callRaw` itself — **both** `LumenizeClient.callRaw` and the
      DO-side path (`lmz-api.ts`). Retry only when `readOnly` && a retry-class property: `.retryable`
      → backoff+jitter; `.overloaded` → *longer*, bounded backoff (or shed — see decision #5 softening).
      `maxRetries` budget; surface to caller after. In-DO wall-clock cost accepted (overload-only, rare).
- [ ] **Structurally-read paths set the flag internally** (footgun guard) — client read/subscribe and
      any DO read-method surface; app authors don't hand-judge. Public flag is for hand-written reads.

### Phase 2b: Nebula write retry — fully app-level, ONE loop (does NOT use the flag)
- [ ] Extend the existing client-side conflict-resolver loop (`nebula-client.ts:1020`) to also trigger
      on transport errors (`.overloaded`/`.retryable`), not just eTag conflicts — same resubmit, same
      `newETag`, **one** backoff+`maxRetries` budget. Factor the backoff+jitter math into a shared
      utility reused by Phase 2's `callRaw` path. Depends on Phase 3 (replay-idempotency of `newETag`).
- [ ] **Further refinement (deferred): recent-overload circuit breaker** — count overloads in a short
      window (instance var ok; reset-on-hibernate is fine for a recent-rate signal); back off harder /
      shed when they spike. Honors CF's "retrying an overloaded DO worsens it" at scale.

### Phase 3: VERIFY server-side replay-idempotency of `newETag` (correctness lynchpin)
- [x] Confirm the Star transaction handler treats a resubmit of an **already-applied** `newETag` as a
      success-returning no-op (the "committed but response was lost" `.retryable` case) — not a
      double-apply and not a spurious conflict. **Retry is unsafe to ship until this holds.**
      - **VERIFIED 2026-06-15** (review pass on the Nebula Star path): two-layer replay detection, both
        returning `{ ok: true }` → client `committed`: pre-validator fast path (`apps/nebula/src/resources.ts:314`)
        + authoritative in-txn re-check (`resources.ts:424`, Step 6.5, ordered before the conflict scan, uses
        `.some` so a sibling mutation can't hide the replay). No double-apply, no spurious conflict. This
        lynchpin is satisfied on the Nebula path; a raw-mesh `callRaw` retry would still need its own check.

### Phase 4: Transport / thundering-herd (orthogonal — clean win regardless)
- [ ] Add jitter to reconnect backoff (`lumenize-client.ts:824`) and wake-up reconnect (`:840`).
- [ ] WS-upgrade overload signal: when the Worker's `stub.fetch()` upgrade rejects `.overloaded`,
      return a deliberate close-code / `Retry-After` so the client backs off instead of storming.

### Phase 5 (deferred): fire-and-forget continuations — same idempotency problem
- [ ] NOT a freebie. A framework reschedule of a non-idempotent continuation is as unsafe as a
      `callRaw` retry. Only viable if the continuation carries an **app-supplied idempotency key**;
      otherwise it stays log-and-dead-letter + surface, not blind reschedule (`lmz-api.ts:172`).

## Future upside — `readOnly` is also the cache predicate (out of scope, don't build yet)
The flag we're adding for retry doubles as the right signal for a **read-result cache** later — and it's
a *stronger* argument for `readOnly` over `idempotent`: cacheability tracks read-only-ness, **not**
idempotency (the eTag write is idempotent/retry-safe but NOT cache-safe — caching it would swallow a
real mutation). So `readOnly` is the precise cache predicate; `idempotent` would over-include writes.
Two hazards to respect if/when this is built:
- **Cache key MUST include the caller's auth scope/identity** — a `readOnly` result cached without it
  is a cross-tenant data leak (Nebula multi-tenant). Cacheability respects the trust boundary or it's a vuln.
- **Invalidation already has a home:** Nebula's subscription/broadcast layer knows when a resource
  changes — ride that reactive signal instead of guessing TTLs (sidesteps the hardest caching problem).

## Open questions to settle before "go"
- Default backoff/jitter parameters; `maxRetries` budget value. (The earlier "two interacting budgets"
  question is RESOLVED — the write now has one app-level loop; reads have the separate `callRaw` path.)
- How `.overloaded` surfaces in Nebula client UX (busy state vs. silent backoff).
- Whether the serial txn queue should *pause its drain* on a seen `.overloaded` (cheap admission backpressure) vs. per-transaction backoff only.
- Cleanup: stale direct `partyserver` pin in non-workspace `lumenize-monolith/package.json:74` (tangential).
