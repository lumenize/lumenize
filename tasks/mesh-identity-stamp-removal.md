# Mesh — retire the persistent identity stamp (identity rides the envelope)

**Status**: **SOFT COMMITMENT (2026-07-02) — analysis done, NOT go'd.** Gate: Larry reviews **§ Benefits analysis** below → go/no-go → then the normal `/review-task` → `/build-task` cycle. **Sequenced strictly AFTER [mesh-continuation-only-calls.md](mesh-continuation-only-calls.md) ships** — it rewrites the same surfaces (`executeEnvelope`, the callContext plumbing, and the local-executor/alarm path that refactor deliberately scopes down to "alarms only"), and the sequential-implementation rule forbids concurrent write-work. Written ahead of its turn as a **decision/analysis record** (the 2026-07-02 discussion would otherwise be lost) — it is NOT the active child and NOT an empty stub; the one-child-at-a-time rule still governs when it becomes active.

**Interim already landed (2026-07-02, safe under either outcome):** a 2-line write guard in `packages/mesh/src/lmz-api.ts` `setBindingName`/`setInstanceName` — already-stamped re-inits (the every-call hot path, see § What the stamp does today) skip the redundant `kv.put`. If this task goes, the guard is deleted along with the setters; if this task is rejected, keep the guard permanently.

**Packages**: `packages/mesh` (identity plumbing + alarms), `apps/nebula` (one small call-site sweep), website docs sync.

---

## Objective

Kill the persistent first-touch identity stamp (`__lmz_do_binding_name` / `__lmz_do_instance_name` in DO kv storage). Identity becomes **envelope/header-carried per contact**, held **in-memory, first-write-wins, for the isolate lifetime** — exactly the model `createLmzApiForWorker` already uses (a closure variable with the same mismatch throw). The one entry path with nothing in-band — **alarms** — gets its context **persisted in the alarm row**: `__lmz_alarms` rows gain `{selfIdentity, callContext}`, restored at fire time. The alarm half pays dividends of its own (`lmz.callContext` works in alarm handlers; a stored alarm row becomes a persisted envelope — the exact shape [`on-hold/mesh-call-durable.md`](on-hold/mesh-call-durable.md) needs).

## Origin

2026-07-02 discussion (Larry): the stamp predates `callContext` — it was built when a DO had no other way to learn its own name (Cloudflare never exposes the name inside the DO; `ctx.id` has no usable `.name`). Now every mesh call carries `metadata.callee` and every routed HTTP request carries identity headers, so the stamp is redundant as an identity *source*. The open question was whether it is load-bearing for anything else. Answer: it has exactly two remaining jobs — **alarm-path identity** (real; fixed by persisting context in the row) and **cross-lifetime identity stickiness** (a bug detector, **not** a security control — argument below). Larry's gate question was: *"Would removing the stamp break the Nebula scope protection we have now?"* → **No** (§ Security).

---

## Benefits analysis (the go/no-go substance — all claims verified against code 2026-07-02)

### What the stamp does today

- `createLmzApiForDO` backs `lmz.bindingName`/`lmz.instanceName` getters with two kv keys; `setBindingName`/`setInstanceName` throw on a value change (**first-write-wins**) ([lmz-api.ts](../packages/mesh/src/lmz-api.ts), `createLmzApiForDO`).
- `__init` runs on **every** entry: `executeEnvelope` step 3 re-inits from `metadata.callee` on every incoming mesh call; `initIdentityFromHeaders` re-inits from `x-lumenize-do-*` headers on every routed HTTP request (shared by `LumenizeDO.fetch` and `LumenizeContainer.fetch` — the ADR-007 "identity on every entry path" composition).
- **Cost finding:** before the interim guard, both setters `put` unconditionally → **2 SQLite row-writes per incoming mesh call and per routed HTTP request**, at $1/M rows vs $0.001/M reads — i.e. a read-only mesh call paid 2 writes. The guard stops the recurring bleed; this task removes the write class entirely.

### Identity is already in-band everywhere except alarms and onStart

| Entry path | Identity source without the stamp | Status |
|---|---|---|
| Mesh call (`__executeOperation`) | `envelope.metadata.callee`, every call | ✅ in-band |
| Routed HTTP (`fetch` via `routeDORequest`) | `x-lumenize-do-*` headers, every request | ✅ in-band |
| Container public surface | same headers (composes `initIdentityFromHeaders`) | ✅ in-band |
| WebSocket handlers | N/A — app DOs never accept their own WS; Gateway is raw + zero-storage with its own re-stamp | ✅ N/A |
| **Alarm** | **nothing** — `triggerAlarms` → `__localChainExecutor`, no envelope | ❌ **the hole → alarm-row context (this task)** |
| **onStart / constructor** | **nothing** on first-ever construction (already true today — the stamp doesn't exist yet when the constructor runs) | ❌ accepted; see § onStart |

Alarm detail (today's behavior, all three points): (1) an alarm handler has **no `callContext` at all** — `this.lmz.callContext` **throws** (`requireCurrentCallContext`; `triggerAlarms` never wraps in `runWithCallContext`); (2) outgoing `lmz.call` from an alarm handler works **only because** the caller identity is read from the stamp (`callShared`'s fail-fast "must know its own bindingName" + `callRawImpl`'s `callerIdentity`) — on a cold DO woken by its alarm, remove the stamp and `call()` throws; (3) outgoing calls from alarm handlers start **fresh chains with `originAuth: undefined`** — no attribution, no chain continuity. The only in-repo alarm-continuation consumer today is `@lumenize/fetch`'s experimental backstop ([fetch.ts:158](../packages/fetch/src/fetch.ts)); **`apps/nebula` schedules zero mesh alarms** (verified by grep), so the migration surface is trivial — but the master plan has alarm-shaped work queued (soft-delete reaper grace window, dead-admin liveness checks).

### Security: removal does NOT weaken Nebula scope protection

This was the gate question. The answer is no, for four reasons:

1. **Both scope-check inputs already ride the envelope; the stamp pins only one.** `enforceScopeReach(name, claims)` ([nebula-do.ts:66](../apps/nebula/src/nebula-do.ts)) takes the callee `instanceName` and the caller's `claims`. Both arrive in the same envelope (`metadata.callee` + `callContext.originAuth`). The stamp pins the name; the claims were always trusted as-sent.
2. **No JWT re-verification exists on the mesh receive path** — deliberately. Verification happens once at the Gateway, which **replaces** whatever the client sent with verified-attachment identity and claims (`#handleClientCall`, "Gateway is the trust boundary" — [lumenize-client-gateway.ts:538-550](../packages/mesh/src/lumenize-client-gateway.ts)). Between mesh nodes, `originAuth` is trusted as-sent.
3. **The dominance argument (decisive):** the attacker the stamp supposedly stops must deliver an envelope whose `metadata.callee` differs from the routed target. That requires raw env bindings plus direct `stub.__executeOperation()` access — and an attacker with *that* access can forge `callContext.originAuth.claims` outright (`aud`, `access.admin: true`) and pass `enforceScopeReach` against a **correctly-stamped** name. The stamp never stood between that attacker and the data. Therefore its stickiness is a **bug detector** (config drift, a mis-built envelope builder), **not an adversarial control**. The real boundary — Gateway verifies clients; mesh nodes trust each other; DWL-loaded user code never receives raw DO namespace bindings — is untouched by this task.
4. **"name == routing key" holds per-call by construction for honest code:** every envelope builder derives `metadata.callee` from the exact variables it routes with — `callRawImpl` and the Gateway both feed the same `binding`/`instance` values to `getDOStub(...)` and to `metadata.callee`; `routeDORequest` sets headers from its own routing decision. `enforceScopeReach` **fails closed** on a missing name ([nebula-do.ts:70-72](../apps/nebula/src/nebula-do.ts)) — identical behavior with envelope-sourced identity.

**What replaces the stickiness:** an **in-memory first-write-wins guard** (mirror `createLmzApiForWorker`'s closure) keeps within-lifetime divergence loud at zero writes. **The failure mode improves:** today a divergent *first* envelope poisons the stamp permanently (trust-on-first-use) and then throws on every honest call until manual storage surgery; in-memory mis-learning self-heals on eviction.

**What we genuinely lose:** cross-lifetime drift detection (a divergence where the isolate was evicted in between goes unnoticed instead of throwing). Accepted because (a) it is adversarially irrelevant per point 3, (b) its bug-detection value is small next to its operational cost — see the rename brick, next section.

### Benefits of the full switch (vs. keeping the write-guarded stamp)

1. **Binding renames and instance-name-scheme changes stop bricking DOs.** Today, renaming a binding (or ever changing the `{u}.{g}.{s}` naming scheme — live forks in [`on-hold/use-lumenize-dev-domain-and-support-custom-domains.md`](on-hold/use-lumenize-dev-domain-and-support-custom-domains.md)) makes every previously-stamped instance throw the mismatch error on every call, forever, until its storage is manually edited. With in-memory identity, old isolates die at the deploy and fresh lifetimes learn the new name cleanly.
2. **Single source of truth for identity.** The stamp is a second, storage-resident copy of something the message already carries — exactly the "target or interim?" ambiguity the workflow rules warn about. Post-switch, identity rides the message, full stop. This is also the direction the continuation-only refactor pins for control flow (D3/D10: "caller holds ZERO state") — comms state lives in the message or in an explicit durable row, never implicitly on the node.
3. **DO/Worker consistency.** Workers already hold identity in a closure with the same first-write-wins semantics. One model everywhere (DO, Worker, Container-by-composition; the browser client already hand-rolls in-memory identity).
4. **The alarm half is independently valuable:** `lmz.callContext` stops throwing in alarm handlers (today's footgun asymmetry between "code in a call" and the same code time-shifted); alarm-fired work gets callChain continuity + `originAuth` attribution; and an alarm row that stores `{selfIdentity, callContext, chain}` **is a persisted envelope** — the durable tier (`callDurable`, SEAM A/B in the continuation-only file) attaches persistence+alarm at exactly this shape, so this task is a stepping stone toward it, not a detour.
5. **Kills the residual write cost permanently** (the interim guard still pays 2 reads/call to check; the switch pays a field read).

### Costs / risks / constraints

1. **Alarm rows MUST carry `{selfIdentity, callContext}` — prerequisite, not garnish.** Without it, removing the stamp breaks outgoing `lmz.call` from any alarm handler on a cold DO (see § in-band table). Migration is trivial today (no live alarm rows in nebula; `@lumenize/fetch` is experimental and its backstop is deferred with `callDurable`).
2. **Restored-`originAuth` semantics must be pinned** (the one real design decision): claims are frozen at schedule time; a cron row replays the same claims on every fire, possibly after revocation or `exp`. Proposed: **restored context = attribution/provenance, never fresh authorization** — point-of-action enforcement (ADR-008; Star's DAG checks) re-derives current permissions at execution time; `newChain: true` remains available for work that should run as a fresh system origin. Alarms keep **skipping `onBeforeCall`** (the T-local-skip invariant, [nebula-do.ts:148-151](../apps/nebula/src/nebula-do.ts)) — but nodes *called from* an alarm handler evaluate the restored originAuth like any inbound call; that's the surface `/review-task`'s security lens should probe.
3. **Not a D14 violation (pre-empting the pattern-match):** the continuation-only task's D14 rejects serializing a **second, call-time context snapshot** for the response leg *because natural propagation exists there and carries the right identity*. An alarm has **no transport leg** — nothing arrives at fire time to propagate from. The row IS the transport; a persisted snapshot is the only possible carrier. Same principle ("context rides the message"), different message.
4. **Identity is never available in the constructor/`onStart`** (today it's "warm wakeups only," which is already unreliable — the stamp doesn't exist during the first-ever construction). Verified consumers: none — `Star.onStart` and `DevStudio.onStart` only wire lazy `() => this.lmz.callContext` thunks evaluated during later calls. Document "identity available from first entry-point dispatch onward," and defer any run-once-after-identity `onStart` upgrade until a real consumer appears (design sketch exists in the 2026-07-02 discussion: entry → identity init → run-once onStart → onBeforeCall → method; traps = preserve the `blockConcurrencyWhile` guarantee, and restore alarm-row identity BEFORE onStart). The constructor's orphaned-alarm recovery scan needs no identity and stays put.
5. **Edge:** an alarm scheduled from `onStart` on a never-contacted DO has no identity/context to persist; if its handler makes outgoing calls and the DO is evicted before any contact, the call fails — same class as today's behavior (the stamp wouldn't exist either). Document as a constraint: schedule outgoing-call alarms from call paths.
6. **Docs/JSDoc sync:** `lmz` JSDoc and mesh docs say identity "read from DO storage" — sweep `website/docs/mesh/` + JSDoc as normal API-surface work.
7. **Stale stamp keys in deployed DOs** become inert orphans. Lean: leave them (deleting costs a write per key per DO for zero benefit); delete opportunistically only if a later migration touches the same rows anyway.

---

## Proposed decisions (pin at `/review-task`)

| # | Decision | Proposal | Status |
|---|---|---|---|
| PD1 | Identity backing store | In-memory per-lifetime, first-write-wins with the same mismatch throw — mirror `createLmzApiForWorker`. No new ALS machinery: `__init` keeps running on every entry exactly as today; only the backing store changes (kv → private field). | **[PROPOSED]** |
| PD2 | Alarm row schema | `__lmz_alarms` gains `{selfIdentity, callContext}` (serialized via the same `preprocess`/JSON treatment as `operationChain`; `state` must be structured-clone-safe, which crossing any hop already requires). Additive columns; no live rows exist. | **[PROPOSED]** |
| PD3 | Fire-time restoration | `triggerAlarms` re-inits identity from the row, then runs the executor inside `runWithCallContext(restoredContext)`. Keep `requireMeshDecorator: false` and keep skipping `onBeforeCall` (T-local-skip). | **[PROPOSED]** |
| PD4 | Restored-originAuth semantics | Attribution/provenance only — never fresh authorization; point-of-action re-checks (ADR-008) are the enforcement; `newChain: true` for system-origin work. Cron fires replay the schedule-time claims (frozen, possibly `exp`d) — documented, not "fixed". | **[PROPOSED — the review's security focus]** |
| PD5 | onStart identity | Not available, ever, in constructor/onStart (was already absent on first construction). No deferred-onStart latch now (zero consumers — YAGNI); the upgrade design is recorded in § Costs #4 for when a consumer appears. | **[PROPOSED]** |
| PD6 | `dev-container.ts` preview fallback | Make the routing header authoritative on the preview fetch path (`header ?? this.lmz.instanceName` at [dev-container.ts:321](../apps/nebula/src/dev-container.ts) — in-memory covers warm hits; a cold-and-headerless path would already be broken today and should fail loud). | **[PROPOSED]** |
| PD7 | Old stamp keys | Leave orphaned (inert); no cleanup writes. | **[PROPOSED]** |

## Phases (sketch — refine + pin at `/review-task`)

**Phase 1 — in-memory identity.** Swap `createLmzApiForDO`'s kv-backed setters/getters for a closure/field with first-write-wins (Container inherits by composition; Worker/client already conform). Delete the two kv keys from the write path. Success: all existing mesh identity tests green; a capable-of-failing test that a within-lifetime identity flip still throws; grep shows no `__lmz_do_binding_name`/`__lmz_do_instance_name` writes outside tests (`grep -rn "__lmz_do_" packages apps` to enumerate at build time).

**Phase 2 — alarm rows carry context.** Schema add + `schedule()` captures `{selfIdentity: {type, bindingName, instanceName}, callContext: captureCallContext()}`; `triggerAlarms` restores both before executing. Success: capable-of-failing tests — (a) `lmz.callContext` is available inside an alarm-fired continuation on a **cold** DO (constructor → alarm, no prior call in that lifetime), (b) an outgoing `lmz.call` from that handler succeeds and the receiver sees the restored `originAuth` + extended callChain, (c) cron re-fire reuses the stored context.

**Phase 3 — sweep + docs.** PD6 dev-container change; JSDoc + `website/docs/mesh/` sync ("read from DO storage" → per-contact/in-memory + alarm-row model; identity-availability contract from PD5). Success: doc grep for the stale storage claim comes back empty; type-check + full mesh & nebula suites green.

**Final verification (every phase):** package tests green, `npm run type-check`, docs-match grep, JSDoc reflects behavior.

## Relation to other work

- **[mesh-continuation-only-calls.md](mesh-continuation-only-calls.md)** — hard sequencing dependency (same files; it scopes `__localChainExecutor` to alarms-only, which is precisely the path Phase 2 upgrades). Do not start before it ships.
- **[`on-hold/mesh-call-durable.md`](on-hold/mesh-call-durable.md)** — PD2's row shape is the persisted-envelope substrate its SEAMs attach to.
- **[`on-hold/use-lumenize-dev-domain-and-support-custom-domains.md`](on-hold/use-lumenize-dev-domain-and-support-custom-domains.md)** — benefit #1 de-fangs the naming-scheme forks' interaction with stamped identities.
- **[nebula-container-wakeup-fix.md](nebula-container-wakeup-fix.md)** — orthogonal (below the mesh layer); no shared files beyond `dev-container.ts`, where PD6 is a one-line touch.
