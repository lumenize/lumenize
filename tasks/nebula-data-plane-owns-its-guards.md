# Every Resources guard lives in the Resources plane

**Status:** Pass 1 — design intent only, phases NOT written. **The Resources leg of the security-legibility work**, after `docs/vision/auth.md`, [ADR-015](../docs/adr/015-passage-and-dominion.md)'s passage/dominion vocabulary, and the Registry routing rewrite that put its guards in one readable table. ⚠️ **Sequencing against [nebula-galaxy-collapse-and-chat.md](nebula-galaxy-collapse-and-chat.md) is OPEN** — § *Transition* holds the question. Judge this as a change to how the access-control model is reasoned about, not as a refactor.

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
- **`invite`, the three `on*BroadcastResult` reapers, and the eviction drains** — host code acting on a *third party's* rows. **Adapted, on timing that § *Transition* decides.**

## Design intent, constraints, and future state

**The contract, in two sentences. A host's only guard for a Resources operation is `onBeforeCall`, which requires passage and decides nothing else. Every other guard — identity, permission, ownership — lives in the method it protects, inside the plane.**

**One bare gate.** A host composes the plane as `#resources = new Resources(...)` and exposes a single `@mesh() resources()` returning it, doing nothing else. A `@mesh(guard)` remains available to any host that needs one; this plane does not need one, because its methods cover themselves.

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

⚠️ **Deliberately unfinished: the sequencing against the Galaxy collapse is the open decision, and § *Status* stays OPEN until it is made.** The difficulty is that "self-guarding pulls the callers inside" reaches `invite`, the reapers and the eviction drains, and two of those are entangled with the collapse — `invite` has to be reachable on the Galaxy for the invited collaborator, and eviction cannot become uniform until the Galaxy holds an installed ontology version.
