# The data plane carries its own guards

**Status:** Pass 1 — design intent only, phases NOT written. **Prerequisite detour for [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)**, spun out 2026-08-21 so the collapse folds an already-clean class instead of refactoring and folding in one phase. Nothing here is gated on the collapse; it stands on its own and `Star` gets the benefit immediately.

**Objective — the checks that decide *who* a data-plane call is for live INSIDE the composed data plane, so a host that grafts it on gets them already correct.**

**Three goals, in the order they matter:**

1. **Security-adjacent code exists once.** Today the identity extraction and its fail-closed throws are copy-pasted per host: `unsubscribe` is **8 of 8 statements identical** between `star.ts` and `dev-studio.ts`, `subscribe` shares 11, `transaction` shares 7. Two copies of a check that decides *whose* subscriber row is written can drift, and nothing reds when they do — both still compile and both still throw something.
2. **Guards travel with the capability.** `ResourceDataPlane` is composed, and the collapse is about to compose it onto a second long-lived host. A guard that lives on the host has to be re-typed at every graft — which is exactly when two copies stop agreeing.
3. **A host's `@mesh()` entry does host-specific authorization, or it does not exist.** Once the boundary work moves down, ~16 entries per host would be one-line forwards to the composed instance — the per-method shim `calibration.md` § 11 names, and the pollution Larry rejected in so many words: *"Creating all of these thin methods is silly."*

## Context and current state

**Built already, and what becomes of each part:**

- **`ResourceDataPlane`** (`resource-data-plane.ts`) — composed by `Star` and `DevStudio`, constructed with `getCallContext: () => CallContext` which it already threads into `DagTree`, `Resources`, `Subscriptions` and `QuerySubs`. **Carried over, and extended**: it gains the boundary work its own sub-capabilities already do for themselves.
- **The per-host data-plane entries** — `transaction`, `read`, `subscribe`, `unsubscribe`, `subscribeQuery`, `unsubscribeQuery`, the query-subscriber pair, `subscribeTree`, `subscribeReload`, `dagTree`, and five `on*BroadcastResult` continuation targets. **Left behind**: deleted, not converted to forwards.
- **`dagTree()`** — a host method returning `this.#dataPlane.dagTree`, documented as *"Single `@mesh()` entry for the DagTree API (per-op auth inside DagTree)."* **Adapted**: the pattern is right and becomes the model; the method itself is subsumed by one gate.
- **The host capabilities** — `setOntology`, `installOntology`, `resetDevData`, `setStarConfig`, `invite`, `chat`, `writeSource` and the rest. **Carried over unchanged**, with their own guards and their own bodies. None is thin; none is in scope.
- **Three authorization points below the entry, all real and all different.** `transaction`/`read` reach `Resources`, which calls `DagTree.requirePermission` per op. `subscribe`/`unsubscribe` reach `Subscriptions`, which does the same. **Query subscriptions authorize at DELIVERY, not registration** — `registerQuerySubscriber` *"always succeeds — no permission check"* by design, and `targetsForQuery` filters each push through `dagTree.evaluatePermissions(...)`. **All carried over unchanged.** This variety is the thing a mover must not flatten.
- **Three bulk wipes with no check at any depth** — `clearSubscribers`, `clearQuerySubscribers`, `clearWatchers`. **Adapted**: today they are **not reachable over the mesh at all** — no `@mesh()` entry names them, and their only caller is `Star`'s **private** `#installState`, reached from `setOntology`/`installOntology` under `requireDominionHere`. Being public on `ResourceDataPlane` is what puts them behind the new gate.

## Design intent, constraints, and future state

**The contract: a host's `@mesh()` entry is an authorization decision or it is not written at all. Everything else about a data-plane call — who the caller is, which gateway to answer through, whether the request is well-formed enough to act on — is the capability's own business, decided once, wherever it is composed.**

**One gate per host, and callers chain.** Each host exposes `@mesh() resources()` returning the composed instance; a caller reaches an operation as `ctn<Host>().resources().transaction(...)`. This is the object-capability model `mesh.md` § *Object-capability access: gate once, then chain* already documents and `dagTree()` already demonstrates — the entry `@mesh` is the only allowlist check, so everything behind the gate authorizes itself.

⚠️ **`dagTree` is a getter on `ResourceDataPlane`, so a chained call takes no parens.** `resources().dagTree.setPermission(...)` records a `get`; adding parens records an `apply` on a `DagTree` instance, which `ocan/execute.ts` throws on. The criteria and the client's mutators must name the same chain.

**Moving a check down does not widen exposure; INTRODUCING a gate can, and exactly once.** Every entry being deleted is already a bare `@mesh()` reachable by any caller with passage — `onBeforeCall` provides that gate today and continues to — so relocating those checks changes *where* they run, never *who* can reach them.

⚠️ **The exception is real and is the sharpest thing in this task: the gate makes every PUBLIC method on `ResourceDataPlane` mesh-reachable, and three of them are not reachable today at all.** `clearSubscribers`, `clearQuerySubscribers` and `clearWatchers` are internal helpers behind a private caller; `resources()` puts them on the wire for the first time. They are bulk wipes of subscriber state, so each needs its own check before the gate exists — not after. **The general form of the obligation, which outlives these three: every public member of `ResourceDataPlane` is a mesh entry once the gate lands, so audit what the gate returns as a whole rather than working from a list of three.**

**Load-bearing claims, stated so review can falsify them:**

- **The duplicated code is genuinely identical, not merely similar.** `unsubscribe` matches statement-for-statement across both hosts; the shared portion of `subscribe` and `transaction` is the `clientId`/`subscriberBinding` extraction and its throws.
- **The data plane can already see what it needs.** `getCallContext` is a constructor argument it holds and passes on; nothing new has to be plumbed.
- **The guard distribution splits cleanly.** Of 44 `@mesh()` methods across the two hosts, **not one** data-plane entry carries `requireDominionHere`; every method that does is a host capability doing real work. Measured 2026-08-21 by reading each decorator and body.
- **Only three methods are one-statement forwards today** — `dagTree` on each host, and `ensureSession`. The other 41 do work. This task's deletions are what would *create* the rest.

**What stays out, and why it is not merely deferred:** the ontology **staleness** check (`appVersion`) is not uniform across the hosts yet — `Star` enforces it through `#isCachedVersion` while `DevStudio` writes `void appVersion` because it has one fixed ontology. Making them uniform needs the Galaxy to hold a real installed ontology version, which the collapse's ontology work delivers. Moving it now would mean inventing a per-host policy flag and deleting it a fortnight later.

**Constraints.** [ADR-007](../docs/adr/007-shared-node-security-core.md) — the comms and guards core is composed, and storage-shaped things are per-type capabilities; this task is that principle applied one level down, to the data plane's own boundary. `mesh.md` § *Object-capability access* specifies gate-once-then-chain and the discipline that comes with it. `calibration.md` § 11 records the bias this corrects. `security.md` governs the fail-closed behaviour that must survive the move unchanged.

**Future state.** After this, a node type that grafts on `ResourceDataPlane` inherits a correct boundary with no per-host code, which is what makes the collapse's Phase 1 a fold rather than a refactor. ⚠️ **Design consideration:** the data plane's internal names (`doTransaction`, `doSubscribe`, `doRead`) become the client-facing surface once they are reached through the gate — renaming them to the wire names belongs with this work rather than after it, or the public API reads as internals.
