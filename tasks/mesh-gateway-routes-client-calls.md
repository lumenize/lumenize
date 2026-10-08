# The Gateway routes a Client's call, and a call it refuses wakes nothing

**Status:** Pass 2 written 2026-10-08, after Stage 1 ran three times and D1–D8 were decided. Stage 2 is next. Builds on [mesh-is-built-on-the-scope-tree.md](archive/mesh-is-built-on-the-scope-tree.md); lands before the first invites after ⑥ the wipe.

## Objective

**A host node's Gateway decides, in one place, where each call from its Clients goes. A call for the host runs in place. A call to a destination the Worker has declared a route for, from a caller who passes that route's check, is sent on. Every other call is refused at the Gateway, before any other Durable Object or Worker is touched. A node named by an id rather than a scope, such as a Profile, stores nothing until its first write, so an id a Client makes up leaves nothing behind.**

What a Client on `tenant1.crm.acme.lumenize.dev` can send:

| The frame names | Today | After this task |
|---|---|---|
| `STAR`, `acme.crm.tenant1`, its own host | runs in place | runs in place |
| `GALAXY`, `acme.crm` | sent on; the Galaxy checks passage | passage checked at the Gateway, then sent on |
| `PROFILE`, the `profileId` of someone who has signed in | sent on | sent on |
| `PROFILE`, a `profileId` nobody was ever given | a new Profile is built, stamps its identity, and writes its schema and an `eTag` row | sent on; nothing has been written to that Profile, so it stores nothing, not even its identity stamp |
| `PROFILE`, `agent:lumenize`, the agent's own | sent on | sent on |
| `AUTH_FACADE`, no instance | sent on | sent on |
| `STAR`, `acme.crm.tenant2`, a sibling | the sibling wakes, then refuses for lack of passage | refused at the Gateway: no passage |
| `STAR`, `acme.crm.tenant2/carol.7c1e9d20`, a Client on a sibling's host | the sibling Star wakes and hands the call to Carol's Client, which refuses it | refused at the Gateway: no passage |
| `GALAXY`, `acme.crm.tenant1`, the caller's own Star name | a Galaxy-class node is built at the Star's name, and a Star admin's dominion admits its `writeSource` and `buildNow` | refused at the Gateway: wrong tier |
| `STAR`, `zzz.q.x1`, a scope nobody created | a new Star is built and writes its schema and its org tree's root row, then refuses | refused at the Gateway: no passage |
| `AUTH_REGISTRY`, `registry` | the singleton wakes to refuse a method it does not have | refused at the Gateway: no route |
| `AUTH_REGISTRY`, `x7f3a9` | a second `AuthRegistry` is built, writes the identity schema and arms an hourly alarm that re-arms itself forever, then refuses | refused at the Gateway: no route |
| Any other binding: `AUTH_EMAIL_SENDER`, `PLATFORM_HOST`, one added later | the destination is invoked, or built if it is a Durable Object, then refuses | refused at the Gateway: no route |

## Context

**Clients can be altered or simulated by bad actors.** Our own Client code does the right thing, but we cannot trust that a bad actor will run our Client code unmodified.

**The Gateway sends a Client's call to whatever binding the Client names.** `ClientGateway.#handleClientCall` takes `binding` and `instance` from the Client's frame. When they name the host, `#isHostNode` runs the call in place. Otherwise the Gateway calls `resolveStub(this.#env, binding, instance).__executeOperation(envelope)`, and `resolveStub` reads `env[binding]` with nothing in between. The frame's identity fields are thrown away and rebuilt from the socket's verified attachment, so the claims are sound. The destination is the part nobody checks today.

**Today, every check on a call's destination is made at the destination, which costs a hop, or worse, a wake, or worse still, billable storage left behind.** A mesh Durable Object runs `onStart` inside its constructor, and its passage step runs only once a call arrives. `UnscopedMeshDO` refuses a scope-shaped name at the identity stamp, which is also after `onStart`. A raw `DurableObject` refuses a method it lacks once workerd has built the instance to look for it; that one is unmeasured, and the fix is the same either way. On each of these nodes, a refused call has already written:

- **Every mesh Durable Object** stamps its binding and name into storage, `__lmz_do_binding_name` and `__lmz_do_instance_name`, in `lmz.__init` at first contact, before any of its own code runs.
- **`AuthRegistry`'s constructor** runs the identity schema's migrations and arms its sweep alarm (`#sweepAndRearm`).
- **`Star` and `Galaxy`** compose `Resources`, whose `Subscriptions` runs its migrations and whose `OrgTree` inserts its root row (`#ensureRoot`), both at construction.
- **`Profile.onStart`** creates `ProfileFields` and the subscribers table, and seeds an `eTag` row.

**The Registry is a singleton by convention, not by its binding.** Every caller in our code asks for `AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME)`, which is `'registry'`, and the namespace hands back an instance for any other name just as readily. A signed-in user who opens their own socket and sends `binding: 'AUTH_REGISTRY', instance: 'x7f3a9'` leaves a second Registry behind, and can repeat it as fast as the socket carries frames. Open Star self-signup means anyone can be that user.

**The HTTP side already routes; the `lmz.call()` path does not.** The Worker's `fetch` answers every host from one table of routes in `entrypoint.ts`, and Mesh's `hostedUpgrade` picks the binding a socket opens on from the scope's tier, `tierBindings[parseId(scope).tier]`, never from anything the browser sends. The `lmz.call()` path has one route, `#isHostNode`, and a default that has access to all bindings and instances via `env`. The Worker cannot close this from its side: it sees a socket's upgrade, and every frame after that goes straight to the node holding the socket. So the routing has to live in the Gateway.

This turned up on 2026-10-06, while weighing whether the Registry should become a mesh node. [mesh-is-built-on-the-scope-tree.md](archive/mesh-is-built-on-the-scope-tree.md) § *The Registry stays raw* settled that question on other grounds (its D13). The hole does not depend on the answer: a raw Registry is reached the same way, and leaves more behind.

The sections that follow say what the routing must achieve, what it starts from, and the contract its phases will conform to.

## Goals

Each goal says how today's design misses it.

1. **A Client reaches only what a Client may call.** ADR-023 lets no Client make either bridge's hop, and puts the Registry behind the facade. Today a Client reaches `AUTH_REGISTRY`, `AUTH_EMAIL_SENDER`, `PLATFORM_HOST`, and any binding added to the Worker later, with no line of code saying it should.
2. **A call the Gateway can tell will be refused wakes nothing.** ADR-018 makes the singleton the scarce resource, and the facade checks claims before its hop for that reason. Today the Gateway sends first, so every refusal costs a wake, on the singleton or on a scope node the caller has no passage into.
3. **Unused billable storage is not left behind,** except where an admin names a scope below their host or opens a persona nobody defined (D2). Today every Durable Object in the Objective's table writes storage at construction, so a Client can create Registries, Stars and Profiles under names it makes up, without limit.
4. **Where a Client's call goes is decided in one place: three steps in order, the second looking the destination up in the routes the Worker declares once (D8).** Today the decision is split between `#isHostNode` and an unchecked default. The tier-to-binding map a scoped route needs reaches only `hostedUpgrade`, handed to it per request from `entrypoint.ts`, so a host node has no way to read it.

## Relationships

- **Builds on [mesh-is-built-on-the-scope-tree.md](archive/mesh-is-built-on-the-scope-tree.md), built 2026-10-08,** which folded `ClientGateway` into `ScopedMeshDO`, moved `Profile` and the facade into `@lumenize/mesh/auth`, and renamed the bindings named here.
- **Changes the premise of [mesh-1-alpha.md](mesh-1-alpha.md) § *Item 8: Mesh tears down a scope itself*,** which builds on the tier-to-binding table the app passes to the upgrade. After this task that table is the routes marked `hosts` in `defineRoutes`, and its § *Item 1* docs rewrite teaches `defineRoutes`.
- **Hands a question to [nebula-testing-with-personas.md](nebula-testing-with-personas.md)'s question 3: who writes a persona's name.** The persona's own token can, since `#requireOwnerOrAdmin`'s owner branch admits it. The confirming admin cannot, since `getScopesForProfile` finds no membership for a persona, and a second caller of the `@rawRpc()`-decorated `setDisplayNames` would be a security decision. Until a persona's name is written, D5 and D7 cover it.
- **Comes before the pre-alpha row *A person with no name is asked for one*,** which reads the never-written answer this task builds: `{ value: {}, meta: { eTag: '00000000000000000000000000' } }`.
- **Supersedes** `tasks/archive/nebula-clients-connect-to-their-scope.md` § *How a host node checks a call* (D4).
- **Changes these `tasks/backlog.md` rows, each in the phase named:**
  - *A host node checks a Client's passage before relaying to a target whose name is a scope* is deleted (Phase 2).
  - *A periodic sweep removes scope Durable Objects that no `Scopes` row names* gains D2's leftover as a second source of orphans (Phase 4).
  - *Profile GC — a later sweep, NOT teardown on scope deletion* gains the persona Profile left on a slug nobody defined, which the persona reaper never sees (Phase 4).
  - A new row flags for the next release notes, as BREAKING, that a Client reaches only the bindings declared in `defineRoutes` (Phase 4).
- **Gates the first invites after ⑥ the wipe** in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*, since the first people outside the team are the first who could send these frames. Its gate there is `deploy`: a Profile that already has its tables when it lands reads as written, so nothing it changes needs the wipe.

## Current state

Built already, and what becomes of each part:

- **`#isHostNode` and the in-place run** — carried over as step 1 of the routing.
- **`resolveStub(env, binding, instance)`** — carried over unchanged. It stays the dispatch for a routed call, and for node-to-node `lmz.call` and fire-backs, whose binding names our own code writes.
- **`#refuseToClient`** — carried over unchanged, as the road a refusal at the Gateway takes back to the Client.
- **`requirePassage(name, claims)` and `claimsForPassage(callContext)`** in `scoped-mesh-do.ts` — adapted: the Gateway reaches them through a hook keyed by a Mesh-private symbol in `node-kinds.ts`, beside `PASSAGE_STEP`, which `ScopedMeshDO` implements. A public `ClientGatewayHost` method would invite an override that skips `super`, as `CustomHostDO` already does with `onBeforeCallToClient`, and for a call to a Client this check is the only one. `claimsForPassage` is private to `scoped-mesh-do.ts`, which imports `ClientGateway`, so the Gateway cannot import it back.
- **`hostedUpgrade`'s `TierBindings` argument** — replaced by the routes the Worker declares (D8), and `TIER_BINDING` in `entrypoint.ts` gives way to the declaration. `meshTestFetch` keeps a `TierBindings` argument for teardown alone, since its claim and accept routes tear down a creation through `scopeLifecycleHooks`. The `TierBindings` type stays as scope teardown's map, which mesh-1-alpha's Item 8 owns: Nebula's `BINDING` in `scope-lifecycle-hooks.ts`, and the test support's `scopeLifecycleHooks` and `authFacadeFor`.
- **The identity stamp in `createLmzApiForDO`** — adapted for an unscoped node (D6), § *What a name nobody created leaves behind*. Its mark, `REFUSES_SCOPE_NAME`, is renamed `UNSCOPED_NODE`, since it now decides two things.
- **`Profile`** — adapted (D1, D5), § *What a name nobody created leaves behind*. The agent's self-seed still runs at construction, and the reaper `onProfileBroadcastResult` does nothing until the Profile has its tables.
- **`MeshClient`'s profile channel**, `#profileRefcount`, `#sendProfileSubscribe` and the re-send in `#handleConnectionStatus` — adapted (D7). Its unreachable `null` case is deleted, here and in `@lumenize/resources`' frontend types and store mirror.
- **`AuthRegistry`'s constructor** — carried over unchanged: with no route to its binding, only `getByName('registry')` reaches it.
- **`Star` and `Galaxy` building `Resources` at construction** — carried over unchanged (D2).
- **Each node's passage step, and `UnscopedMeshDO`'s refusal of a scope-shaped name** — carried over unchanged. They stay the authority at a node's two mesh doors, including for calls that never cross a Gateway.
- **Every Worker that hosts Clients, each caller of `hostedUpgrade` or of `meshTestFetch`** — adapted: each declares its routes, Mesh's test Workers and for-docs mini-apps and `packages/resources`' test Worker included, since step 3 refuses everything undeclared.

## Design intent

### The Gateway is a router

**For each call frame, the Gateway decides in this order:**
1. **Upstream to the host itself, or downstream to another Client the host holds:** run in place through the host's own request door, as today.
2. **A destination the Worker has declared a route for:** run that route's check against the call's context, which the Gateway builds from the socket's verified attachment and passes through `onBeforeCallToMesh`, then send the call on.
3. **Anything else:** refuse it at the Gateway. This is the catch-all, and it is what refuses `AUTH_REGISTRY`, `AUTH_EMAIL_SENDER`, `PLATFORM_HOST` and any binding added later.

**The steps are plain code in `#handleClientCall`, and only the second reads a table** (D3).

**The Gateway reads only the frame's binding and instance, never its chain.** Which methods a call may reach stays the destination's `@mesh()` check, as it is today.

**The Worker declares its routes once, keyed by binding** (D8). Nebula's, in `entrypoint.ts`, which every Nebula Worker that hosts Clients loads:

```ts
defineRoutes({
  UNIVERSE: { tier: 'universe', hosts: true },  // a scoped node; Clients' sockets open here
  GALAXY:   { tier: 'galaxy',   hosts: true },
  STAR:     { tier: 'star',     hosts: true },
  // STAR_SEARCH: { tier: 'star' },           // a scoped helper: routed, hosts no socket
  PROFILE:     'unscoped',                     // Mesh's Profile, named by a profileId
  AUTH_FACADE: 'worker',                       // Mesh's auth facade, a Worker with no instance
});
```

Every Durable Object class in the Worker shares that module, so `ScopedMeshDO`'s Gateway reads the declaration with no code on any host class.

- **The upgrade reads it too.** `hostedUpgrade` opens a socket on the one route marked `hosts` for the scope's tier, and refuses a tier with none, naming `defineRoutes()` as the Gateway's missing-route refusal does. So with nothing declared, no Client connects.
- **It is checked as it is declared.** `defineRoutes` throws at module evaluation when two `hosts` routes name one tier. A second call with the same routes does nothing, and a conflicting one throws.
- **A route can name several tiers.** Mesh's test Worker declares `CLIENT_HOST_DO: { tier: ['universe', 'galaxy', 'star'], hosts: true }`.
- **A route is found by own key only,** so a frame naming `__proto__`, `constructor` or `toString` gets the missing-route refusal. Its keys are typed from the generated `Env`, as `rawRpcStub`'s bindings are: a scoped or unscoped route only on a Durable Object namespace, a `'worker'` route only on a service binding, so a misspelled binding fails to compile.

**Each kind of route has its own check at the Gateway:**

| Route | Declared as | Checked at the Gateway before sending |
|---|---|---|
| Scoped node | `{ tier, hosts? }`, as above | `requirePassage` admits the caller into the instance's host part, then that scope's tier is one this route names. In that order, so `_platform` and an unparseable name keep `requirePassage`'s own messages |
| Unscoped node | `'unscoped'`, as Nebula declares `PROFILE` and a for-docs app `DOCUMENT_DO` | the frame names an instance; one that names a scope is refused by the same predicate and message `lmz.__init` uses, `namesScope`, exported from `lmz-api.ts` but not from the package; one holding a `/` is refused as a Client's address. The node's `@mesh()` check decides the method, and its own guards decide the rest, as `Profile`'s `#requireOwnerOrAdmin` decides a write |
| Worker | `'worker'`, as Nebula declares `AUTH_FACADE` | the frame names no instance |

**Passage is checked on the address's host part.** A Client's address, `acme.crm.tenant1/bob.9f2c41aa`, routes as a call to the Star `acme.crm.tenant1`, which is how `resolveStub` already reads it. A call to another Client is therefore checked for passage into that Client's host, and whether the receiving Client accepts it stays that Client's decision, as today.

### A refusal at the Gateway reads like any other

- **It takes the same road back.** `#refuseToClient` fills the Client's continuation with the Error and names the destination as the last hop, as a node's refusal does today.
- **A passage refusal says what the node would have said.** It is `requirePassage`'s own Error, so a test or a reader matches one message wherever passage is checked.
- **Each refusal has a pinned message:**
  - a missing route: `No route from a Client to "DOCUMENT_DO": a Client reaches only the bindings declared in defineRoutes()`;
  - a scope of the wrong tier: `"acme.crm.tenant1" is a star scope, which "GALAXY" does not serve`;
  - a Client's address on an unscoped route: `"PROFILE" serves nodes, and "acme.crm.tenant2/x" is a Client's address`.
- **Each refusal at step 2 or 3 logs one Gateway line** carrying the frame's `callId`, the binding, the instance and the reason, so a scenario can wait for its own frame's line.

### For a call addressed to a node, passage is checked twice

**The Gateway's check saves the wake, and the node's check is the authority.** Node-to-node `lmz.call` arrives without crossing a Gateway, so the node keeps its passage step, as ADR-023's third rule keeps each side's own checks. A `@rawRpc` call goes around that step by design, under ADR-023's second rule. Both run `requirePassage` on `claimsForPassage(callContext)`, over the context `onBeforeCallToMesh` returned, which is the context the envelope carries to the node. So the two agree by construction, whatever a host's override of that hook adds.

**For a call addressed to a Client, the Gateway's check is the only one.** A call to `acme.crm.tenant2/carol.7c1e9d20` reaches the sibling Star, which hands it to its `ClientGateway` before any passage step runs, and `requirePassageIntoSender` lets a sender that is itself a Client through. Today only the receiving Client's `onBeforeCall` refuses it, and an app may override that, so this refusal at the Gateway is new.

### What a name nobody created leaves behind

- **An unscoped node's identity stamp** (D6). A call from a Client arrives through `executeEnvelope`, and there an unscoped node keeps its stamp in memory: its name is `ctx.id.name` and its binding arrives on every envelope. That is a cache, not state: every call stamps it again, so losing it at eviction loses nothing, unlike a subscriber list (D7). The node persists the stamp where it may later act with no call to stamp from:
  - **at `__initFromHeaders`,** since a routed request can accept a hibernatable socket that wakes knowing its name but not its binding;
  - **at `__rawRpc`,** which only our own code reaches;
  - **once it has an alarm row,** whichever comes first, the alarm or the call, so an alarm armed in `onStart` gets its stamp at the call that built the node.

  The scope-name refusal stays in `lmz.__init` and writes nothing. A scoped node keeps persisting at first contact, which passage at the Gateway now limits to scopes the caller has passage into.
- **The Registry:** with no route to it, `'registry'` is the only name anything reaches it by. Clients do reach the facade, which reaches the Registry only as `getByName(REGISTRY_INSTANCE_NAME)`.
- **A scope a non-admin names:** passage from a host admits that host's scope and the scopes above it. Each of those exists whenever the host does, because the Registry creates a Star only under a Galaxy it holds and a Galaxy only under a Universe. So a non-admin cannot name a scope node nobody created.
- **A scope an admin names:** dominion admits any name below the host, created or not, so the call is sent on and may leave that node behind (D2).
- **A Profile.** ADR-012 lets any signed-in caller read any `profileId`, so nothing at the Gateway can tell an invented one from a real one. The Profile tells instead:
  - **Its first admitted write creates it** (D1): the write's guard runs before the schema exists, so a refused write leaves nothing.
  - **Only a real person can write it.** `#requireOwnerOrAdmin` admits a write from a token carrying this Profile's `profileId`, from an admin with dominion through one of the person's accepted memberships, or from a superuser on the agent's Profile, and the consent route's `@rawRpc()`-decorated `setDisplayNames` is our own Worker. So a Client calling an id it made up never creates one.
  - **Until then it answers the never-written profile.** `onStart` creates no table, and a read or a subscribe answers `{ value: {}, meta: { eTag: '00000000000000000000000000' } }`, built from a constant, and registers no subscriber (D5).
  - **A watching Client heals itself.** With no subscriber registered, the first write reaches nobody: Bob's page subscribes to `9f2c…`, nothing is stored, and Alice's first write pushes to no one. So a Client holding a never-written answer re-sends that subscribe on every new socket, and after its own successful `updateMyProfile` (D7). A page that keeps its socket and sends nothing waits for its next new socket or reload.
- **The agent's Profile, `agent:lumenize`:** `onStart` still seeds it at construction. Its id is reserved, so nobody invents it, and it has no owner, so under D1 nothing would ever write it. Its seed cannot wait for a write.
- **A persona's Profile:** the persona mint spells a `profileId` for any slug on a `.dev` Star its opener holds dominion over, so a persona's tab on a slug nobody defined creates a Profile at its first write: from `zed--dev.crm.acme.lumenize.dev`, an admin of `acme.crm.dev` opening a persona nobody defined leaves one. That is D2's trade-off again, and no sweep reclaims these Profiles.

### What changes in standing guidance

- **`.claude/rules/mesh.md` § *`ClientGateway` is the server-side half of a Client*** gains the three steps, in place of a dispatch to any binding.
- **`.claude/rules/durable-objects.md` § *Initialization*** and `UnscopedMeshDO`'s JSDoc, as § *Constraints* says.
- **`.claude/rules/mesh.md` § *Node identity is stamped on every first-contact entry (not just mesh calls)*,** the `LmzApi` getters' JSDoc, and `createLmzApiForDO`'s, which say the stamp is always persisted (D6). § *`ClientGateway` is the server-side half of a Client* also says it is handed only `ctx`, `env` and the hooks; it now reads the Worker's declaration as well.
- **`.claude/rules/security.md`:** its `paths:` gains `client-gateway.ts` and the module that defines `defineRoutes`, and its scope sentence names every check a Client's frame meets before it leaves its host, so an edit that weakens routing loads the security checklist.
- **`website/docs/nebula/auth-flows.md`'s passage diagram,** which shows a Client's lateral call refused only at the node, and the `platform-embed.ts` that `gen-platform.mjs` builds from it.
- **ADR-007, for Larry's review:** its word "persistent" for the stamp, which D6 makes true only of a scoped node. Its conformance argument holds, since storage is a per-type capability and `lmz.__init` already branches on the mark.
- **`docs/vision/auth.md`, for Larry's review.** M2, which says a node records the name it was reached by and a later mismatch throws, holds for a scoped node only. § *The layers a call passes* gains the Gateway's route and passage step for a Client's frame. § *Coarse-grained access control* says a lateral call is refused at the boundary before anything at the target runs, which becomes true for a Client's calls and stays untrue for a node's.

## Constraints

- **ADR-023:** the two bridges, and that a Client makes neither hop. This task makes the Gateway hold to it.
- **ADR-018:** a call the Gateway refuses stays off the singleton.
- **ADR-007:** the stamp's in-memory form is chosen by the mark `lmz.__init` already reads for an unscoped node, renamed `UNSCOPED_NODE`, so the core stays one implementation with a capability that differs by node kind.
- **ADR-015 and ADR-022:** passage reads `aud`, and `requirePassage` is the one place it is computed (ADR-007), so the Gateway calls it and never re-assembles it.
- **ADR-012:** holding a `profileId` is the capability, so the `PROFILE` route checks nothing about the name.
- **`durable-objects.md` § *Initialization*:** schema belongs in `onStart`. This task amends it, and `UnscopedMeshDO`'s JSDoc, so that an unscoped node a Client can name creates its schema at its first admitted write, with `Profile` as the example, and Mesh persists nothing for it before then except the identity stamp of a node that can act without a call (D6). An adopter's document node named by a UUID then follows the same rule.
- **`live.md`:** the regression is a `/live` scenario on a real login. It sends a frame for each refused row of the Objective's table, and one to `PROFILE` under an invented id, and asserts from the stack's debug lines that no refused frame woke a node, as `scope-hosts-its-clients` reads them. Whether a frame left storage behind is checked by diffing the local stack's SQLite files, once a measurement shows whether building a node and reading `sqlite_master` creates one.
- **Pre-alpha:** Mesh 1.0-alpha is unpublished and breaking changes are favored, so narrowing what a Client may call needs no deprecation.

## Future state

- ⚠️ Design consideration: **a scoped helper node is one more line of the declaration.** A helper takes its scope's name under a binding of its own, `STAR_SEARCH: { tier: 'star' }` at `acme.crm.tenant1`, and passage checks it as it checks the Star. It is not marked `hosts`, so no socket opens on it.
- ⚠️ Design consideration: **a per-`sub` limit goes ahead of step 1,** since every frame a Client sends passes through the Gateway's three steps. Calls the Gateway sends on can still load the singleton: the facade's admitted calls, and a Profile write from an admin, which `#requireOwnerOrAdmin`'s branch (4) checks with a Registry read before it refuses. `tasks/backlog.md` § *Nebula Auth* holds the limit as *A per-`sub` limit where a Client is hosted*.
- ⚠️ Design consideration: **if names an admin invents ever matter, the structural answer is D1's rule applied to every scoped node:** none writes before its first call with passage, so an invented name leaves nothing.
- ⚠️ Design consideration: **an idle page could heal sooner, with a timer that runs only while it holds a never-written subscription** and re-sends those subscribes, say every 15 minutes. It costs one Profile wake per such subscription per interval, on the pages that have one. The trigger to build it: a report of an empty byline that never fills on a page someone keeps open (D7).
- ⚠️ Design consideration: **the data plane could heal the same way.** It refuses a subscribe before create, so it holds no unregistered subscription today. If subscribing to a resource that will exist is ever wanted, D7's re-send of an unregistered subscribe is the mechanism to reuse.
- ⚠️ Design consideration: **an adopter's `'unscoped'` route opens every name a Client invents,** and whether that leaves storage depends on the adopter's `onStart`, which `website/docs/mesh/sql.mdx` and `lumenize-do.mdx` teach to create tables. `UnscopedMeshDO` could warn when a fresh instance's `onStart` writes, naming create-on-first-write with `Profile` as the pattern; mesh-1-alpha's docs rewrite teaches the same.
- **Out of scope, and must stay that way:** a node's own `lmz.call`. Its binding names are written by our code, and nothing here routes it through the Worker's declaration.

## Open questions

None.

## Phases

**Every phase leaves every workspace's suite and the container-free `/live` sweep, `drive.ts all --fast`, green.** Each converts any task-file handle it would put in source into an ADR, a rule or a clause of prose, checked with `grep -nE '\b[SD](1[0-9]|[1-9])\b|\bPhase[ -][0-9]+\b|\bChild [0-9]+\b'` over its changed files (`workflow.md` § *Referring to things across files*).

### Phase 1 — A Worker declares its routes, and the upgrade reads them

**`defineRoutes` lands in `@lumenize/mesh`, and every Worker that hosts Clients calls it at module scope.** Each declares `PROFILE` and `AUTH_FACADE` where its Clients call them (D8). `hostedUpgrade` opens a socket on the one route marked `hosts` for the scope's tier, in place of its `TierBindings` argument. `meshTestFetch` keeps its tier map for teardown alone. The callers are `apps/nebula/src/entrypoint.ts`, Mesh's test Worker, the for-docs `calls`, `getting-started` and `security` Workers, and `packages/resources/test/test-worker.ts`; each declares every binding its Clients call. The Gateway still forwards as it does today, so what a Client may call does not change yet.

- **Success criteria (capable of failing):**
  - **The declaration's own checks,** in a vitest-plugin test over a function that validates a declaration without registering it, since the registered routes are module-global and a test's own call would conflict with its Worker's. It is pure, and its header says so. Two `hosts` routes for one tier throw with their exact message; `__proto__`, `constructor` and `toString` resolve to no route; a misspelled binding fails type-check, held by a `// @ts-expect-error` line.
  - **The resolver `hostedUpgrade` uses** refuses a tier with no `hosts` route, with a message naming `defineRoutes()`. Same lane, same reason. Every Worker declares all three tiers, so this lane is the only one that can reach it, and the test says so.
  - `hostedUpgrade` takes no tier map, and `git grep -nw TIER_BINDING -- packages apps` prints nothing. Run on 2026-10-08, before any change, it printed `entrypoint.ts`'s two lines.
  - Every Nebula `/live` scenario opens its sockets from the declaration, so the sweep passing is the witness that the upgrade reads it.
- **Mutation note:** dropping the two-`hosts` check reds the first criterion on its message; a plain `routes[binding]` lookup reds its `__proto__` row; letting the resolver answer a tier with no `hosts` route reds the second; leaving `TIER_BINDING` in place, or a tier-map parameter on `hostedUpgrade`, reds the third.

### Phase 2 — The Gateway routes a Client's call

**`#handleClientCall` takes the three steps of § *The Gateway is a router*.** For a scoped route, step 2 runs `requirePassage` over `claimsForPassage(callContext)`, on the context `onBeforeCallToMesh` returned, through the Mesh-private hook, and then the tier check. An unscoped route refuses a scope's name through `namesScope` and a Client's address with its own message. Step 3 refuses with the missing-route message. Every refusal logs its Gateway line. `Profile.onStart` and `Galaxy.onStart` gain a `started` debug line naming `ctx.id.name`, as `Star.onStart` has, so a scenario can show a node never woke. The JSDoc at each site says what it now does: `ClientGatewayHost` and `ClientGateway`, which say the Gateway is handed only `ctx`, `env` and the hooks, and `requirePassageIntoSender`, which says the receiving Client decides. The backlog row *A host node checks a Client's passage before relaying to a target whose name is a scope* is deleted.

**This closes a reach that is open today.** A Star admin on `acme.crm.tenant1`'s host can send `GALAXY` at `acme.crm.tenant1`, building a Galaxy-class node at their own Star's name, where their dominion admits `writeSource` and `buildNow` through `requireChatWrite`. Open signup makes anyone a Star admin. The tier check refuses it.

- **Success criteria (capable of failing):**
  - **A new `/live` scenario, `client-routes`,** container-free, signs in by real email with `provisionAndLogin` on a Star of the run's shared app, and claims a sibling Star first through the real signup. Its limbs all run, and the verdict comes at the end, as `mesh-entry-reach` does. Each limb waits for its own frame's Gateway line before it reads anything else, and on a deployed target each log half reports itself as not observable (`live-scenarios.md` § *Reading the local stack's logs*).
    - **The missing route.** `AUTH_REGISTRY` at `registry` and at the fixed probe name `client-routes-probe`, `AUTH_EMAIL_SENDER` with no instance, and `__proto__` are each refused with the missing-route message. No `registry schema migrations checked` line with `rowsWritten` above 0 appears after the login's own.
    - **Passage.** `STAR` at the sibling, and at a Client's address on the sibling, are refused with `noPassageMessage`'s wording, and no `lmz.mesh.ScopedMeshDO.passage` entry names the sibling after the limb's own line. `STAR` at `zzz.q.x1` is refused the same way, and no `nebula.Star.onStart` `started` line names it.
    - **The tier.** `STAR` at the app's Galaxy name, and `GALAXY` at the caller's own Star name, are refused with the tier message, and no `started` line names the target.
    - **The unscoped route.** `PROFILE` at `acme.crm.tenant2` and at `_platform` is refused with `lmz.__init`'s message, and at `{sibling}/x` with the Client's-address message, and no Profile `started` line names any of them.
    - **Positive controls.** A `GALAXY` call to the app's Galaxy, a `PROFILE` subscribe to the caller's own profile, and a `client.scopes` call through `AUTH_FACADE` each answer. The sibling's own founding logged a `started` line and a passage entry, and the caller's own Profile logs its `started` line, so each matcher is shown able to fire.
  - **The tests the Gateway takes over, each owned here.** Run once on 2026-10-08, `grep -rlnE 'ScopedMeshDO\.passage|parses as a scope|No passage from' packages/mesh/test apps/nebula/test apps/nebula/harness` lists them: 18 files on 2026-10-08. Each either becomes a Gateway test or is driven below the Gateway, through `rawRpcStub(...).startChainTo`, `TEST_DO.callForOutcome` or a hand-built envelope, so the node's own check keeps a test that can fail:
    - `passage-step.test.ts`'s sibling limb asserts that the node's passage step ran zero times, and its `ROOM_DO`-by-Client limb keeps its message through `namesScope`.
    - A new node-to-node limb has a `@rawRpc()` helper on `ClientHostDO` call `lmz.call('ROOM_DO', 'room-1', …)` and asserts `lmz.__init`'s message.
    - `client-sender-passage`'s limb 1 sends from a tab with passage into Star A, the owner's tab on the Galaxy host.
    - `subscribe-refusal-arrives`'s limb 2 sends from a tab whose host is the Universe.
    - `node-chain-passage`'s limb 1 folds into `client-routes`.
    - The mutation comments in `scope-isolation.test.ts`, `scope-binding.test.ts` and `guards.test.ts` point at the check that now refuses first.
- **Mutation note, one per limb:** forwarding an undeclared binding reds the missing-route limbs on their message; a plain `routes[binding]` lookup reds `__proto__`'s; dropping the passage check reds the sibling limb on its passage entry, the Client's-address limb on its message, and `zzz.q.x1` on its `started` line; dropping the tier check reds both tier limbs on their `started` lines; checking the tier before passage reds the `_platform` row of `scope-isolation`; dropping the unscoped checks reds the `PROFILE` limbs on their `started` lines; making the passage hook a public method that `CustomHostDO` overrides without `super` reds the sibling limb.

### Phase 3 — A node named by an id stores nothing before its first write, and a Client heals what that costs

**D5 and D7 land together,** because the harness's logins never write a Profile: `consumeLink` sends an empty body by default, so a subscribe before a first write is the usual case in the suites, and D5 without D7's re-send would leave them red between phases.

**The node side.** `createLmzApiForDO` keeps an unscoped node's stamp in memory at `executeEnvelope`, as § *What a name nobody created leaves behind* says. The mark `REFUSES_SCOPE_NAME` becomes `UNSCOPED_NODE`, with JSDoc naming both its consequences. `lmz.__init` persists the stamp when the node has an alarm row, and `Alarms.schedule` persists it when the stamp is known, so the order does not matter. In `Profile`:
- **Every write runs its guard first.** Then one helper creates the schema and seeds a real `eTag`, then the write lands. `writeProfile`, `writePrivateNotes` and `setDisplayNames` all call it, so a refused write leaves nothing, and a Profile whose only write was its private notes answers its empty public fields as written.
- **A Profile exists once it has an `eTag` row.** `#publicSnapshot` answers the never-written constant without one, and `onStart` creates no table, except for the agent's self-seed.
- **The other entries store nothing on an unwritten Profile.** `read` and `subscribe` answer the never-written profile, `readDisplayNames` answers `{}`, `unsubscribe` and `readPrivateNotes` find nothing, and the reaper does nothing until the tables exist.

The JSDoc at each site says what it now does: the `LmzApi` getters, `createLmzApiForDO`, `UnscopedMeshDO`, `Alarms.schedule` and `Profile`.

**The Client side.** `MeshClient` remembers which profiles last answered with the never-written `eTag` and re-sends their subscribes on every new socket, in `#handleConnectionStatus`, and after its own successful `updateMyProfile` (D7). The Client's `null` profile case is deleted in `mesh-client.ts`, in `@lumenize/resources`' frontend types and store mirror, in `apps/nebula/test/frontend/mock-client.ts`, and in `website/docs/nebula/api-reference.md`, and `platform-embed.ts` is regenerated.

- **Success criteria (capable of failing):**
  - **First, a measurement:** whether building a node and reading `sqlite_master` creates a SQLite file under the local stack's `.wrangler/state`. The result goes in this phase's build notes, and the next criterion uses it.
  - **`client-routes` gains a storage limb.** A `PROFILE` subscribe, a `read`, and a disposed handle's `unsubscribe` under one random UUID each answer as never written, and a `writeProfile` there from the caller is refused with `#requireOwnerOrAdmin`'s message. Locally, that Profile then has no table and no KV row. Before trusting the absence, the same reader finds the tables of the caller's own Profile after it writes. On a deployed target, the limb reports itself as not observable.
  - **A new `/live` scenario, `unwritten-profile-heals`.** Bob signs in with `provisionAndLogin`, whose empty body leaves his Profile unwritten. Alice's page is an impersonation child minted with a short `ttlSeconds`, as `impersonation-expiry` mints one, and subscribes to Bob's `profileId` through `subscribeProfile`, which answers never-written. Bob sets his name with `updateMyProfile`, and his own store shows it at once. Alice's store still shows nothing. After her token really lapses and her page sends a call, her socket rotates and her store shows Bob's name (calibration §13).
  - **Two vitest-plugin tests of the stamp,** in-lane because only the plugin resets an isolate on demand or reads a node's storage directly, as each header says. An `UnscopedMeshDO` that schedules an alarm in `onStart` is built by a call, reset with `ctx.abort()`, and its alarm then makes an `lmz.call` that arrives. And after `rawRpcStub('TEST_DO', id).rawRpcEcho(…)`, `getStoredBindingName()` returns `TEST_DO`.
  - **Every test that subscribes to a Profile before its first write is decided here.** Run once on 2026-10-08, `grep -rnE 'FROM Subscribers|ProfileFields|subscribeProfile|Profile>\(\)\.subscribe' apps/nebula/test packages/mesh/test packages/resources/test apps/nebula/harness` lists them, 41 lines on 2026-10-08, among them `profile-subscribe`, `profile-do`, `reaper-wiring`, `subscriptions-table`, `client-session`, and the scenarios `scope-hosts-its-clients`, `gateway-stamps-the-chain` and `resubscribe-when-lost`. Each either writes the Profile first, so its own property can still fail, or asserts the never-written answer. `profile-subscribe.test.ts`'s back-fill leg subscribes through `subscribeProfile` and forces a new socket, asserting the heal.
  - `git grep -nE 'ProfileChannelSnapshot \| null|// absent profile|profile that does not exist' -- packages apps website/docs` prints nothing. Run on 2026-10-08, it matched 16 lines in seven files, among them `mesh-client.ts`, `mock-client.ts`, `@lumenize/resources`' frontend and `api-reference.md`, and the generated `platform-embed.ts`, which regenerating it clears.
  - The scenarios that render the agent's byline, `four-party-chat` and `node-chain-passage`, still show its name, and the signup scenario's capture holds no `display-name read failed` line.
- **Mutation note:** restoring `onStart`'s `CREATE TABLE` reds the storage limb; creating the schema before the write guard reds it on the refused write; persisting the stamp at `executeEnvelope` reds it on the KV row; dropping the alarm-row persistence reds the alarm test; keeping every unscoped stamp in memory reds the `rawRpcEcho` test; skipping the scope-name refusal on the in-memory branch reds Phase 2's node-to-node `ROOM_DO` limb; skipping the agent's seed reds the byline scenarios; dropping the re-send in `#handleConnectionStatus` reds Alice's limb, and dropping the one after `updateMyProfile` reds Bob's.

### Phase 4 — The guidance, the backlog and the deployed pass

**The standing guidance describes what Phases 1–3 built, and a deployed pass runs every scenario this task wrote or touched.** This phase is last because Phases 2 and 3 both change what `mesh.md` describes.

- **The rules:**
  - `mesh.md` § *`ClientGateway` is the server-side half of a Client* gains the three steps and the Worker's declaration.
  - `mesh.md` § *Node identity is stamped on every first-contact entry (not just mesh calls)* says where an unscoped node persists its stamp.
  - `durable-objects.md` § *Initialization* says an unscoped node a Client can name creates its schema at its first admitted write, with `Profile` as the example.
  - `security.md`'s `paths:` and scope sentence, as § *What changes in standing guidance* says.
- **The docs:** `auth-flows.md`'s passage diagram, and `platform-embed.ts` regenerated from it.
- **For Larry's review, before the phase closes:** ADR-007's word "persistent", and `docs/vision/auth.md`'s § *The layers a call passes*, M2, and § *Coarse-grained access control*'s lateral-refusal sentence.
- **Other task files:** the backlog rows § *Relationships* names; a line in `mesh-1-alpha.md`'s § *Item 8* saying its tier table is now the routes marked `hosts`, and in its docs ideas teaching `defineRoutes` and create-on-first-write; a line in `nebula-testing-with-personas.md`'s question 3 saying who can write a persona's name; and this task's row in `nebula-pre-alpha.md`.
- **The deployed pass,** since what a Client hears back changes (`live.md`): `deploy-test.sh`, then every scenario this task wrote or touched with `HARNESS_TARGET_URL`, beside a `wrangler tail --format json` capture. They are `client-routes`, `unwritten-profile-heals`, `client-sender-passage`, `subscribe-refusal-arrives`, `scope-hosts-its-clients`, `gateway-stamps-the-chain`, `resubscribe-when-lost` and `four-party-chat`. Before the deploy, the deployed-only paths are checked, as `live.md` lists them.
- **Success criteria (capable of failing):** every scenario above passes deployed; `node scripts/check-prose.mjs` passes on every edited rule and task file; `npm run audit:mesh-vocab` passes; and each guidance section named above, read against the code, states what the code does.
- **Mutation note:** the guidance has none of its own. The deployed runs red under the same mutations as Phases 2 and 3.

## Non-goals

- **A per-`sub` limit at the Gateway.** `tasks/backlog.md` § *Nebula Auth* holds it, with its trigger.
- **The no-name form.** `nebula-pre-alpha.md` § *A person with no name is asked for one*.
- **A timer that heals an idle page sooner**, and **lazy schema for scoped nodes.** § *Future state* keeps both, each with its reason.
- **Scope teardown's map**, `BINDING`. mesh-1-alpha's § *Item 8* owns it.
- **Who writes a persona's name.** The personas task's question 3.
- **Routing a node's own `lmz.call`.** Our code writes its binding names.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **D1. A Profile is created by its first write** (Larry, 2026-10-08). § *What a name nobody created leaves behind* says who may write one and what the Profile does until then. | **A `@rawRpc()`-decorated `create()` at mint.** A `profileId` is minted inside the Registry singleton, and a Profile first touched from there is placed beside it for good (`durable-objects.md` § *A named object is placed by the first code that touches it*), so each caller of `#mintIdentity` would have to call it instead. It would buy only a live byline for an invitee who has not signed in, and that invitee has no name to show. |
| **D2. An admin's call to a scope below its host that nobody created is sent on, and may leave that node behind** (Larry, 2026-10-08). From `crm.acme.lumenize.dev`, a Galaxy admin naming `acme.crm.junk1` leaves a Star; from `acme.lumenize.dev`, a Universe admin naming `acme.junk` leaves a Galaxy. A Star admin's dominion covers only their own Star. A Universe admin may create Galaxies and Stars below their Universe, up to the caps. What they leave by naming one stays inside a subtree they already hold dominion over, and no cap counts it, since `MAX_GALAXIES_PER_OWNER` counts only Galaxies the Registry created. Open signup means anyone can be that admin, of a Universe of their own. A persona's tab on a slug nobody defined is the same trade-off, and the Profile it leaves is not reclaimed. That leaves the Galaxy admin, who will be rare: most Galaxy work is done by Universe admins, and a small part by plain members of the Galaxy, as Austen is in `_ai-security.md`'s scenario. The backlog row *A periodic sweep removes scope Durable Objects that no `Scopes` row names* reclaims what is left, and keeps its public-signup trigger because the leftover stays in its creator's own subtree. | **Check existence at the Gateway**, against a copy of the Registry's scopes kept off the singleton: one read on every scoped call. **No scoped node writes before its first call with passage:** it changes `durable-objects.md` § *Initialization* for every scoped node, and § *Future state* keeps it in case this ever matters. |
| **D3. The Gateway's routing is plain code in `#handleClientCall`: three steps, the second reading a table** (Larry, 2026-10-08). | **`createRouter`**, the runner the HTTP side uses. It chains middleware over a `Request`, and a call frame has three outcomes and no middleware. |
| **D4. The Gateway checks passage before sending a call to a scoped node** (Larry, 2026-10-08). It buys two things: no sibling node wakes to refuse a call, and no storage is left under a name outside the caller's own subtree. Routes are keyed by binding, so passage is checked only where the name is a scope, and the Profile and the facade are never refused for having none. An admin's dominion still passes it (D2). It supersedes `tasks/archive/nebula-clients-connect-to-their-scope.md` § *How a host node checks a call*, which weighed only where a name's first touch places its object. The backlog row *A host node checks a Client's passage before relaying to a target whose name is a scope* is deleted when this lands. | **Relay scoped calls unchecked until public signup**, as that backlog row deferred it. Universe signup is open, so anyone could keep naming `zzz.q.x1` and leaving a Star behind, and keep waking sibling Stars to refuse them. |
| **D5. A Profile nobody has written answers a read or a subscribe with the empty profile, from memory, and registers no subscriber** (Larry, 2026-10-08). That is the answer every Profile gives today: `Profile.onStart` has seeded an `eTag` since the Profile DO's first commit so that an unwritten profile still answers with a usable snapshot, and no server path has ever sent `null`. Under D1 the answer is built from memory, with a fixed never-written `eTag` that every real ULID sorts after (ADR-005). The Client's `null` profile case is deleted, since nothing sends it. The Resources plane answers differently, refusing a subscribe before create, because a Star can prove from its own storage that a resource does not exist; a Profile can prove only that nothing has been written, which for a profile means empty. | **Refuse the subscribe.** The Profile cannot tell an invented id from a real person's unwritten Profile without a Registry read, so the Error would reach real pages too: a persona's tab, whose chrome reads its own profile, and a person whose best-effort consent write failed. **Answer `null`**, as `ProfileSubscription` documents: nothing has ever sent it. **Store the subscriber row**, so the first write pushes live: that row is storage under an invented id. |
| **D6. An unscoped node keeps its identity stamp in memory when a call arrives through `executeEnvelope`, and persists it only where it may later act with no call to stamp from; this task makes that change to Mesh's core** (Larry, 2026-10-08). Without it, D1 and D5 still leave two KV rows behind for every invented `profileId`, because `lmz.__init` stamps before the Profile's code runs. | **Move the Profile half to a backlog row of its own**, with this as its design. It is too small for a task file of its own, and leaving it out keeps a hole the router was meant to close. |
| **D7. A Client heals its own unregistered profile subscriptions, at the next new socket** (Larry, 2026-10-08). `MeshClient` re-sends the subscribe of every profile whose last answer was the never-written one, in `#handleConnectionStatus` on every new socket, where `#profilePending` is already re-sent, and after its own successful `updateMyProfile`. A page that keeps its socket and sends nothing heals at its next new socket or reload. That page's only loss is a byline left empty, and the pages that hold such a subscription are few: a persona writes its name when its tab opens, and the pre-alpha no-name row makes the harness send a nickname and prompts a person whose consent write failed. Until that row lands, the harness's logins never write a Profile, so the tests that subscribe before a first write change with this task. Refresh stays tied to work: `MeshClient` refreshes only when it connects or sends with a token due. Nothing new reaches app code, since the answer arrives through the existing profile listener into `store.lmz.profiles`. | **Re-send at each token refresh:** a page that sends nothing never refreshes, and a refresh during a socket rotation fires on the old socket, which drops the re-send. **A scheduled refresh for every tab, or one on each heartbeat tick:** a refresh per open tab every 15 minutes, to cover a rare and cosmetic case, where today an idle tab costs nothing. **A client timer while a page holds a never-written subscription:** cheap, but a timer to manage for a case that will rarely happen; § *Future state* keeps it. **Push the first write to the writer:** it delivers once, and with no row the writer misses every later change. **The Profile subscribes the writer at its first write:** the server would guess at a subscription the Client never asked for. **Hold an unwritten Profile's subscribers in memory:** lost at eviction, long before a person finishes a form, and `durable-objects.md` § *No mutable instance state* rules it out. **App code re-subscribes after its first write:** every generated app would have to know to. |
| **D8. The Worker declares its routes once, with `defineRoutes`, keyed by binding** (Larry, 2026-10-08). Every Durable Object class in the Worker shares the module that calls it, so a host node's Gateway reads it with no code of its own, and `hostedUpgrade` opens a socket on the one route marked `hosts` for its tier. Each Worker declares `PROFILE` and `AUTH_FACADE` itself, so every binding a Client can reach is in the declaration, and one left out is refused with a message naming `defineRoutes()`. | **The same table as JSON in `wrangler.jsonc` `vars`:** untyped, outside TypeScript, against ADR-001. **A getter on each host class:** one copy per host class, the repetition calibration §11 warns against. **Widening `TierBindings`:** it maps a tier to a binding, so it cannot hold an unscoped node, and the upgrade's allow-list would widen with it. **Mesh adds `PROFILE` and `AUTH_FACADE` itself,** or registers each on its class's import: a Worker that binds `PROFILE` to a Durable Object of its own would get a route it never declared. |
