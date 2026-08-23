# Every Resources guard lives in the Resources plane

**Status:** Pass 1 — design intent only, phases NOT written. **The Resources leg of the security-legibility work**, after `docs/vision/auth.md`, [ADR-015](../docs/adr/015-passage-and-dominion.md)'s passage/dominion vocabulary, and the Registry routing rewrite that put its guards in one readable table. **Sequenced AFTER [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md)** (decided with Larry 2026-08-23) — § *Transition* says why, and names the one interim that task carries in the meantime. Judge this as a change to how the access-control model is reasoned about, not as a refactor.

**Objective — answering *"who is allowed to do this to a resource?"* takes reading one bounded region of code.**

**Three goals, in the order they matter:**

1. **The answer stops being split across the host and the plane.** Today it is in seven places: `requirePassage` in `onBeforeCall`, 26 `requireDominionHere` decorators, **34 identity derivations inside host method bodies**, 5 permission calls inside `Resources`, 3 inside `Subscriptions`, none in `QuerySubs` (which filters at delivery instead), and 30 sites in `DagTree` including the dominion short-circuit. Seven places is not an audit, it is an archaeology.
2. **No guard sits where a reader would not think to look.** Those 34 derivations are not plumbing. `clientId` decides whose subscriber row is written and whose row a delete removes, and the code says so: *"`clientId` is supplied by the Handler-1 wrapper from `callChain[0]` (NEVER a param), so a client can only drop its OWN row."* That is a guard, it lives on the host, and it is copied per host — `unsubscribe` matches statement-for-statement across `star.ts` and `dev-studio.ts`.
3. **Every name answers "what is this?" without being asked.** `Resources` today is a 649-line temporal storage engine *inside* a thing called `ResourceDataPlane`, and `QuerySubs` opens by calling itself *"a near-clone of `Subscriptions`"*. Names you have to ask about are a model you cannot hold.

The sections below give the guard model these goals imply, the one consequence that sets how far the task reaches, and the question that has to be answered before phases.

## Context and current state

**Built already, and what becomes of each part:**

- **`ResourceDataPlane`** — one class, composed by a host with a single `new`, holding five sub-capabilities. **Adapted**: it becomes the plane itself and takes the name, so a host reads `#resources = new Resources(...)`.
- **`Resources`** (649 LOC) — the **temporal storage engine**: Snodgrass snapshot sequences over the host's SQLite, calling `DagTree.requirePermission` at 5 sites. **Adapted**: keeps its job, gives up its name.
- **`DagTree`** (526 LOC) — nodes, edges, grants, resolution, and the `hasDominionOver` short-circuit. **Carried over unchanged**, and it is the model the rest should match: its guards are already in the methods they protect.
- **`Subscriptions` (263) · `QuerySubs` (204) · `QuerySubscriberListSubs` (91)** — three registries of one kind, differing in what they key on. **Adapted into one**, so a caller stops having to know there are three and union them by `(subscriberBinding, clientId)`.
- **The per-host data-plane entries** — roughly 16 bare `@mesh()` methods per host that derive `clientId`/`subscriberBinding`, fail closed, then dispatch. **Left behind**: the derivation moves in, and one bare gate replaces all of them.
- **The host capabilities** — `setOntology`, `installOntology`, `resetDevData`, `setStarConfig`, `chat`, `writeSource`. **Carried over unchanged** with their `requireDominionHere` decorators; they are not Resources operations.
- **`invite`, the three `on*BroadcastResult` reapers, and the eviction drains** — host code acting on a *third party's* rows. **Adapted — and they are the reason this task follows the collapse rather than preceding it** (§ *Transition*).

## Design intent, constraints, and future state

**The contract, in two sentences. A host's only guard for a Resources operation is `onBeforeCall`, which requires passage and decides nothing else. Every other guard — identity, permission, ownership — lives in the method it protects, inside the plane.**

**One bare gate.** A host composes the plane as `#resources = new Resources(...)` and exposes a single `@mesh() resources()` returning it, doing nothing else. A `@mesh(guard)` remains available to any host that needs one; this plane does not need one, because its methods cover themselves. ❓ **Open — does `@mesh() dagTree()` survive beside it?** Today's hosts expose that gate and the client's ten `orgTree` mutators chain it. Keeping it costs nothing and leaves two doors; folding it in as `resources().dagTree.setPermission(...)` — **no parens, it is a getter** — leaves one, and costs those ten call sites plus the harness. One door is the truer reading of the contract, so the question is really whether the sweep is worth doing in the same pass.

**Guards go IN the method, not in a chain before it.** The Registry's route table works because its steps are uniform and orderable — `steps: [connectionRateLimitGuard, turnstileGuard, forwardRaw]`. A Resources operation is not like that: `transaction` carries genuinely intricate logic, from ADR-005 eTag currency to per-op DAG checks across a batch to ADR-006 reference rewriting, and lifting its guard out of its body would make both halves harder to read. **What this buys is locality, not tabulation** — the answer is never in another file, and never on the far side of the mesh boundary.

⚠️ **Self-guarding forces one consequence, and it is what sets the task's reach.** A method that derives its caller cannot also accept a `clientId`, because over the wire that argument is forgeable and the plane cannot tell an internal call from a remote one. **So an operation acting on a third party's rows becomes `#private`, and its caller moves inside with it.** That is `invite` (which reaches `dagTree` and `findCurrentByField`), the three reapers (which carry a dead client's id off `ClientDisconnectedError`), and the eviction drains. They are not swept in for tidiness: leaving any of them out leaves a forgeable parameter on the wire.

**Load-bearing claims, stated so review can falsify them:**

- **No data-plane entry carries `requireDominionHere` today.** Every one is a bare `@mesh()`, so deleting the entries weakens nothing. Measured by reading all 44 decorators across both hosts.
- **The duplicated derivations are identical, not merely similar.** `unsubscribe` matches statement-for-statement; `subscribe` shares 11 statements and `transaction` 7.
- **The plane can already see what it needs.** `getCallContext` is a constructor argument it holds and threads into all five sub-capabilities.
- **The client's public surface keeps its name.** `client.resources.transaction(...)` is the app author's vocabulary and its audience is Studio's codegen model; every rename here is internal.

**Open question — `QuerySubs` registers with no check at all, and that is deliberate.** Its own comment records that `registerQuerySubscriber` *"always succeeds — no permission check"*, with authorization applied at **delivery** through `targetsForQuery` → `evaluatePermissions`. That is what lets [ADR-008](../docs/adr/008-full-org-tree-visibility.md) disclose a denied set rather than hide it. Under "every method guards itself" this is either an exception stated loudly at the method, or a design to change. **It gates the shape of the registry merge**, so it is answered before phases rather than during them.

**Constraints.** [ADR-007](../docs/adr/007-shared-node-security-core.md) — a node's comms and guards core is composed rather than inherited; this applies the same idea one level down. [ADR-008](../docs/adr/008-full-org-tree-visibility.md) — enforcement at the point of action, never secrecy, which is what makes a delivery-time filter legitimate rather than a gap. `mesh.md` § *Object-capability access: gate once, then chain* is the gate mechanism. `security.md` governs the fail-closed behaviour that must survive the move unchanged.

**Future state.** A node type that composes the plane inherits a complete access-control boundary, so standing up the next host is a `new` and a gate. ⚠️ **Design consideration:** once every guard is local, a per-op guard table becomes something *generated from* the code rather than a second copy to keep in sync — worth revisiting after this lands, never before.

## Transition

**This task runs AFTER the Galaxy collapse, and makes one pass over a settled pair of hosts.** The collapse folds `DevStudio` and `DevContainer` into `Galaxy`; this task then starts from two hosts that are not about to move again and ends at the contract above, with no half-moved state along the way.

**Why not first.** Self-guarding pulls three callers inside, and two of them are the collapse's own work: `invite` has to be reachable on the Galaxy for the invited collaborator (its Phase 1), and eviction cannot become uniform until the Galaxy holds an installed ontology version (its Phase 2). Going first would land the 34 identity derivations and leave `invite`, the reapers and the drains outside — so the contract in § *Design intent* would be false for however long the collapse ran, and a half-moved guard model is harder to reason about than today's. The original argument for going first was to keep the collapse's Phase 1 a fold rather than a refactor; that argument expired when Phase 1 grew the `invite` move and the gate.

**What the collapse carries instead — one named interim with a removal event.** `invite`'s body and `onInviteResult` move into the plane during the collapse, so the *security logic* is written once and no host copies it. Each host then reaches them through a thin `@mesh() invite()` / `@mesh() onInviteResult()` that forwards and does nothing else — four three-line entries across `star.ts` and `galaxy.ts`, labelled `TEMP → target=resources() gate`. **This task deletes all four**, and that deletion is the removal event. ⚠️ The collapse therefore does **not** build the gate or delete the per-method entries; that work is this task's, and its Phase 1 was rewritten on 2026-08-23 to hand it over.

**Leaving the derivations duplicated for longer costs nothing, and that is measured rather than assumed** (2026-08-23). The worry was that the fold would re-type the ~16 data-plane entries into a new class and let the two copies drift before this task arrived to merge them. It does not. Every guard-bearing line in those entries reads `this.lmz.callContext.callChain[0]?.instanceName` or `.at(-1)?.bindingName`, which names no host and so travels byte-identical; the only host-typed text anywhere in the region is three `ctn<DevStudio>()` continuations, all of them inside `#private` broadcast helpers rather than in a `@mesh()` entry, plus one debug label and two comments. The fold is a move, so the copies that exist today are the copies this task will find.

**What this task inherits, and confirms rather than builds:** a single `Galaxy` composing the plane, an installed ontology version on it (so the staleness check and evict-on-version-change are the same code on both hosts), `invite` and `onInviteResult` already living in the plane, and `dagTree()` already standing as the gate exemplar on both hosts.
