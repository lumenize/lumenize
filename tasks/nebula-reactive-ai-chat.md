# Nebula — reactive AI chat (Child 3)

**Status**: **REVIEWED — Stage-1 (live with Larry) + Stage-2 conformance panel both done 2026-07-01.** Stage-2 (architecture/mesh, security, test-strategy) raised 0 blockers / 5 majors / 2 minors / 2 nits, all resolved into the decisions + phases below (M1 single-node pin, M5 ordering, M2 emit-seam/testability split, M3 transient-surface assertions, M4 per-operand accessor tests, m1/m2/n1/n2 folded in). **ALL PHASES (0–6) BUILT + verified 2026-07-01.** 15 tests green across the child3 + affected suites (+ 536 across unit/baseline/dev-studio/frontend); `tsc` clean (mod. 3 pre-existing child2 `eTags` nits); the trickiest assertions (M3b reconcile, M1/M4 recheck) mutation-verified; `/build-task` verifier fan-out (Phases 0–3) all conform. Phase 5's UI viewport driver is deferred to the Studio chat UI (headless-untestable; the mechanism is Child-2-verified). **Still open (non-blocking):** D-corpus (Galaxy eval-corpus fate), D-echo hardening (server-validate `author`), the ephemeral-path removal (now demoted), and a `wrangler dev` exercise of the real `chat()` streaming wiring. **Child 3** of the multi-user chat thread ([`nebula-pre-alpha.md`](nebula-pre-alpha.md) § Current focus); **builds on Child 1** ([`tasks/archive/nebula-devstudio-data-plane.md`](archive/nebula-devstudio-data-plane.md), the composable `ResourceDataPlane` on DevStudio + the platform-fixed ontology) and **Child 2** ([`tasks/archive/nebula-query-subscriptions.md`](archive/nebula-query-subscriptions.md), `subscribeQuery` over `Message where session == {id}` + windowed lazy content subs with grace).

> **Naming note (pinned 2026-07-01): `Turn` → `Message`.** The chat unit is renamed `Turn` → **`Message`** everywhere in this doc + the ontology. "Message" + a `role` field is the dominant-ecosystem convention (Anthropic/OpenAI messages array), and the record was always message-shaped (one `role` per row, never a round-trip) — multi-participant just makes "Turn" an obvious misnomer. **No prod migration**: Child 1/2 were never deployed, so there's no snapshot data anywhere — it's a pure source+test rename + a version-constant rename (`SESSION_TURN_ONTOLOGY_VERSION` → `SESSION_MESSAGE_ONTOLOGY_VERSION`). The parent stays **`Session`**. Distinct concept, keep its name: Galaxy's eval-corpus `TurnRecord`/`recordTurn` genuinely *is* a full generate-cycle "turn" (systemPrompt/toolCalls/reasoning) — letting the two names diverge is correct (partially pre-answers **D-corpus**).

---

## Motivation

Today a chat turn is an **in-memory pending Promise** on the client (`NebulaClient.chat` → `#pendingTurns`, settled by the `onChatResult` direct-delivery push) and is **recorded only to Galaxy** (`DevStudio.#recordTurn` → `Galaxy.recordTurn`, the eval corpus). Three failure modes the pre-alpha loop hits:

1. **No history-restore on refresh** — the pending map lives in JS memory; a reload loses the conversation.
2. **Completed-while-disconnected loss / "thinking forever"** — a turn runs for minutes; if the WS drops and the `onChatResult` push is missed, the reply is stranded (direct delivery softened this, but the reply is still ephemeral).
3. **No multi-participant** — a second client (a coach / UX designer now; teammates later) can't see the conversation.

**The fix (pinned with Larry 2026-06-29 / refined 2026-07-01):** model **each chat message as a `Message` Resource FK'd to a `Session`** (parent), hosted on **DevStudio's** data plane, and let a **single query subscription** (`Message where session == {id}`, the Child-2 `field == value` form) be the durable delivery + history channel. A committed `Message` is durable and reactive — refresh re-subscribes and replays it, a missed push is repaired by the query rerun, and every session subscriber sees it. The assistant's **live progress** rides a *separate, transient* direct-delivery push (**option (b)** below), so nothing depends on request/response across the client connection (ADR-003). This also **relocates chat off Galaxy** onto the per-app DevStudio where it belongs.

---

## What already exists (Child 1 + Child 2 — do NOT rebuild)

- **DevStudio hosts Resources** via the composed `ResourceDataPlane` (`dev-studio.ts onStart`): `transaction`/`read`/`subscribe`/`unsubscribe`/`subscribeQuery`/`unsubscribeQuery` + the DAG (`dagTree()`), all `@mesh()` non-admin + DAG-gated (Child-1 D4).
- **The `Session`/`Message` ontology** is the platform-fixed constant compiled on DevStudio (`devstudio-resource-ontology.ts`; currently authored as `Session`/`Turn` → renamed here). `Turn.session` (→ `Message.session`) is the to-one FK Child 2 subscribes on. **Survives app-data wipes** (NOT in the `.dev` Star). Editing it is a breaking change → bump the ontology-version constant + wipe DevStudio's resource snapshots. **Never deployed → the wipe/bump is moot for the rename** (there's no data), but the field enrichments below are still a single deliberate version bump.
- **Query subscriptions** (Child 2): `client.resources.subscribeQuery({ queryType:'parentChild', typeName:'Message', field:'session', value: sessionId })` → ordered membership (`validFrom, resourceId`), **windowed lazy per-resource content subs with grace**, per-id permission recheck, reruns on commit + grant change.
- **Windowed content subs** (Child 2, `nebula-client.ts`): the query sub delivers the full ordered **id** list; content subs open only for a `setRenderWindow(visibleIds)` range; a scrolled-off id is released after a **2000ms grace** (`renderGraceMs`) so scroll-bounce keeps the sub live with no re-subscribe RTT. **Gotcha: `desiredWindow` starts empty — if the UI never calls `setRenderWindow`, NO content hydrates.** So the render component is required, not polish.
- **The codegen loop** (`DevStudio.runCodegenTurn` / `chat`) — a bounded self-correcting **tool** loop that writes source, self-corrects, returns `{ reply, thought }`. **This work adds ONE seam: an `onProgress` callback on `CodegenLoopDeps`** (it emits nothing today — [codegen-loop.ts:140](../apps/nebula/src/codegen-loop.ts:140)); otherwise unchanged except where its output is written (a `Message` Resource). **Note:** `callModel` is a single awaited `env.AI.run(...)` (non-streaming), and `reply` is a *synthesized status string* — the model writes source via tools, not prose. `chat` is **wrangler-dev-only** (container + `env.AI`), so Phase 3 drives the stream via a synthetic-progress harness in pool-workers. See the streaming finding below.

---

## ⚠️ Streaming finding (2026-07-01) — what actually streams is *progress*, not tokens

`callModel` returns the complete response in one awaited call ([dev-studio.ts:655](../apps/nebula/src/dev-studio.ts:655)); the user-facing `reply` is synthesized from the loop outcome ([dev-studio.ts:383](../apps/nebula/src/dev-studio.ts:383)), not model prose (system prompt: "do not output code in your reply", [dev-studio.ts:113](../apps/nebula/src/dev-studio.ts:113)). So **there are no reply tokens to stream today.** What the loop *does* have is discrete **progress/thought steps** (each self-correction iteration, each file written) — the natural streamable content for codegen UX ("writing App.vue… fixing type error… done"), aligned with the model-agnostic thought-process view ([[studio-model-agnostic-naming]]). **Pre-alpha streams progress/thought events**, via option (b). **Token-level prose streaming is deferred** — it needs `callModel` switched to streaming mode and is a poor fit for a tool-driven codegen loop anyway; revisit if/when a non-codegen chat surface needs it.

---

## Cast (participants)

| Participant | What it is |
|---|---|
| **Client** | `NebulaClient` (browser), `resourceHostBinding: 'DEV_STUDIO'`. Subscribes the session query, **creates the user `Message`** (atomic, on Enter), renders the ordered list (windowed content driven by the viewport), fires the codegen kick, and holds an **ephemeral streaming view** it reconciles against the durable assistant `Message`. A coach/UX-designer client is just another subscriber. |
| **DevStudio** | The `{u}.{g}.dev` DO. Hosts the `Session`/`Message` Resources (composed `ResourceDataPlane`), runs the codegen loop, **pushes live progress** to session subscribers via `this.svc.broadcast`, and **creates the assistant `Message`** at completion. |
| **DataPlane** | The `ResourceDataPlane` capability inside DevStudio (Child 1/2) — `Resources` + `QuerySubs` + fanout. Reused as-is, **plus** a new **targeting accessor** (`targetsForQuery`/`targetsForResource`, permission-filtered) so the host can `svc.broadcast` to a subscriber set without re-implementing target computation or the permission recheck. The capability still has **no `this.lmz`/`this.ctn`** — it returns targets; the host delivers. |
| **Model** | The inference engine `DevStudio.callModel` calls (Workers AI; model-agnostic — the *name* is never surfaced, but "Model" is the actor term). Non-streaming: one awaited call returns the complete response. **Appears as an actor in Flow A** (the codegen loop's inference calls). NB: `assistant` is NOT this actor — it is only the message `role` string (`role:'assistant'`, `assistantMessageId`), the Anthropic/OpenAI wire convention. |
| **Galaxy** | **Not a chat-flow participant** — D6 relocated the conversation off Galaxy. Its only remaining tie is the eval corpus (`TurnRecord` via `recordTurn`), whose fate is the open **D-corpus** question; Galaxy re-enters a flow (a dashed `recordTurn` step) only if D-corpus keeps a corpus. Listed here to explain its *absence* from the flows, not as an active actor. |

> Mermaid convention (same as Child 2): solid `->>` = call / one-way message (incl. server→client push); dashed `-->>` = return / callback. Gateway omitted (invariant transport). A **`ctn().method(...)`** in a step is a **continuation descriptor** — built on the sender now, executed on the *recipient* on receipt — NOT a local call whose return feeds the enclosing `svc.broadcast`/`lmz.call` (the full form is `this.ctn<TargetType>().method(...)`).

## Flow A — Send a message + reactive reply (option (b): transient progress stream + durable final Message)

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant DevStudio
    participant Model
    participant DataPlane

    Note over Client: user types, hits Enter (nothing streams before Enter). Client owns the Session id (one session, pre-alpha)
    Client->>DataPlane: transaction(create Message {session:S, role:'user', content, author:myEmail}) — client UUID
    Note over DataPlane: commit → query rerun → fans the user Message to ALL session subscribers (incl. sender)
    DataPlane->>Client: handleQueryUpdate(queryHash, resourceIds += userMessage)
    Client->>DevStudio: chat(sessionId, userMessageId, msg) — fire-and-forget (long-running, ADR-003)
    Note over DevStudio: mint assistantMessageId (UUID). role:'assistant' is the message role, NOT the Model actor
    DevStudio->>DataPlane: targetsForQuery(Message where session==S, sessionNodeId) — permission-filtered
    DataPlane-->>DevStudio: session subscriber targets (per-connection)
    Note over DevStudio: runCodegenTurn loop (self-correcting)
    loop each iteration (progress coalesced into ~200ms flushes)
        DevStudio->>Model: callModel(messages) — infer
        Model-->>DevStudio: tool_calls + text (complete, non-streaming)
        Note over DevStudio: apply tool_calls (write source) → onProgress(step)
        DevStudio->>Client: svc.broadcast(targets, ctn().handleStreamChunk(assistantMessageId, progress)) — transient push
    end
    Note over DevStudio: loop finishes → { reply, thought }
    DevStudio->>DataPlane: transaction(create Message {session:S, role:'assistant', content:reply, thought, status:'complete'}) — assistantMessageId
    Note over DataPlane: commit → query rerun → fans the DURABLE assistant Message to ALL subscribers
    DataPlane->>Client: handleQueryUpdate(queryHash, resourceIds += assistantMessage)
    Note over Client: reconcile ephemeral stream (keyed by assistantMessageId) with the durable Message. No pending Promise
```

## Flow B — History restore on refresh / late join (no special path)

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant DataPlane

    Note over Client: page reload OR a 2nd participant opens the session
    Client->>DataPlane: subscribeQuery(Message where session == S)
    DataPlane->>Client: handleQueryUpdate(queryHash, full ordered resourceIds) — the whole history
    Note over Client: setRenderWindow(visible range) → lazy per-resource content subs hydrate it (Child 2)
```

## Flow C — Completed-while-disconnected (the "thinking forever" fix)

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant DevStudio
    participant DataPlane

    Client->>DevStudio: chat(sessionId, userMessageId, msg)
    Note over Client: WS drops mid-turn (hibernate / network blip) — transient progress chunks are lost, that's fine
    Note over DevStudio: loop finishes regardless → creates the assistant Message (durable)
    Client->>DataPlane: (on reconnect) #resubscribeAll re-fires subscribeQuery
    DataPlane->>Client: handleQueryUpdate — assistant Message now in membership → content hydrates
    Note over Client: reply recovered with no pending-Promise dependency (lost the live animation, kept the result)
```

---

## Decisions (PINNED 2026-07-01 unless marked)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Message = Resource | Each chat message is a `Message` Resource on DevStudio, FK'd to a `Session`; user msg = `role:'user'`, reply = `role:'assistant'`. | Pinned 2026-06-29. Renamed Turn→Message 2026-07-01. |
| D2 | Delivery = the query sub | The **durable** reply arrives as a `Message` via `subscribeQuery(Message where session==S)`, NOT a bespoke `onChatResult` Promise. `#pendingTurns` retires (or demotes to an optimistic echo). | History-restore + disconnect-recovery + multi-participant for free; closes the chat hang structurally. |
| D3 | Who writes which Message | **Client** creates the **user** Message (atomic, on Enter); **DevStudio** creates the **assistant** Message at loop completion. | Both ride the same Session query. |
| D4 | Session entity now | A `Session` Resource exists now; messages FK to it. Pre-alpha ships **one session, no management UI**; the model accommodates many. | Pinned 2026-06-29 — avoids a post-deploy FK migration (one-way door). |
| D-session | Fixed well-known Session id (pre-alpha) | The single session's id is a **fixed, code-defined constant** (a well-known UUID). The `Session` Resource is **created lazily + idempotently** on first chat (create-if-absent under the session node); the client subscribes `Message where session == <constant>` with **no discovery lookup** — the id is a shared constant, so a fresh/late client knows it. Multi-session (many ids + a session list/discovery surface) is deferred with the management UI (D4). | Resolves the D-session-id creation/discovery half. Stable + discoverable without a lookup; unblocks Phases 1/3. Pinned 2026-07-01 (pre-build). |
| D5 | Participants = DAG grants | Membership/visibility = DAG grants; the Child-2 per-id recheck enforces them (**durable AND transient paths — see D-fanout-accessor**). **Pre-alpha: every Message of a session lives under ONE node (the session's node)** — multi-node-per-session is a non-goal (the future "node(s)" plural is deferred). A Galaxy/Universe admin grants non-admin participants directly via the `access.admin` bypass (no DevStudio root-admin seed needed — see [`nebula-dataplane-root-admin.md`](on-hold/nebula-dataplane-root-admin.md)). | Pinned 2026-06-29 / 2026-07-01. Single-node pin resolves Stage-2 M1. |
| D6 | Relocate off Galaxy | The user-facing conversation lives on DevStudio as Resources, not recorded-to-Galaxy-only. | Pinned 2026-06-29. |
| D-streaming | **Option (b): transient progress stream + one durable write** | The assistant's **live progress/thought** rides `this.svc.broadcast(targets, ctn().handleStreamChunk(assistantMessageId, progress))` — fire-and-forget server→client direct delivery, addressed by stable `clientId`, buffered ~200ms. `handleStreamChunk` on the client **must be `@mesh()`-decorated** (a remotely-dispatched server→client push, like `handleQueryUpdate`/`handleResourceUpdate` — n1). The ~200ms buffer is a **deliberate ephemeral cache** whose loss is acceptable (never persisted — persisting defeats option (b)); the flush timer adds no incremental billing since the codegen loop already awaits `env.AI`. At completion, **one** `create` writes the durable `Message`. Client reconciles the ephemeral stream with the durable Message **by `assistantMessageId`**. | Sidesteps the fanout's no-coalescing chatter entirely (no per-chunk Resource writes/reruns). Disconnect degrades gracefully (lose the animation, keep the result via the query sub). The ADR-003 server→client `call()` dividend. **Streams progress, not tokens** (see finding). |
| D-streaming-fallback | (a) is the fallback | If (b) is messy to build, fall back to streaming *as* debounced Resource `put`s: the same-actor-within-60min server-side debounce ([resources.ts:214](../apps/nebula/src/resources.ts:214)) keyed on `changedBy` (the DevStudio caller's `sub`, orthogonal to the `author` string) collapses subsequent puts **in place** — so a streamed message is a **create row + one collapsing-put row** (not literally "one row"), 1 row-write + 0 index-writes per collapsed put, history un-polluted. But the fanout has **no coalescing** ([resource-data-plane.ts:163](../apps/nebula/src/resource-data-plane.ts:163)), so it needs client-side flush + would benefit from a rerun-coalescing capability fix (backlog). | Recorded so we don't re-derive the debounce facts. (b) is preferred. |
| D-ordering | Order by `(validFrom, resourceId)`; accept the tiebreak | Message order = the capability's `ORDER BY validFrom, resourceId` ([resources.ts:283](../apps/nebula/src/resources.ts:283)). A `validFrom` collision falls to the random-UUID `resourceId` tiebreak → non-chronological. **Accepted for pre-alpha (maybe forever):** distinct chat sends are separate transactions with an advancing pinned-per-invocation clock, so they get distinct `validFrom` — a true collision needs two creates in one invocation, which chat never does (each send is its own client transaction; the assistant create is seconds/minutes later). **Rejected: a client-supplied monotonic ULID ordering field** — clock skew across clients makes it *worse*, and it would change the capability's shared `ORDER BY` (blast radius onto Star). Fast-follow only if a strict total order over co-`validFrom` messages is ever needed. | Resolves Stage-2 M5. Cheaper to pin now than post-deploy (one-way-door class, like D4). |
| D-fanout-accessor | Capability exposes **targeting**, host delivers | **SHIPPED**: `targetsForQuery(query, nodeId)` on `ResourceDataPlane` ([resource-data-plane.ts:130](../apps/nebula/src/resource-data-plane.ts:130)) → the permission-filtered `{bindingName,instanceName}[]` (the `evaluatePermissions` read-recheck, `access.admin`-aware, same as `#broadcastQueries`). The host (DevStudio) delivers via `this.svc.broadcast(targets, …)`. **The recheck is NOT optional** (M1): it's the transient path's point-of-action enforcement (ADR-008), symmetric with the durable `#broadcastQueries` recheck — without it the live stream leaks assistant content to a subscriber denied on the node (a no-op today since chat is admins-only, load-bearing the instant D5 non-admins join). Under the D5 single-node pin the single-`nodeId` form is provably correct (message's node == the session's one node). | Keeps the capability's "no `this.lmz`/`this.ctn`" invariant; avoids re-implementing targeting + the recheck host-side; NOT a generic pub/sub bus. Generalizes to typing indicators / cursors / presence. |
| D-window | Viewport-driven windowed content subs | Wire a coarse viewport-driven `setRenderWindow(visibleIds)` now (the mechanism + 2000ms grace already exist, Child 2). Render all, let old scroll off, but only content-subscribe the visible window (+ buffer). | Re-subscribe cost on reconnect / token-cycle = **N open subs**, not total messages ([nebula-client.ts:763](../apps/nebula/src/nebula-client.ts:763) serial re-fire; Gateway force-closes WS on token expiry). Subscribe-all makes that scale with history; windowing makes it ≈ constant. Barely more work than subscribe-all since windowing is built. |
| D-presence | Streaming targets = the query-subscriber set | Stream to the **per-connection** subscriber set of the session query (via `targetsForQuery`) — **no dedup** (every tab wants the stream). A user-visible "who's here" **roster** is separate: dedup **by `sub`**, denormalize onto `Session` (the D5 display list), a later fast-follow. | No separate presence mechanism needed for (b) — reuse what `QuerySubs` already holds. |
| D-human-no-stream | User messages never stream | Enter sends; nothing before. The user `Message` is a single atomic `create`; only the **assistant** path streams. | Standard convention; simplifies the asymmetry. |
| D-attribution | Attribute by **email** (pre-alpha) | Stamp an `author` field (email) on each `Message` at write time. There is **no profile store** (`Subjects` = `sub,email,emailVerified,adminApproved,isAdmin,timestamps`); the JWT carries **`email`** ([types.ts:50](../packages/nebula-auth/src/types.ts:50)), which is friendlier than the raw `sub` UUID; `changedBy` carries only `sub` and a viewer's JWT can't resolve *another* participant's `sub→email` — so identity must ride on the message (or a roster). **`author` is display-only — NEVER key any authz/visibility off it** (all authz stays on DAG grants + server-derived `changedBy.sub`, [resources.ts:212](../apps/nebula/src/resources.ts:212)); it's spoofable (m1). The "admins-only makes the spoof safe" claim holds because the user-Message `create` is DAG-write-gated ([resources.ts:507](../apps/nebula/src/resources.ts:507)), not merely because `chat()` is admin-gated. Friendly-name + avatar = fast-follow (backlog). | User-friendly enough for pre-alpha; testers won't tolerate UUIDs. |
| D-pending | Fold "thinking…" into `status` | No separate pending-Promise / placeholder decision: a pending assistant message is just a `Message` with `status:'thinking'`/`'streaming'` (or, in (b), a purely local ephemeral view until the durable `create`). | Streaming subsumes D-pending. |

## Resolved in Stage-2 (2026-07-01)

- **Progress-vs-tokens — CONFIRMED.** Pre-alpha streams *progress/thought events* (the reply is a synthesized status, the model call is non-streaming); token-level prose streaming is deferred.
- **Node placement (was part of D-session-id) — PINNED single node per session** (D5) → resolves M1; the `targetsForQuery(query, nodeId)` single-`nodeId` recheck is correct and required.
- **Ordering — PINNED `(validFrom, resourceId)`, accept the tiebreak** (D-ordering) → resolves M5.
- **Streaming target refresh — FROZEN per turn.** Targets are fetched once per turn; a mid-stream joiner misses in-flight chunks but gets the final Message via the query sub + all *future* turns' live progress (m2). Phase 6 wording synced to this (a joiner "sees history + the NEXT turn's live progress", not in-flight chunks of the turn already running).

## Open questions (genuinely open — resolve before "go")

- **D-corpus — `Message` Resource vs Galaxy `TurnRecord`.** The eval corpus (`systemPrompt`, `toolCalls`, `reasoning`, `validate`, `model`) has a different shape than a chat `Message` (`role`, `content`, `author`, `thought`, `status`). Coexist (FK-linked?), subsume, or leave the corpus on Galaxy untouched and move only the conversation? The Turn/Message name split leans "coexist, different concepts."
- **D-echo — optimistic user-Message echo** (Phase 4 concern; does NOT block Phases 0–3). Does the sender optimistically render its own user Message before the rerun confirms, or wait for the fanout? Interacts with the engine's optimistic/rollback machinery. **Pre-alpha default if unresolved at Phase 4: wait for the fanout** (simplest; the rerun is fast); optimistic echo is a later enhancement.
- **D-attribution trustworthiness (hardening fast-follow).** A client-supplied `author` is spoofable; safe now only because the `create` is DAG-write-gated + chat is admins-only. Derive/validate against `originAuth.email` server-side before any non-admin can write a Message.
- **Cost of per-message writes.** Each message = a Resource create (~1000× a read). Acceptable at pre-alpha scale; note it.

---

## Build phases (DRAFT — re-derive after Stage-2 review)

Each phase independently testable on DevStudio via a real `NebulaClient` (`resourceHostBinding:'DEV_STUDIO'`), mirroring the Child-2 e2e harness.

- **Phase 0 — Ontology: `Turn`→`Message` + enrichment. ✅ DONE 2026-07-01 (uncommitted).** Renamed `Turn`→`Message` across source + tests + all `SESSION_TURN_*` symbols → `SESSION_MESSAGE_*` (`_ONTOLOGY_VERSION`, `_TYPES`, `_BUNDLE_ID`); added `status?`, `thought?`, `author?` — **all three OPTIONAL** (a user message pre-sets none; `status ∈ {thinking,streaming,complete,error}` kept as `string`, not a second schema language; making it *required* would break every `{session,role,content}` create — divergence from the earlier "status" phrasing). Version bumped `session-turn-v1`→`session-message-v1`; bundle-id `/v1`→`/v2` (types changed → force a warm-loader recompile; M2 disjointness JSDoc still holds). *Verified:* `devstudio-resource-ontology.test.ts` 2/2 green (`Message.session` to-one relationship + bundle-id disjointness); `tsc` clean except 3 **pre-existing** `child2-query-e2e.test.ts` `eTags`/`TransactionOutcome` indexing errors (predate this session, unrelated to the rename — flagged for a separate cleanup).
- **Phase 1 — Session creation (D4/D-session). ✅ DONE 2026-07-01 (uncommitted).** `DEFAULT_SESSION_ID`/`SESSION_NODE_ID` constants + `ResourceDataPlane.ensureResource` (server-internal create-if-absent, no client delivery) + `DevStudio.ensureSession` (`@mesh(requireAdmin)`, called at the top of `chat`). *Verified* (`child3-session.test.ts`, 2/2): fresh sandbox → seeded under `SESSION_NODE_ID`; **2nd ensure does NOT throw "already exists"** (the guard turns a raw create-on-existing throw into a clean no-op — matters since it runs every `chat`); fixed id → `subscribeQuery(Message where session==DEFAULT_SESSION_ID)` tracks a Message with no discovery lookup.
- **Phase 2 — `targetsForQuery` per-operand tests (M4). ✅ DONE 2026-07-01 (uncommitted).** Built `DevStudioTest` (subclass, rebound `DEV_STUDIO` in the baseline wrangler — the `StarTest` pattern) + a protected `DevStudio.queryTargets` seam. *Verified* (`child3-targets.test.ts`, 1/1, **mutation-checked**): admin@ (access.admin bypass, no grant) IN, read-granted non-admin IN, read-denied non-admin OUT, `targets.length===2`. Mutation (drop the recheck → target all) confirmed red.
- **Phase 3 — Assistant progress stream + durable Message (option b). ✅ DONE 2026-07-01 (uncommitted).** `CodegenLoopDeps.onProgress` seam (fired per-round + per-write); protected `DevStudio.streamProgress` (permission-filtered `svc.broadcast(handleStreamChunk)`) + `commitAssistantMessage` (durable create-if-absent); `chat` wired (mint id → stream → commit); client `handleStreamChunk` (`@mesh()`) + `#streamingMessages` ephemeral cache + reconcile-by-id in `handleResourceUpdate` + `streamingProgress()` getter. Test driven via `DevStudioTest.streamChunkForTest`/`commitAssistantForTest` (synthetic progress; real `chat` is wrangler-dev-only). *Verified* (`child3-stream.test.ts`, 2/2, **both mutation-checked**): **M3a** chunk observed before durable membership; **M3b** ephemeral reconciled away by id on the durable content push (mutation: disable reconcile → red); **M1** denied-on-node subscriber gets ZERO chunks (mutation: drop recheck → red).
- **Phase 4 — Client posts the user Message + kicks codegen (D3/D-human-no-stream/D-echo). ✅ DONE 2026-07-01 (uncommitted).** `NebulaClient.postUserMessage` (split out of `chat` — the create half, since full `chat` also fires the wrangler-dev-only codegen kick) writes ONE atomic `role:'user'` Message with `author=this.claims.email`; `chat` awaits it then fires codegen. No optimistic echo (D-echo default: sender sees its own via the fanout). *Verified* (`child3-post.test.ts`, 1/1): sender + a 2nd subscriber both converge on `[m1, m2]` in send order; role/author/node stamped; `streamChunkCount===0` (D-human-no-stream, capable-of-failing). **Refactor divergence:** the session constants moved to a **client-safe leaf `chat-constants.ts`** (imports only `./dag-ops`) — importing them from `devstudio-resource-ontology.ts` (which reaches `cloudflare:workers` via `./galaxy`) into the browser-bundled `nebula-client.ts` would break the `./client` bundle, and pool-workers masks it (packaging.md).
- **Phase 5 — Viewport window wiring (D-window). ✅ MECHANISM VERIFIED; UI driver deferred.** The windowed-content-sub + 2000ms grace **mechanism is Child-2 capability code** (`child2-query-window.test.ts`) and is already exercised on DEV_STUDIO (`child3-stream` drives `setRenderWindow([messageId])` → the content sub → reconcile). The genuinely-new Phase-5 deliverable — the **viewport→`setRenderWindow` driver** (IntersectionObserver / virtual-scroll feeding visible ids) — is Vue/DOM code that lives with the Studio chat UI and is **not pool-workers-testable**; deferred to that UI work. No redundant test manufactured (build-task thin-phase guidance). Reconnect-re-fires-window is a Child-2 `#resubscribeAll` behavior (re-fires only *active* subs = the windowed set).
- **Phase 6 — History-restore + multi-participant + disconnect-recovery e2e (Flow B/C). ✅ DONE 2026-07-01 (uncommitted).** *Verified* (`child3-e2e.test.ts`, 1/1): a mini conversation (user→assistant→user→assistant) built from durable Messages; a **late-joining participant** (received ZERO ephemeral pushes) subscribes and restores the FULL ordered `[u1,a1,u2,a2]` with alternating roles + intact content + `streamChunkCount===0`. That one property IS all three fixes at once (history-restore = a fresh subscribe; "thinking forever" recovery = the reply is a durable Message via the query sub, no pending-Promise/ephemeral dependency; multi-participant). The ephemeral `onChatResult` path is thereby **demoted** to a live-only optimization (durable Message = source of truth); left in place for the transition (removal is a low-risk later cleanup). *(A literal mid-turn WS-drop force + the frozen-per-turn mid-stream joiner (m2) are wrangler-dev/browser-lane concerns; the recovery property they test reduces to the late-joiner durable-restore, which is covered here.)*

### Final verification (every phase)
- `npx vitest run` (pool-workers) green + `tsc --noEmit` clean. **Capable-of-failing + mutation-verified**, per-operand for compound gates (Phase 2), and **on the transient surface** for the stream/reconcile (Phase 3 — an end-state assertion self-heals via the durable rerun; assert the pre-durable window + mutate to red).
- Reuses the Child-2 capability + windowing unchanged, **plus** the shipped `targetsForQuery` accessor + a new `CodegenLoopDeps.onProgress` seam — wiring the chat loop onto the substrate.
- Nuggets → `nebula-pre-alpha.md`; archive on landing.

## Spun-off backlog items (log during/after build)
- **Capability targeting accessor** (`targetsForQuery`/`targetsForResource`) — built here for streaming; generalizes to typing indicators / cursors / presence pings. Mesh/DataPlane capability feature, Nebula as first consumer.
- **Fanout rerun-coalescing (optional, NOT cheap).** Skip the query-membership rerun when a commit changed only existing-member *content* (not membership) — [resource-data-plane.ts:163](../apps/nebula/src/resource-data-plane.ts:163) fires `#broadcast` + `#rerunQueriesForCommit` unconditionally. Real fanout-core surgery (per-mutation × per-query membership-delta detection, with a correctness trap on create/delete/move). Only needed if we ever pick the (a) fallback; (b) sidesteps it.
- **Profile store (friendly name + avatar) — fast-follow.** No name/avatar exists in `nebula-auth` today. Add a profile store; attribution then resolves `sub→profile`; the D5 roster (dedup by `sub`) is its home + doubles as presence.
