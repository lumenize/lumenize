# ADR-023: The Mesh Boundary Is Crossed Only at a Bridge

**Date**: 2026-10-01
**Status**: Proposed — pending Larry's read
**Deciders**: Larry
**Evidence**: `NebulaAuthFacade` (`packages/nebula-auth/src/nebula-auth-facade.ts`), the bridge into raw infrastructure, built for scope invites; the consent path's raw RPC into the `Profile` node (`worker-token.ts`'s `profile()`), which reaches a mesh node with no bridge at all; two routes specified on 2026-10-01, `POST /_teardown` and `POST /_order-certificate`, which put operations only our own code may invoke on a Durable Object's `fetch` and were reversed the same day; and the same day's question of whether components we control should talk free of claims in general.

## Context

**Lumenize code runs on two sides of one boundary, and each side has to call the other.**

- **Mesh nodes** call each other with `lmz.call`. Every hop carries verified claims in `callContext`, a guard (`onBeforeCall`) checks them, and only `@mesh()`-decorated members can be called. The Galaxy, each Star and the Profile are mesh nodes.
- **Raw infrastructure** speaks Workers RPC and HTTP and knows nothing of claims. `NebulaAuthRegistry`, the identity singleton, extends `DurableObject` directly.

Two examples, one per direction:

1. A galaxy admin invites `pat@example.com` into `acme.crm`. The request starts on the mesh, carrying the admin's claims, and has to end as a write in the Registry.
2. An admin deletes `acme.crm`. The Registry removes the scope, and then something has to wipe the Galaxy and its Stars. The admin holds claims, yet the wipe itself must be something no client can call.

Each crossing is where the mesh's guarantees stop: verified identity, the guard, the `@mesh()` surface, and [ADR-016](016-record-the-acting-principal.md)'s record of who acted. Written inline, a crossing looks like ordinary code at the site that makes it, so nothing there shows where the checking ends. Both directions went wrong before this ADR. Teardown and certificate ordering were first specified as `fetch` routes on the Galaxy, safe only while no forward happened to produce their paths. And once a crossing that no client could invoke was needed, the next question was whether our own components should have a general channel free of claims.

The rest of this ADR names the two bridges, says when each is the right one, and lists what neither may turn into.

## Decision

**Code crosses the mesh boundary in two directions, and each direction has exactly one bridge.** We call them **a facade**, of which **the Registry facade** is the canonical example, and **`@rawRpc`**, each named for what the callee exposes. Each bridge is written once, in the package that owns it, and every crossing in its direction uses it.

Three rules hold for both:

1. **The crossing runs between code we wrote.** The facade's raw call reaches the Registry from `nebula-auth`'s own facade, and a `@rawRpc` call reaches a node from our own Worker. No user-developer's code and no client makes either hop. A client counts as untrusted even where we wrote it: `NebulaClient` runs in someone's browser, where its user can change it.
2. **A bridge deliberately goes around the guard of the side it enters, so whatever the crossing must satisfy is checked before it crosses.** The facade checks the caller's claims before its hop. A `@rawRpc` call carries out a decision already checked where it was made.
3. **The side entered keeps the checks it applies to calls from within itself.** The Registry still checks the claims each of its methods is handed, so a caller that reached it some other way is still refused. A mesh node's guard still covers every mesh call, and a `@rawRpc()`-decorated method is simply never one.

### Into raw infrastructure: a facade

**When** mesh code needs a capability that lives in raw infrastructure. For example, the Registry's capabilities:

- inviting someone into a scope;
- creating a galaxy;
- minting an impersonation token.

**How:** the infrastructure package exports a `LumenizeWorker`, bound as a service binding, and mesh code calls it like any node: `lmz.call('NEBULA_AUTH_FACADE', undefined, ctn<NebulaAuthFacade>().invite('acme.crm', invitees))`. A call through it takes three steps:

1. The facade refuses on the verified claims, `callContext.originAuth`, so a refused call never wakes the infrastructure ([ADR-018](018-singleton-is-the-scarce-resource.md)). [Should we distinguish this somehow (not sure how) from "deliberately goes around the guard of the side it enters". I'm guessing it's distingushed by the fact that it's in the facade not in the infrastructure yet.]
2. It makes the one raw call, beside the invariants it enforces.
3. It records the caller's full claims through ADR-016's one projection.

### Into a mesh node: `@rawRpc`

**When** our own code must carry out a decision the server has already made, where claims were checked, and no client may invoke the operation directly, whatever its claims. For example:

- a deletion's teardown, carrying out what `executeScopeDeletion` decided under the admin's claims;
- a creation's teardown, which starts the new scope empty, and the certificate order after it;
- the consent route's write of the display names the person chose.

`@mesh()` would open each to every caller its guard admits: any admin could wipe a live app without deleting it, or order certificate packs for galaxies that do not exist. Anything a caller may do on its own authority goes over the mesh, with its claims.

**How:** `@lumenize/mesh` supplies both halves. The callee decorates the method, `@rawRpc() orderCertificate()`, which names the path it may be called by, as `@mesh()` does; a method carries one or the other. A call through it takes three steps:

1. The caller calls through a typed stub: `rawRpcStub('GALAXY', 'acme.crm').orderCertificate()`. TypeScript infers `Galaxy` from the generated `Env`, which types `GALAXY` as `DurableObjectNamespace<Galaxy>`, so a misspelled binding, method or argument fails to compile. The stub reads `env` from `cloudflare:workers`, so plain Worker code with no `lmz` can call it.
2. One entry on the node receives the call and stamps the node's identity, taking the instance name from `ctx.id.name` and the binding from the caller.
3. The entry refuses a method `@rawRpc()` did not decorate, and invokes the one it names, walking no chain past it.

The stub defines no wire format. It turns `.orderCertificate()` into one ordinary Workers RPC call to the entry:

```ts
rawRpcStub('GALAXY', 'acme.crm').orderCertificate();
// sends, from the caller's side:
env.GALAXY.getByName('acme.crm').__rawRpc('GALAXY', 'orderCertificate', []);
```

The method name becomes a string only inside the stub, and the arguments and result cross in Workers RPC's structured clone, which `raw-comm.md` § *Errors over raw Workers RPC* measures. A continuation needs a format of its own because it is stored and forwarded hop to hop; this call is neither.

Using the stub takes a binding, and only code running in our own Worker can import `env`. An app's own code runs in the browser, its build runs in a container handed only build variables, and a validator compiled from its types runs in a Worker Loader isolate given no bindings.

### What neither bridge may become

- **An operation only our own code may invoke, on a Durable Object's `fetch`.** A node's HTTP surface is for callers outside the mesh, each request secured by the node's own design ([ADR-007](007-shared-node-security-core.md)). An operation that answers to no caller's credential is exposed there the day a forward changes which paths it produces.
- **A general channel free of claims.** Each bridge opens one capability at a time, chosen at the callee: a facade method refuses on claims, and `@rawRpc` opens one method. A lane any component could use to skip claims would make every node's guard optional.
- **Raw RPC written inline** by code outside the infrastructure package it reaches.

### What this does not cover

- **Inside the package that owns a raw object**, its own nodes reach it directly. The facade exists so the raw hop sits in that package, beside the rules it serves, and the `Profile`, a mesh node in `nebula-auth`, is already there: it reads the Registry by raw RPC, mid-call, to learn who administers a profile.
- **Mesh's own internals**, such as the client Gateway, which builds envelopes by hand because it is part of what the mesh is built from.
- **Requests into a node's `fetch`**, which are ADR-007's track.

> **Today's code differs.** `rawRpcStub` and `@rawRpc()` do not exist yet. nebula-auth's consent path calls the `Profile` by raw RPC, with no stub or decorator, for the display-name pre-fill and write. A deletion's teardown reaches each node from the browser, over the mesh, and creating a galaxy, deleting a scope and impersonating are still HTTP routes rather than facade methods. [nebula-scope-moves-to-subdomain.md](../../tasks/nebula-scope-moves-to-subdomain.md) builds `@rawRpc`, moves those three operations onto the facade, and moves teardown, certificate ordering and the Profile calls onto `@rawRpc`.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Raw RPC inline at each site** | What the facade replaced for invites. Each site re-derives eligibility and the record, and nothing at the site shows where checking stops. |
| **Routes only our own code may call, on a node's `fetch`, carrying the identity headers** (2026-10-01, reversed the same day) | ADR-007 keeps a node's `fetch` for callers outside the mesh, and the routes were safe only while no forward produced their paths. |
| **Admitting calls without claims from a trusted binding, in `onBeforeCall`** | A trust rule on every node to serve a few calls, and consent would still have no claims to start from. |
| **A general channel for components we control** | Every hop between our components is already reachable only by code holding a binding. What was missing was a typed door the callee opens one method at a time, not a lane. |
| **A decorator that takes the binding and instance names as a method's first two arguments** | A decorator cannot change the signature callers see, so each call site would need a cast, and an undecorated method called that way would run with two extra arguments. |

## Consequences

### Positive

- **Every crossing can be found.** `grep -rn '@rawRpc()'` lists every method raw code may call, and a facade's `@mesh()`-decorated methods list every capability mesh code reaches in raw infrastructure.
- **A reviewer checks one place per crossing:** the facade method's refusal and record, or the decorated method's body.
- **A node woken first by raw RPC knows its own name.** Its alarms and later mesh calls then carry a return address.

### Negative / mitigations

- **A `@rawRpc()` method trusts its caller completely**, because no claims arrive for it to check. Mitigation: keep each one small and idempotent, as `teardown()` and `orderCertificate()` are, and never give one a parameter naming whom to act for.
- **A rule the facade checks lives in two places**, the facade and the Registry, so a change to it has to land in both. The cost buys rules 2 and 3 above, and a test of the Registry's own refusal keeps the second copy honest.
- **The binding is passed, not derived.** If `env[binding].idFromName(ctx.id.name)` equals `ctx.id` only under the right binding, the entry can verify it; until that is measured, it trusts what our own code passes.
