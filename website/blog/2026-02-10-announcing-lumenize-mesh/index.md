---
title: "Announcing Lumenize Mesh (Beta)"
slug: announcing-lumenize-mesh
authors: [larry]
tags: [mesh, auth, announcement]
description: "Lumenize Mesh: a true mesh network where Durable Objects, Workers, and browser clients are equal peers — secure by default, rich types everywhere."
---

Today we're releasing **Lumenize Mesh** in beta — a de✨light✨fully radical new way to build on Cloudflare Workers and Durable Objects, where DOs, Workers, and browser clients are all equal peers in one mesh.

<!-- truncate -->

## The problem

Cloudflare's Durable Objects are incredibly powerful. Each one is a stateful, single-threaded actor with transactional storage running at the edge. But building real applications on them means solving the same problems over and over:

- **Workers RPC stops at the server.** It connects DOs to Workers and Workers to DOs, but browsers are left out. You end up building a REST or WebSocket API layer by hand.
- **No built-in auth or access control.** Every team rolls their own JWT validation, permission checking, and identity propagation. Security becomes an afterthought.
- **Serialization gaps.** Workers RPC handles rich types between server components, but those `Map`s, `Set`s, and `Date`s get flattened to JSON the moment you talk to a browser.
- **No self-identity.** Anyone calling a DO must know the binding name and instance name of the callee, but ironically, the DO is blind to its own identity.
- **Lost call context.** When a DO handles multiple concurrent requests, knowing *which* call you're currently processing requires wiring up [`AsyncLocalStorage`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/) yourself — a powerful but low-level primitive that's easy to get wrong.

I've been building on Durable Objects for going on four years — solving these problems in different ways, learning from how others solve them better (PartyKit, Agent, Actors, durable-utils), and then pushing further. Lumenize Mesh is the result.

## What Mesh does differently

Here's one method on a `LumenizeDO` that highlights several key ideas. The subsections below unpack each piece — and there's [much more in the full documentation](/docs/mesh).

```typescript
// This works on any mesh node — DO, Worker, or browser client
@mesh((instance: DocumentDO) => {
  if (!instance.lmz.callContext.originAuth?.claims?.isAdmin) {
    throw new Error('Admin only');
  }
})
updateDocument(docId: string, changes: Map<string, Date>) {
  // The DO knows its own identity
  const self = this.lmz.instanceName;   // e.g., 'draft-1'
  const binding = this.lmz.bindingName; // e.g., 'DOCUMENT_DO'

  // callContext — always the right one, even during interleaved calls
  const caller = this.lmz.callContext.originAuth?.sub;

  // Execute code in another place — type-safe continuation
  this.lmz.call(
    'SEARCH_INDEX', undefined,
    this.ctn<SearchIndex>().reindex(docId),
    this.ctn().onReindexed(this.ctn().$result)
  );

  // Execute code at another time — same continuation pattern
  this.svc.alarms.schedule(300, this.ctn().notifySubscribers(docId));
}
```

### Every node is a peer

In Lumenize Mesh, there are three types of nodes: `LumenizeDO` (stateful Durable Objects), `LumenizeWorker` (stateless Workers), and `LumenizeClient` (browser, Node.js, Bun — anything with JavaScript and WebSockets).

All three use the same API. All three can make calls and receive calls. A Durable Object can call a method on a browser client just as easily as it calls another DO. Think push notifications, live cursors, or collaborative editing — the server needs to call the client, not just the other way around. The `@mesh()` decorator, `this.lmz.call()`, and `this.ctn<T>()` shown above work identically on every node type.

### Secure by default

Every method on a mesh node is locked down unless explicitly exposed with the `@mesh()` decorator. Authentication is required, not optional. User identity propagates automatically through the entire call chain — when a browser client calls a DO that calls a Worker, the Worker knows the user's identity.

The default auth is [**@lumenize/auth**](/docs/auth), a passwordless authentication system that runs entirely inside a Durable Object — magic link email login, Ed25519 signed JWTs, refresh token rotation, two-phase access (email verification + admin approval), and RFC 8693 delegation. All Cloudflare-native with no external auth service required. But the auth interface is a clean contract: [bring your own](/docs/auth/getting-started#bring-your-own-provider) if you need to.

### Rich types everywhere

Notice the `Map<string, Date>` parameter in the example. `Map`, `Set`, `Date`, `Error` with cause chains, objects with cycles, `ArrayBuffer`, `Uint8Array` — all of it works seamlessly between every node type, including browser clients. No manual serialization. You pass a `Map` from a browser client to a DO and it arrives as a `Map`.

### Self-identity

`this.lmz.instanceName` and `this.lmz.bindingName` in the example seem obvious — but Cloudflare doesn't provide them. PartyKit and Agent first hinted at a solution, sending identity in headers on client→server calls. Mesh extends the idea so every call, including DO→DO, propagates identity. DOs store it; Workers keep it in memory.

### Call context that just works

`this.lmz.callContext` in the example always has the right context in scope — even when calls go out to other nodes and return while other requests are in flight. Under the covers, Mesh uses [`AsyncLocalStorage`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/) (as does Cloudflare's [Agent SDK](https://developers.cloudflare.com/agents/concepts/agent-class/)). You never touch it directly.

### Continuations — execute code in another place or time

The `this.ctn<T>()` calls in the example create continuations — type-safe, serializable descriptions of work to be done. `this.lmz.call()` sends one to another node; `this.svc.alarms.schedule()` sends one to the future. Both use the same pattern.

Continuations also support [chaining and nesting](/docs/rpc/operation-chaining-and-nesting) — the result of one operation feeds into the next, and the whole chain executes in a single round trip. No back-and-forth. No waterfall of awaits.

Continuations are designed specifically for the Durable Objects concurrency model: serializable (store them, send them over the wire), type-safe (TypeScript checks method names and signatures), and built to minimize race conditions.

## Getting started

Ready to build? The [Getting Started Guide](/docs/mesh/getting-started) walks you through building a collaborative document editor with DOs, Workers, and browser clients.

The full documentation is at [lumenize.com/docs/mesh](/docs/mesh).

## Also releasing today

- [**@lumenize/auth**](/docs/auth) (Beta) — Passwordless authentication system described above. Works standalone with any Cloudflare Workers project.
- [**@lumenize/debug**](/docs/debug) (GA) — Structured debug logging designed to feed Cloudflare's observability dashboard in a format that lets you query for exactly the log entries you need.
- See [Package Changes](/blog/lumenize-package-changes) for migration details from earlier Lumenize versions.

## What's next

We're also announcing [**Lumenize Nebula**](/blog/introducing-lumenize-nebula) — an agentic platform for building enterprise applications from declarative business ontologies, built on Lumenize Mesh. If the mesh is the networking layer, Nebula is the application layer.

Follow the [blog](/blog) or join our [Discord](https://discord.gg/tkug8FGfKR) to stay in the loop. And if you build something with Mesh, we'd love to hear about it.
