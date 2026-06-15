---
paths:
  - "packages/auth/**/*.ts"
  - "packages/nebula-auth/**/*.ts"
  - "packages/testing/**/*.ts"
  - "packages/ts-runtime-parser-validator/**/*.ts"
  - "packages/mesh/**/*.ts"
---

# Communicating Without Mesh (raw DO and Workers)

How a DO is invoked and how it talks when it is **not** on the Mesh abstraction. This applies to two kinds of code:
- **Raw-DO infrastructure** — packages that deliberately `extend DurableObject` (not `LumenizeDO`) and have their own model: `auth`, `nebula-auth`, `testing`, `ts-runtime-parser-validator`.
- **Mesh's own framework internals** — the parts of `packages/mesh` that build the abstraction with raw primitives, e.g. `LumenizeClientGateway` (extends `DurableObject` for its zero-storage design).

⚠️ **Nebula platform code (`apps/nebula`) never uses any of this** — it communicates only through Mesh ([mesh.md](mesh.md)). If you're writing application/platform logic and reaching for a raw primitive below, you're in the wrong file. (Which layer am I? → [workers-projects.md](workers-projects.md).) Local DO correctness — storage, sync methods, etc. — still applies regardless: [durable-objects.md](durable-objects.md).

## Route pattern (`fetch()`)
Handle HTTP routes in `fetch()` via URL path matching, delegating to `#`-prefixed handler methods. Direct `if` matching is efficient enough — don't add hono router dependency unless you have more than a dozen routes and/or signficant middleware needs.

```typescript
async fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'POST' && pathname === '/login') return this.#handleLogin(request);
  return new Response('Not found', { status: 404 });
}
```

For Workers that dispatch to multiple DOs, use a prefix-matching helper, like `routeDORequest` that returns `undefined` on no-match and composes with `||`:
```typescript
return (await routeDORequest(request, env, { prefix: '/auth' })
  || await routeDORequest(request, env, { prefix: '/docs' })
  || new Response('Not found', { status: 404 }));
```

## Raw Workers RPC
Raw `stub.method()` is how non-mesh Workers and DOs talk to other DOs, WorkerEntrypoints, and RpcTargets. (Mesh code uses `this.lmz.call` instead — see [mesh.md](mesh.md).) Gotchas:
- Synchronous DO methods become **async over RPC** — in tests use `await expect(...).rejects.toThrow()`, not `expect(() => ...).toThrow()`.
- Private (`#`) methods silently return `undefined` over RPC stubs — use public methods or HTTP endpoints for communication.
- Hold the stub for the narrowest scope (`using stub = ...`) — an open stub bills wall-clock time (see [durable-objects.md](durable-objects.md) § Wall-clock billing).

## Errors over raw Workers RPC
Workers RPC serializes arguments and return values with structured clone, so rich types (`Date`, `Map`, `Set`, typed arrays, and reference identity within a single call) cross fine. **Errors are the exception: Cloudflare's RPC does not reconstruct custom Error subclasses** — a thrown custom error arrives as a plain `Error` with `name` + `message`, no `instanceof` for your class, and none of the `globalThis`-based reconstruction the mesh path does (see [mesh.md](mesh.md) § Errors across mesh calls).

- Detect signals by `err.name` + property presence, never custom-class `instanceof` — the subclass won't survive the hop.
- Whether arbitrary custom *own properties* survive is under-documented (Cloudflare's docs are thin on RPC error specifics). The empirical reference is `packages/structured-clone/test/errors.test.ts`, written partly to characterize and differentiate this — verify there before depending on it.

## Hibernation WebSocket API
For DOs that accept and push to connected clients, use the Hibernation WebSocket API: accept in `fetch()` via `ctx.acceptWebSocket(server)` returning a `101` with the client socket; push with `for (const ws of this.ctx.getWebSockets()) ws.send(message)`; in `webSocketClose` echo the code but map `1005` ("no status present") to `1000` since `1005` is invalid to send. vitest-pool-workers tests can open real `new WebSocket()` connections to deployed Workers for e2e patterns.

(In the Mesh world, client WebSockets terminate at the Gateway — app/platform DOs never accept their own.)

## Alarms
Schedule directly with `ctx.storage.setAlarm(...)` plus an `async alarm()` handler. (Mesh code uses `this.svc.alarms.schedule(...)` instead, which carries an OCAN continuation — see [mesh.md](mesh.md).)

## Self-referencing service bindings
A Worker binding to its own `WorkerEntrypoint` classes (the `"service"` field matches the Worker's own `"name"`) is a wrangler-config pattern — see [packaging.md](packaging.md) § Self-referencing service bindings.
