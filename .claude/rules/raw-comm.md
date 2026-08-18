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

⚠️ **Nebula platform code (`apps/nebula`) MUST NOT use any of this** — it communicates only through Mesh ([mesh.md](mesh.md)). If you're writing application/platform logic and reaching for a raw primitive below, you're in the wrong file. (Which layer am I? → [workers-projects.md](workers-projects.md).) Local DO correctness — storage, sync methods, etc. — still applies regardless: [durable-objects.md](durable-objects.md).

## Route pattern (`fetch()`)
HTTP routes SHOULD be handled in `fetch()` via URL path matching, delegating to `#`-prefixed handler methods. Direct `if` matching is efficient enough for a handful of routes.

**A third-party router dependency MUST NOT be added.** Where a route *table* with ordered middleware is genuinely warranted, that shape is already in-repo — `packages/nebula-auth/src/route-pipeline.ts`, a small runner written against the path-parameter and middleware-list patterns those libraries popularised, with no dependency and no public-API commitment. It is `nebula-auth`-local by design (`@lumenize/routing` is published MIT, so a runner there would be semver-bound); another package that outgrows `if` matching writes its own rather than importing this one or adding a dep.

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

## Edge Worker fronting a DO: forward the request, or handle it in the Worker?

When an edge Worker router fronts a backing DO (canonical: `nebula-auth`'s Worker → the Registry singleton), each route takes one of two shapes — and the choice is consistent, not ad-hoc:

- **Forward the request to the DO's `fetch()`** when the endpoint's job **IS the DO's data operation** (claim / create / delete / query on the DO's storage). The edge does only the cross-cutting pre-checks that need env/secrets — Turnstile, JWT-verify — then forwards. **The ORIGINAL request MUST be forwarded — `stub.fetch(request)` — whenever the edge has nothing to add**: no parse, no re-serialize, and every header survives. **It MAY be rebuilt only to inject trusted claims** the DO cannot derive (`verifiedAccess`/`callerSub` off the verified JWT, which MUST NOT be client-supplied), which forces parse → mutate → `JSON.stringify`; note a rebuild also **drops every header you don't copy**. ⚠️ A body-reading pre-check MUST `request.clone()` (Turnstile does), or it consumes the body and forecloses the raw forward. Either way the DO reads `url.origin` etc. **itself** — origin is *not* threaded as an RPC arg — and owns its **error→Response** conversion in-process, so a typed error's `status`/`code` survive (the dropped-props gotcha below does NOT apply to this path). Canonical: `handleRegistryPath` → `forwardToRegistry` → the Registry DO's `fetch()`.
- **Handle it in the Worker, with narrow RPC calls,** when the endpoint is an **HTTP/session concern** — cookie set/clear, `302` redirects, reading a token from the URL query, or a pure-KV read (the refresh path never touches the singleton). The Worker owns the `Response` and RPCs the DO only for the specific data it needs (`registry(env).requestMagicLink(...)`, `consumeMagicLink(...)`). Those RPC calls obey the dropped-props rule below: expected client-errors MUST be gated on the Worker *before* the RPC. Canonical: `handleInstancePath` → `worker-token.ts`.

The dividing line is **where the endpoint's essence lives** — the DO's data (forward) vs HTTP/cookie/token mechanics (Worker).

⚠️ **Forwarding does NOT expose the singleton to junk traffic.** The edge router matches the endpoint against its known set *before* forwarding, so an unknown path is a `404` at the edge — the DO never sees it (Turnstile additionally fronts the open endpoints). "Forward everything" is not "let the singleton absorb 404s."

## Raw Workers RPC
Raw `stub.method()` is how non-mesh Workers and DOs talk to other DOs, WorkerEntrypoints, and RpcTargets. (Mesh code uses `this.lmz.call` instead — see [mesh.md](mesh.md).) Gotchas:
- Synchronous DO methods become **async over RPC** — tests MUST use `await expect(...).rejects.toThrow()`, not `expect(() => ...).toThrow()`.
- Private (`#`) methods silently return `undefined` over RPC stubs — communication MUST go through public methods or HTTP endpoints.
- **`using` MUST NOT be applied to a DO stub** (nor a service/WorkerEntrypoint binding or facet stub) — it's a local pointer with no `Symbol.dispose`, so `using` throws `"Object is not disposable."` in every environment. Use a plain `const` + `await`; the pointer needs no disposal. `using` is only for a **method-returned RpcTarget session stub** (see [durable-objects.md](durable-objects.md) § Wall-clock billing; verified in `experiments/rpc-stub-disposability/FINDINGS.md`).

## Errors over raw Workers RPC
Workers RPC serializes arguments and return values with structured clone, so rich types (`Date`, `Map`, `Set`, typed arrays, and reference identity within a single call) cross fine. **Errors are the exception: Cloudflare's RPC does not reconstruct custom Error subclasses** — a thrown custom error arrives as a plain `Error` with `name` + `message`, no `instanceof` for your class, and none of the `globalThis`-based reconstruction the mesh path does (see [mesh.md](mesh.md) § Errors across mesh calls).

- Signals MUST be detected by `err.name` + property presence; custom-class `instanceof` MUST NOT be used — the subclass won't survive the hop.
- **Custom *own properties* are DROPPED across raw Workers RPC** (`name` + `message` survive; `status`, `errorCode`, etc. do NOT). Confirmed 2026-07-13: a `nebula-auth` registry method threw a `RegistryError` carrying `status`/`errorCode` over RPC to the Worker; the caller read `err.status === undefined` and mis-mapped a 403 to a 500. (The empirical characterization reference is still `packages/structured-clone/test/errors.test.ts`.) **The pattern that follows: an RPC-called DO method MUST NOT throw a status-carrying error the caller must inspect. The EXPECTED client-errors (auth/validation) MUST be gated on the CALLER (Worker) side *before* the RPC, and the method MUST return a plain result (or `null`) for its normal outcomes, throwing only for genuinely-unexpected 500s.** (Contrast the `fetch()`-forwarded path, where the DO's own `fetch` handler catches its `RegistryError` in-process — same isolate, real `instanceof` — and converts it to a `Response` that crosses RPC intact.)

## Hibernation WebSocket API
DOs that accept and push to connected clients MUST use the Hibernation WebSocket API: accept in `fetch()` via `ctx.acceptWebSocket(server)` returning a `101` with the client socket; push with `for (const ws of this.ctx.getWebSockets()) ws.send(message)`; in `webSocketClose` echo the code, but `1005` ("no status present") MUST be mapped to `1000` since `1005` is invalid to send. vitest-pool-workers tests can open real `new WebSocket()` connections to deployed Workers for e2e patterns.

(In the Mesh world, client WebSockets terminate at the Gateway — app/platform DOs never accept their own.)

## Alarms
Schedule directly with `ctx.storage.setAlarm(...)` plus an `async alarm()` handler. (Mesh code uses `this.svc.alarms.schedule(...)` instead, which carries an OCAN continuation — see [mesh.md](mesh.md).)

## Self-referencing service bindings
A Worker binding to its own `WorkerEntrypoint` classes (the `"service"` field matches the Worker's own `"name"`) is a wrangler-config pattern — see [packaging.md](packaging.md) § Self-referencing service bindings.
