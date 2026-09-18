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

- **Forward the request to the DO's `fetch()`** when the endpoint's job **IS the DO's data operation** (claim / create / delete / query on the DO's storage). The edge does only the cross-cutting pre-checks that need env/secrets — Turnstile, JWT-verify — then forwards. **The ORIGINAL request MUST be forwarded — `stub.fetch(request)` — whenever the edge has nothing to add**: no parse, no re-serialize, and every header survives. **It MAY be rebuilt only to inject trusted claims** the DO cannot derive (`verifiedAccess`/`callerSub` off the verified JWT, which MUST NOT be client-supplied), which forces parse → mutate → `JSON.stringify`; note a rebuild also **drops every header you don't copy**. ⚠️ A body-reading pre-check MUST `request.clone()` (Turnstile does), or it consumes the body and forecloses the raw forward. Either way the DO reads `url.origin` etc. **itself** — origin is *not* threaded as an RPC arg — and owns its **error→Response** conversion in-process. Canonical: the registry-bound rows of `router.ts`'s route table, whose three terminals encode what the edge injects — `forwardRaw` (nothing, `stub.fetch(request)`) vs `forwardWithAccess` / `forwardWithClaims` (the licensed rebuilds) → the Registry DO's `fetch()`.
- **Handle it in the Worker, with narrow RPC calls,** when the endpoint is an **HTTP/session concern** — cookie set/clear, `302` redirects, reading a token from the URL query, or a pure-KV read (the refresh path never touches the singleton). The Worker owns the `Response` and RPCs the DO only for the specific data it needs (`registry(env).requestMagicLink(...)`, `consumeMagicLink(...)`). A check that needs none of the DO's data — a request's shape, a verified JWT — SHOULD run in the Worker before the RPC, because the Worker scales and a singleton does not ([ADR-018](../../docs/adr/018-singleton-is-the-scarce-resource.md)); a refusal that does need the DO's data comes back as a value (§ *Errors over raw Workers RPC*). Canonical: the instance-path rows of `router.ts`'s route table, whose terminal steps call the `worker-token.ts` handlers.

The dividing line is **where the endpoint's essence lives** — the DO's data (forward) vs HTTP/cookie/token mechanics (Worker).

⚠️ **Forwarding does NOT expose the singleton to junk traffic.** The edge router matches the endpoint against its known set *before* forwarding, so an unknown path is a `404` at the edge — the DO never sees it (Turnstile additionally fronts the open endpoints). "Forward everything" is not "let the singleton absorb 404s."

## Raw Workers RPC
Raw `stub.method()` is how non-mesh Workers and DOs talk to other DOs, WorkerEntrypoints, and RpcTargets. (Mesh code uses `this.lmz.call` instead — see [mesh.md](mesh.md).) Gotchas:
- Synchronous DO methods become **async over RPC** — tests MUST use `await expect(...).rejects.toThrow()`, not `expect(() => ...).toThrow()`.
- Private (`#`) methods silently return `undefined` over RPC stubs — communication MUST go through public methods or HTTP endpoints.
- **`using` MUST NOT be applied to a DO stub** (nor a service/WorkerEntrypoint binding or facet stub) — it's a local pointer with no `Symbol.dispose`, so `using` throws `"Object is not disposable."` in every environment. Use a plain `const` + `await`; the pointer needs no disposal. `using` is only for a **method-returned RpcTarget session stub** (see [durable-objects.md](durable-objects.md) § Wall-clock billing; verified in `experiments/rpc-stub-disposability/FINDINGS.md`).

## Errors over raw Workers RPC
Workers RPC structured-clones arguments, return values and thrown errors, so rich types (`Date`, `Map`, `Set`, typed arrays, and reference identity within a single call) cross fine. So does an Error, though it arrives as a plain `Error` and without the callee's stack. A Registry method that throws

```typescript
throw new RegistryError(403, 'forbidden', 'not yours', { cause: new TypeError('root cause') });
```

hands the Worker's `catch` this:

| Field | Arrives as |
|---|---|
| `name`, `message` | `'RegistryError'`, `'not yours'` |
| `status`, `errorCode` | `403`, `'forbidden'` — every custom own property survives |
| `cause` | the `TypeError` |
| `instanceof RegistryError` | `false` — a plain `Error` whose `name` is `'RegistryError'` |
| `remote` | `true`, which workerd adds to a thrown error |
| `stack` | the caller's frames only, so it locates the call and not the bug (a *returned* Error keeps just its first line) |

Measured 2026-09-18 on workerd 1.20260815.1, over a DO stub and a service binding alike. The mesh path differs: it keeps the stack, and can restore `instanceof` for a class registered on `globalThis` ([mesh.md](mesh.md) § *Errors across mesh calls*).

- A typed error MUST be detected by `err.name` + property presence, and custom-class `instanceof` MUST NOT be used. A caller MAY read `err.status` and `err.errorCode`.
- **The table describes compat date 2026-04-21 and later**, when `enhanced_error_serialization` turns on by default. `critical.md`'s floor keeps every in-repo Worker past it; a Worker deployed from elsewhere carries no such guarantee. Before that date the same throw arrived as `name: 'Error'` with message `'RegistryError: not yours'` and no `status`, `errorCode` or `cause`, which is how a `nebula-auth` 403 became a 500 on 2026-07-13. `legacy_error_serialization` restores that behavior, and MUST NOT be added to any config.
- **An RPC method SHOULD return its expected refusals as a typed result, and throw only for the unexpected.** The reason is the type system. `claimUniverseWithTicket` returns `{ ok: false, reason: 'invalid_ticket' }`, and the Worker's `SIGNUP_REFUSALS` is a `Record` keyed on those reasons, so a new reason does not compile until it has a message. A thrown refusal appears in no signature, so a caller not written to catch it falls through to its catch-all — a blanket `500` in `nebula-auth`'s router.

The `fetch()`-forwarded path (§ *Edge Worker fronting a DO*) is the alternative: there the DO converts its own `RegistryError` to a `Response` in-process, where `instanceof` works and the stack is whole.

## Hibernation WebSocket API
DOs that accept and push to connected clients MUST use the Hibernation WebSocket API: accept in `fetch()` via `ctx.acceptWebSocket(server)` returning a `101` with the client socket; push with `for (const ws of this.ctx.getWebSockets()) ws.send(message)`; in `webSocketClose` echo the code, but `1005` ("no status present") MUST be mapped to `1000` since `1005` is invalid to send. vitest-pool-workers tests can open real `new WebSocket()` connections to deployed Workers for e2e patterns.

(In the Mesh world, client WebSockets terminate at the Gateway — app/platform DOs never accept their own.)

## Alarms
Schedule directly with `ctx.storage.setAlarm(...)` plus an `async alarm()` handler. (Mesh code uses `this.svc.alarms.schedule(...)` instead, which carries an OCAN continuation — see [mesh.md](mesh.md).)

## Self-referencing service bindings
A Worker binding to its own `WorkerEntrypoint` classes (the `"service"` field matches the Worker's own `"name"`) is a wrangler-config pattern — see [packaging.md](packaging.md) § Self-referencing service bindings.
