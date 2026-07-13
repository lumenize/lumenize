# Presence subscription — generic data-plane subscriber-set subscription

**Status**: **⏸️ PAUSED (2026-07-08), pending the identity-store design.** Reframed from "single-node scope" to **generic** after [ADR-008](../docs/adr/008-full-org-tree-visibility.md) was extended to presence (2026-07-08): within a Star, *who is actively subscribed to a resource/query is visible to any member*, gated by **Star reachability, not per-resource read**. That **removes** the read-gate + per-viewer set-filtering the conformance check demanded (its B1/B2) — so the generic capability is *simpler* than the single-node one, not harder. **Blocked on identity:** the set this delivers is bare `sub`s; resolving `sub → { email, friendlyName }` for display is a **separate identity store we have not designed** — the reason multi-user chat + this are paused. **LEADS** [nebula-chat-history-multiuser.md](nebula-chat-history-multiuser.md); needs `/review-task` before build. Child of [nebula-pre-alpha.md](nebula-pre-alpha.md).

## Objective (target, present tense)
A client can **subscribe to the live subscriber set of any query it can reach** (single-resource subscriptions a later add), delivered reactively and re-pushed on join/leave. The set is **bare `sub`s**; the client resolves each `sub → display identity` via the separate **identity subscription** (see Dependencies). A **generic `ResourceDataPlane` capability** — Star + DevStudio (and any future host) compose it. First consumers: chat's participant roster, and later the org-tree UI ("who has read/write/admin", "who's viewing this").

## Why generic + no read-gate (the ADR-008 extension, own the reversal)
The earlier single-node scope existed to dodge two conformance findings — a flat multi-node set "leaking" co-subscribers (B1), and a missing "read of a query" gate (B2). Both dissolve under the ADR-008 principle, deliberately extended to presence:
- **The tree is already Star-public.** Every member already sees all nodes, slugs/labels, and every `sub → tier` grant ([dag-tree.ts](apps/nebula/src/dag-tree.ts) `getState()` ships the lot). So presence can leak **nothing structural** that isn't already on-screen — it adds only the **behavioral** increment "who is watching *now*."
- **Visibility ≠ capability.** Seeing who's subscribed to a resource confers no ability to read or mutate it. So presence-of-Q needs **no per-resource read-gate** — the only boundary is **Star reachability** (you must be able to reach the host, already enforced at the Star edge / `onBeforeCall` aud-lock). Cross-Star stays closed by that boundary.
- **Simpler, not harder.** No per-viewer set-filtering (B1's "fix" — the denormalization we don't want), no net-new query-read gate (B2). The flat subscriber set, gated by reachability, *is* the design.
- **Advisory / display-only** — the set MUST NOT gate any capability. A per-push recipient read-recheck is **not** needed (there is no read-gate to lose); the recheck the check suggested was a consequence of the now-removed gate.

## The set is `sub`s — identity is a SEPARATE store (the pause)
Presence tracks and delivers **`sub`s only**. Resolving `sub → { email, friendlyName }` is a distinct concern with its own store + access pattern, **not yet designed** — and it's shared by presence, the org-tree UI, and chat authorship, so we're designing it once rather than accreting an email-only interim on subscriber rows (which the single-node draft did as a migration — **dropped**). This is why the whole thread is paused. When identity lands, the client joins the presence `sub`-set against the identity subscription locally (avoids denormalizing names onto the presence push). **Do not resume this task until the identity store is designed.**

## How it works (mechanism — the surviving pins)
A third registry + a bridge method + a cleanup handler, mechanical clones of the existing query-membership push (`svc.broadcast` is payload-agnostic — [broadcast.ts](packages/mesh/src/broadcast.ts)):
- **Separate `PresenceSubs` registry** (own table/keying) — **never the data-query tables.** A presence registration must not enter the commit/rerun scan, or a presence push becomes a subscriber the next commit re-pushes to (an invisible loop). Table-separation breaks the echo.
- **Subscriber identity from `callChain`, never params** — you register *your own* presence; the target query is client-named (fine — any reachable query). Reachability is the only gate.
- **Re-push from the DATA-subscriber lifecycle** (`doSubscribeQuery` / `removeQuerySubscriber` in [resource-data-plane.ts](apps/nebula/src/resource-data-plane.ts)), NOT presence-registration — the set's contents are the data-subscriber rows, which change at join/leave; a naive "push on presence-registration" never updates existing rosters.
- **Delivery** via `svc.broadcast` with a new `broadcastPresenceUpdate` bridge method + `onPresenceBroadcastResult` cleanup handler (**public + `@mesh()`**). Push shape byte-identical to `#broadcastQueries`; do **NOT** overload `broadcastQueryUpdate` (its cleanup reaps the wrong table).
- **Stale entry** on ungraceful disconnect is reaped via the existing `ClientDisconnectedError → removeQuerySubscriber` path on the next broadcast (bounded, lazy — a pure leave on a quiet resource is observed only when a broadcast next attempts delivery).

## Phases (skeleton — refine at `/review-task`, after identity)
1. **`PresenceSubs` registry + reachability-gated subscribe + set delivery (backend)** — separate table (no echo), subscribe returns the current `sub`-set, subscriber identity from `callChain`.
2. **Re-push wired to the data-subscriber lifecycle** — `doSubscribeQuery`/`removeQuerySubscriber` fire `#broadcastPresence`; delivery via `svc.broadcast` + `@mesh()` cleanup handler.
3. **Genericity coverage** — core reds run on **both** Star and DevStudio (they compose the same `ResourceDataPlane` but diverge at the org-tree-broadcast vs no-op seam).

## Success criteria (capable-of-failing — sketch)
- [ ] A presence subscribe writes only to `PresenceSubs`; it does NOT increment the data-query rerun count (debug-sink transient marker — the no-loop invariant, not just the idempotent converged set).
- [ ] A second data-subscriber joining (and a leave/disconnect) re-pushes the updated `sub`-set to existing presence-subscribers — fired from the data-subscriber lifecycle, not presence-registration (wire it to presence-registration → an existing roster never updates → must red).
- [ ] **Reachability is the only gate**: a member of the host Star can subscribe to any query's presence; a caller who cannot reach the host (cross-Star) is refused at the boundary (must red). No per-resource read-gate.
- [ ] Delivery rides `svc.broadcast` with a public `@mesh()` `onPresenceBroadcastResult`; push shape byte-identical to `#broadcastQueries`; does not overload `broadcastQueryUpdate`.
- [ ] Core reds run in the **Star** resource test-app too (not only DevStudio); `it.skip` with the blocker named if deferred, never silent.

## Non-goals
- **Per-resource read-gate + per-viewer set-filtering** — REMOVED per the ADR-008 extension (they were the single-node draft's B1/B2 mitigations; the reversal deletes them).
- **Identity resolution** (`sub → email/friendlyName`) — the separate identity store; presence delivers bare `sub`s.
- **Single-resource presence** (vs query presence) — a later add on the same registry.
- **Presence UI** (online/typing/read-receipts) + **anti-flap / debounce** — later; build the debounce only when a roster is displayed and the WS-toggle flapping annoys people (likely client-side, only-when-displayed).

## Files
- [subscriptions.ts](apps/nebula/src/subscriptions.ts) / [query-subscriptions.ts](apps/nebula/src/query-subscriptions.ts) — the new **`PresenceSubs`** registry (separate table). **No `email` migration** (identity is its own store now).
- [resource-data-plane.ts](apps/nebula/src/resource-data-plane.ts) — `subscribePresence` (register + initial `sub`-set push), `#broadcastPresence` fired from `doSubscribeQuery`/`removeQuerySubscriber`; `ResourceHostBridge` gains `broadcastPresenceUpdate`.
- [dev-studio.ts](apps/nebula/src/dev-studio.ts) + [star.ts](apps/nebula/src/star.ts) — `onPresenceBroadcastResult` cleanup handler (public + `@mesh()`), templated on the existing `on*BroadcastResult`.

## Dependencies / relationship
- **BLOCKED on the identity store** (`sub → { email, friendlyName }` + its access pattern) — undesigned; that discussion is the current priority. Presence's *`sub`-set* mechanism is independent of it, but we're not resuming until identity is settled so the delivery shape (bare subs + a separate identity join) is decided together.
- **LEADS** [nebula-chat-history-multiuser.md](nebula-chat-history-multiuser.md) — chat's Phase 2 subscribes to a query's presence for its roster, and resolves names via the identity store.
- **ADR-008** amended 2026-07-08 to cover presence (Star-reachability-gated subscriber visibility); more edits expected as this is built.

## Verification
Capable-of-failing vitest per criterion (presence is net-new — none inherit mutation-validation from a green neighbor). The no-loop and stale-reap checks assert the **transient** surface (push-count / stored-row presence), not just the converged roster (testing.md §25). Backend units only.
