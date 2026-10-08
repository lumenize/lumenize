# The Gateway routes a Client's call, and a call it refuses wakes nothing

**Status:** Pass 1, design intent only, drafted 2026-10-08. Builds after [mesh-is-built-on-the-scope-tree.md](mesh-is-built-on-the-scope-tree.md); lands before the first invites after ⑥ the wipe.

## Objective

**A host node's Gateway decides where each call from its Clients goes, from one routing table. A call for the host runs in place. A call the table has a route for, from a caller who passes that route's check, is sent on. Every other call is refused at the Gateway, before any other Durable Object or Worker is touched.**

What a Client on `tenant1.crm.acme.lumenize.dev` can send:

| The frame names | Today | After this task |
|---|---|---|
| `STAR`, `acme.crm.tenant1`, its own host | runs in place | runs in place |
| `GALAXY`, `acme.crm` | sent on; the Galaxy checks passage | passage checked at the Gateway, then sent on |
| `PROFILE`, a `profileId` | sent on | sent on [Hmmm, this could create instances with storage unless we postpone SQLite CREATE TABLE calls until after we check that this isn't malicous. How would we check that? My first thought is that we explicitly have a createProfile method and the initial CREATE TABLE statemenst run in there. Then the onStart migrations only run if it's been previously created, but I've put close to zero thought into this so open to ideas. Maybe calls from Clients to createProfile are rejected by the router so they can only come from a node whose code we wrote?] |
| `AUTH_FACADE`, no instance | sent on | sent on [Sending on to the facade is fine, but what about once inside the facade? I think we're safe from creating new Registry instance here because the facade hard-codes correctly to the Registry instance name, but could this be used to DoS the Registry? If so, how could we prevent that?] |
| `STAR`, `acme.crm.tenant2`, a sibling | the sibling wakes, then refuses for lack of passage | refused at the Gateway [You say "passage checked" for GALAXY above. Why not say that here also? Isn't that what refuses it?] |
| `STAR`, `zzz.q.x1`, a scope nobody created | a new Star is built and writes its schema and its org tree's root row, then refuses | refused at the Gateway [Same comment] |
| `AUTH_REGISTRY`, `registry` | the singleton wakes to refuse a method it does not have | refused at the Gateway [How are we going to do this? Define an interface for the Registry? That won't work because interfaces are not runtime? Will we have to maintain a list of methods? Ohhh, I know, we refuse anything but __executeOperation, and things like that, right? If so, say that.] |
| `AUTH_REGISTRY`, `x7f3a9` | a second `AuthRegistry` is built, writes the identity schema and arms an hourly alarm that re-arms itself forever, then refuses | refused at the Gateway |
| `AUTH_EMAIL_SENDER`, no instance | the email sender's entrypoint is invoked, then refuses | refused at the Gateway [Do we really want to refuse this? If so, isn't this essentially the routing waterfall's terminal catch-all refusal?] |

## Context

**Clients can be altered or simulated by bad actors.** Our own Client code does the right thing, but we cannot trust that a bad actor will run our Client code unmodified.

**The Gateway runs inside of a scoped node.** Previously, the Gateway was a storage-free Durable Object. One for each Client instance of which a single browser could have multiple, in separate browser tabs but even multiple in the same browser tab. Today, the Gateway runs inside of the scoped mesh node that is the `activeScope` (aka `aud`) for the Client connection. [It's unclear to me if this point is even relevant. Did we have the problems this task is meant to fix even when the Gateway was stand-alone DO instances? If so, maybe we delete this paragraph?]

**The Gateway sends a Client's call to whatever binding the Client names.** `ClientGateway.#handleClientCall` takes `binding` and `instance` from the Client's frame. When they name the host, `#isHostNode` runs the call in place. Otherwise the Gateway calls `resolveStub(this.#env, binding, instance).__executeOperation(envelope)`, and `resolveStub` reads `env[binding]` with nothing in between. The frame's identity fields are thrown away and rebuilt from the socket's verified attachment, so the claims are sound. The destination is the part nobody checks today.

**Today, every check is done at the destination, which means a hop, or worse, waking a DO, or worse still, leaving behind billable DO storage.** A mesh Durable Object runs `onStart` inside its constructor, and its passage step runs only once a call arrives. `UnscopedMeshDO` refuses a scope-shaped name at the identity stamp, which is also after `onStart`. A raw `DurableObject` refuses a method it lacks once workerd has built the instance to look for it; that one is unmeasured, and the fix is the same either way. So a refused call has already cost a wake, and on each of these nodes a write:

- **`AuthRegistry`'s constructor** runs the identity schema's migrations and arms its sweep alarm (`#sweepAndRearm`).
- **`Star` and `Galaxy`** compose `Resources`, whose `Subscriptions` runs its migrations and whose `OrgTree` inserts its root row (`#ensureRoot`), both at construction.
- **`Profile.onStart`** creates `ProfileFields` and the subscribers table, and seeds an `eTag` row.

**The Registry is a singleton by convention, not by its binding.** Every caller in our code asks for `AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME)`, which is `'registry'`, and the namespace hands back an instance for any other name just as readily. A signed-in user who opens their own socket and sends `binding: 'AUTH_REGISTRY', instance: 'x7f3a9'` leaves a second Registry behind, and can repeat it as fast as the socket carries frames. Open Star self-signup means anyone can be that user.

**The HTTP side already routes; the `lmz.call()` path does not.** The Worker's `fetch` answers every host from one table of routes in `entrypoint.ts`, and Mesh's `hostedUpgrade` picks the binding a socket opens on from the scope's tier, `tierBindings[parseId(scope).tier]`, never from anything the browser sends. The `lmz.call()` path has one route, `#isHostNode`, and a default that has access to all bindings and instances via `env`. [Note, the edge Worker is out of the picture for `lmz.call()` because WS messages bypass the edge worker so it's not possible to fix this by beefing up the existing edge worker checks.]

This turned up on 2026-10-06, while weighing whether the Registry should become a mesh node. [mesh-is-built-on-the-scope-tree.md](mesh-is-built-on-the-scope-tree.md) § *The Registry stays raw* settled that question on other grounds (its D13). The hole does not depend on the answer: a raw Registry is reached the same way, and leaves more behind.

The sections that follow say what the routing must achieve, what it starts from, and the contract its phases will conform to.

## Goals

Each goal says how today's design misses it.

1. **A Client reaches only what a Client may call.** ADR-023 lets no Client make either bridge's hop, and puts the Registry behind the facade. Today a Client reaches `AUTH_REGISTRY`, `AUTH_EMAIL_SENDER`, `PLATFORM_HOST`, and any binding added to the Worker later, with no line of code saying it should.
2. **A call the Gateway can tell will be refused wakes nothing.** ADR-018 makes the singleton the scarce resource, and the facade checks claims before its hop for that reason. Today the Gateway sends first, so every refusal costs a wake, on the singleton or on a scope node the caller has no passage into.
3. **Unused billable storage is not left behind.** Today every node in the Objective's table writes storage at construction, so a Client can create Registries, Stars and Profiles under names it makes up, without limit.
4. **Where a Client's call goes is decided in one place, and reads as a routing table [Will it actually be a table, or look more like a waterfall of if statements? I'm OK either way and I don't think this calls for a routing utility helper, but maybe? We already built such a utility for HTTP routing. It follows hono/ittyrouter conventions for "middleware" and guards but I haven't thought through if that is called for here. My gut says "no".].** Today the decision is split between `#isHostNode` and an unchecked default. The tier-to-binding map a scoped route needs is handed to `hostedUpgrade` per request, and Nebula declares it twice: `TIER_BINDING` in `entrypoint.ts` and `BINDING` in `scope-lifecycle-hooks.ts`.

## Relationships

- **Builds after [mesh-is-built-on-the-scope-tree.md](mesh-is-built-on-the-scope-tree.md),** which folds `ClientGateway` into `ScopedMeshDO`, moves `Profile` and the facade into `@lumenize/mesh/auth`, and renames the bindings named here. Phases written against today's paths would be written twice.
- **Gates the first invites after ⑥ the wipe** in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*, since the first people outside the team are the first who could send these frames. Its gate there is `deploy`: nothing it changes is persisted.

## Current state

Built already, and what becomes of each part:

- **`#isHostNode` and the in-place run** — carried over as the table's first route. A call for the host, or for a Client the host holds, runs through `this.#host.__executeOperation`.
- **`resolveStub(env, binding, instance)`** — carried over unchanged. It stays the dispatch for a routed call, and for node-to-node `lmz.call` and fire-backs, whose binding names our own code writes. A Client's frame reaches it only after a route matches.
- **`#refuseToClient`** — carried over unchanged, as the road a refusal at the Gateway takes back to the Client.
- **`requirePassage(name, claims)`** in `scoped-mesh-do.ts` — carried over unchanged, and called a second time, by the Gateway. It depends only on a name and claims, and its `_platform` reject and grammar check come with it.
- **The tier-to-binding map, `TierBindings`** — adapted. The routing table reads the same map `hostedUpgrade` does, and Nebula declares it once.
- **`Profile.onStart`'s schema and seed** — adapted: they move to the profile's first write.
- **`AuthRegistry`'s constructor** — carried over unchanged. With no route to its binding, only `getByName('registry')` reaches it, and the singleton should have its schema and its alarm.
- **`Star` and `Galaxy` building `Resources` at construction** — carried over unchanged. Passage at the Gateway stops every scope a caller cannot reach; the ones an admin can reach are § *Open questions*.
- **Each node's passage step, and `UnscopedMeshDO`'s refusal of a scope-shaped name** — carried over unchanged. They stay the authority for every path into a node, including the ones that never cross a Gateway.

## Design intent

### The Gateway is a router

**For each call frame, the Gateway decides in this order:**
1. **The host itself, or a Client it holds [I assume one is an upstream call and the other is downstream. If so, let's use those words]:** run in place, as today.
2. **A destination the table has a route for:** run that route's check against the socket's verified claims, then send the call on.
3. **Anything else:** refuse it at the Gateway.

**The table has three kinds of route.** Nebula's, as the example:

| Route | Bindings | Checked at the Gateway before sending |
|---|---|---|
| Scoped node | `UNIVERSE`, `GALAXY`, `STAR`, one per tier [For the future, we'll support scoped helper nodes. They will have the same instance name but a different binding. We don't need to work that out completely here, but don't preclude that future.] | the instance's host part parses as a scope of that binding's tier, and `requirePassage` admits the caller |
| Unscoped node | `PROFILE` | the instance is a well-formed `profileId`, a UUID [Plus, we refuse calls to a createProfile method in the router, and we add protection on the Profile side to prevent leaving billable storage of not-real Profiles laying around.] |
| Worker | `AUTH_FACADE` | the frame names no instance |

**Mesh supplies the routes to its own nodes, and the app supplies the rest.** `PROFILE` and `AUTH_FACADE` are Mesh's `/auth` nodes, under the binding names Mesh's own code already calls them by. The tier bindings are the app's: the same map it hands `hostedUpgrade`, declared once and read by the entrypoint, the lifecycle hooks and the router alike. An app with unscoped nodes or Workers of its own adds a route for each.

**Passage is checked on the address's host part.** A Client's address, `acme.crm.tenant1/bob.9f2c41aa`, routes as a call to the Star `acme.crm.tenant1`, which is how `resolveStub` already reads it. A call to another Client is therefore checked for passage into that Client's host, and whether the receiving Client accepts it stays that Client's decision, as today.

### A refusal at the Gateway reads like any other

- **It takes the same road back.** `#refuseToClient` fills the Client's continuation with the Error and names the destination as the last hop, as a node's refusal does today.
- **A passage refusal says what the node would have said.** It is `requirePassage`'s own Error, so a test or a reader matches one message wherever passage is checked.
- **A missing route says so,** as `No route from a Client to "AUTH_REGISTRY"`, and the Gateway logs the binding and instance.

### Passage is checked twice, for two different reasons

**The Gateway's check saves the wake, and the node's check is the authority.** A node is also reached by node-to-node `lmz.call` and by `@rawRpc`, neither of which crosses a Gateway, so the node keeps its passage step, as ADR-023's third rule keeps each side's own checks. Both call `requirePassage`, so the two cannot disagree.

### A name nobody created leaves nothing behind

- **The Registry:** with no route to it, `'registry'` is the only name anything reaches it by.
- **A scope a non-admin names:** passage from a host admits that host's scope and the scopes above it. Each of those exists whenever the host does, because the Registry creates a Star only under a Galaxy it holds and a Galaxy only under a Universe. So a non-admin cannot name a scope node nobody created.
- **A scope an admin names:** dominion admits any name below the host, created or not. That one is § *Open questions*.
- **A Profile:** ADR-012 lets any signed-in caller read any `profileId`, so nothing at the Gateway can tell an invented one from a real one. The Profile therefore writes nothing until its first real write, and answers a read of an unwritten profile from memory.

## Constraints

- **ADR-023:** the two bridges, and that a Client makes neither hop. This task makes the Gateway hold to it.
- **ADR-018:** a refused call stays off the singleton.
- **ADR-015 and ADR-022:** passage reads `aud`, and `requirePassage` is the one place it is computed (ADR-007), so the Gateway calls it and never re-assembles it.
- **ADR-012:** holding a `profileId` is the capability, so the `PROFILE` route checks only the name's form.
- **`durable-objects.md` § *Initialization*:** schema belongs in `onStart`, which `Profile` will depart from; its JSDoc says why.
- **`live.md`:** the regression is a `/live` scenario on a real login, sending a frame for each refused row of the Objective's table.
- **Pre-alpha:** Mesh 1.0-alpha is unpublished and breaking changes are favored, so narrowing what a Client may call needs no deprecation.

## Future state

- ⚠️ Design consideration: **D13's second reason goes away.** Once the Gateway routes, a Registry that became a mesh node would simply have no Client route, so it would no longer wake for calls it must refuse. D13 still stands on storage portability.
- ⚠️ Design consideration: **the call path's table and the HTTP side's could share a shape.** `entrypoint.ts` already runs its routes through `createRouter`, the runner Mesh's auth routes use.
- ⚠️ Design consideration: **an adopter's unscoped node brings its own name check with its route,** as `PROFILE` brings the UUID check. Mesh's for-docs document nodes are the first.
- **Out of scope, and must stay that way:** a node's own `lmz.call`. Its binding names are written by our code, and nothing here routes it through a Client's table.

## Open questions

1. **Is an admin's call to a scope nobody created refused?** Dominion admits every name below the host, so an admin on `acme.crm`'s host can still name `acme.crm.junk1` and leave a Star behind.
   - **(a) Accept it.** It stays inside the admin's own subtree and is billed to their own tenancy. Refusing it takes an existence check on every routed call.
   - **(b) Check existence at the Gateway,** against a copy of the Registry's scopes held off the singleton. One read per scoped call.
   - **(c) No scoped node writes before its first admitted call,** so an invented name leaves nothing, by the rule `Profile` follows. Every node's `onStart` moves, and `durable-objects.md` § *Initialization* changes for every layer.

   **Recommendation: (a).** The cost lands on the tenancy that caused it. (c) is the structural answer if it ever matters, and stays a design consideration until then.

2. **What does a subscribe to a Profile nobody has written leave behind?** An unwritten profile is read on purpose, which is why `Profile.onStart` seeds an `eTag`: so it still delivers a snapshot. A subscribe to one stores a subscriber row, and an invented `profileId` keeps that row.
   - **(a) Accept the row,** provided it is removed once its subscriber is gone. Whether disconnect cleanup or the reaper does that for a profile that is never written to is a claim to check before Pass 2.
   - **(b) Refuse a subscribe to a `profileId` the Registry never minted.** That takes a lookup per subscribe, off the singleton.

   **Recommendation: (a)**, if the check holds; (b) if it does not.
