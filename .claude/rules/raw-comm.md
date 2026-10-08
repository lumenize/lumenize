---
paths:
  - "packages/auth/**/*.ts"
  - "packages/testing/**/*.ts"
  - "packages/ts-runtime-parser-validator/**/*.ts"
  - "packages/mesh/**/*.ts"
  - "apps/nebula/src/**/*.ts"
  - "packages/resources/**/*.ts"
---

# Communicating Without Mesh (raw DO and Workers)

How a DO is invoked and how it talks when it is **not** on the Mesh abstraction. This applies to two kinds of code:
- **Raw-DO infrastructure** — packages that deliberately `extend DurableObject` (not `LumenizeDO`) and have their own model: `auth`, `nebula-auth`, `testing`, `ts-runtime-parser-validator`.
- **Mesh's own framework internals** — the parts of `packages/mesh` that build the abstraction with raw primitives, e.g. `ClientGateway`, which a scoped node composes to accept its Clients' sockets with the hibernation API.

**`apps/nebula` reaches a node in exactly two ways, and its Worker reaches a Durable Object's `fetch` in exactly one.** Its business logic — Galaxy, Star, Universe, Resources — reaches a node only over the mesh ([mesh.md](mesh.md)) or through a `@rawRpc()`-decorated method by `rawRpcStub`; and its Worker reaches a Durable Object's `fetch` only through the forwards `npm run audit:do-http` lists (§ *What reaches a Durable Object's `fetch`*). This file loads on `apps/nebula/src` for that section and the page track; if you are writing platform logic and reaching for any other primitive below, you're in the wrong file. (Which layer am I? → [workers-projects.md](workers-projects.md).) Local DO correctness — storage, sync methods, etc. — still applies regardless: [durable-objects.md](durable-objects.md).

## Route pattern (`fetch()`)
HTTP routes SHOULD be handled in `fetch()` via URL path matching, delegating to `#`-prefixed handler methods. Direct `if` matching is efficient enough for a handful of routes.

**A third-party router dependency MUST NOT be added.** Where a route *table* with ordered middleware is genuinely warranted, that shape is already in-repo — `packages/mesh/src/auth/route-pipeline.ts`, a small runner written against the path-parameter and middleware-list patterns those libraries popularised, with no dependency and no public-API commitment. It is `nebula-auth`-local by design (`@lumenize/routing` is published MIT, so a runner there would be semver-bound); another package that outgrows `if` matching writes its own rather than importing this one or adding a dep.

```typescript
async fetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'POST' && pathname === '/login') return this.#handleLogin(request);
  return new Response('Not found', { status: 404 });
}
```

For Workers that dispatch to multiple DOs, use a prefix-matching helper, like `routeDORequest` that returns `undefined` on no-match and composes with `||`. Under `apps/` every call MUST pass `bindings`, the allow-list of bindings it may reach; an unlisted binding answers `undefined` before any Durable Object is constructed:
```typescript
return (await routeDORequest(request, env, { prefix: '/auth', bindings: ['AUTH'] })
  || await routeDORequest(request, env, { prefix: '/docs', bindings: ['DOCS'] })
  || new Response('Not found', { status: 404 }));
```

## Edge Worker fronting a DO: forward the request, or handle it in the Worker?

When an edge Worker router fronts a backing DO (canonical: `nebula-auth`'s Worker → the Registry singleton), each route takes one of two shapes — and the choice is consistent, not ad-hoc:

- **Forward the request to the DO's `fetch()`** when the endpoint's job **IS the DO's data operation** and the edge has nothing to add to it. The edge does only the cross-cutting pre-checks that need env or secrets — the same-origin rule, the rate limiter, Turnstile — then forwards **the ORIGINAL request, `stub.fetch(request)`**: no parse, no re-serialize, and every header survives. ⚠️ A body-reading pre-check MUST `request.clone()` (Turnstile does), or it consumes the body and forecloses the forward. The DO reads `url.origin` etc. **itself** — origin is *not* threaded as an RPC arg — and owns its **error→Response** conversion in-process. Canonical: `router.ts`'s `forwardRaw`, the terminal of the two open claim rows, `claim-universe` and `claim-star`.
- **Handle it in the Worker, with narrow RPC calls,** when the endpoint is an **HTTP/session concern** — a cookie set or cleared, a redirect, a link's token, a read that starts in Workers KV. The Worker owns the `Response` and RPCs the DO only for the specific data it needs (`registry(env).lookupLink(...)`, `consumeLink(...)`, `recordSessions(...)`). The refresh is the model: a KV read on the hit path, and one Registry read only when KV's answer would refuse — a miss, or a membership still pending. A check that needs none of the DO's data — a request's shape, its `Origin`, a cookie's name — SHOULD run in the Worker before the RPC, because the Worker scales and a singleton does not ([ADR-018](../../docs/adr/018-singleton-is-the-scarce-resource.md)); a refusal that does need the DO's data comes back as a value (§ *Errors over raw Workers RPC*). Canonical: every other row of `router.ts`'s route table, whose terminal steps call the `worker-token.ts` handlers.

The dividing line is **where the endpoint's essence lives** — the DO's data (forward) vs HTTP/cookie/token mechanics (Worker).

⚠️ **Forwarding does NOT expose the singleton to junk traffic.** The edge router matches the endpoint against its known set *before* forwarding, so an unknown path is a `404` at the edge — the DO never sees it (Turnstile additionally fronts the open endpoints). "Forward everything" is not "let the singleton absorb 404s."

## What reaches a Durable Object's `fetch`

A mesh node's `fetch` hears from four kinds of caller, and each MUST keep to a track of its own. Without the tracks they are kept apart only by which paths each forward happens to produce, so a page forward that kept its host's path would reach the Galaxy's container path `/api`, and could set the `x-lumenize-*` headers mesh stamps a node's name from.

- **Pages, only under `/_public/`.** The Worker's page step forwards through one helper, `forwardPage` in `apps/nebula/src/page-forward.ts`, which moves the path under `/_public/` — `https://dev.crm.acme.lumenize.dev/assets/app.js` arrives as `/_public/assets/app.js` — answers anything but `GET` and `HEAD` with a 405 carrying `Allow: GET, HEAD`, refuses an `Upgrade` with a 426, and strips every client-sent `x-lumenize-*` header before setting its own. A new host's page MUST be a row in the page step that names its binding, never a second forward.
- **A Client's upgrade, only under `/gateway/`.** A page's Client upgrades at `/gateway/{id}` on its own host, and the Worker turns `https://tenant1.crm.acme.lumenize.dev/gateway/alice.9f2c41aa` into `/gateway/STAR/acme.crm.tenant1/alice.9f2c41aa` for `routeDORequest`, whose `bindings` name `UNIVERSE`, `GALAXY` and `STAR` alone. Before routing it verifies the token, requires its `aud` to be the scope the host spells (a persona's host spells its `.dev` Star) and its `sub` to begin the id, and strips every client-sent `x-lumenize-*` header, so no upgrade reaches a node without a valid token for its host whose `sub` begins the id. The node's own refusals, of a missing `lmz.2` subprotocol, a tag over 256 characters or an encoded `/` in the id, come after it wakes. `NebulaDO.onRequest` hands that prefix to the `ClientGateway` it composes, which reads the token without verifying it, so a node MUST recognize the upgrade by its prefix, never by an `Upgrade` header: the Galaxy's container dials back to `/api` with an upgrade carrying a Bearer.
- **Our own code, never by `fetch`.** It calls a `@rawRpc()`-decorated method through `rawRpcStub` (`@lumenize/mesh/raw-rpc`), whose one entry stamps the callee's identity and refuses any undecorated name ([ADR-023](../../docs/adr/023-the-mesh-boundary-is-crossed-at-a-bridge.md)). An operation only our own code may invoke MUST NOT be a path on a node's `fetch`.
- **A node's own container, only at the paths its library fixes.** Today that is the Galaxy's `/api`, where `@cloudflare/computer`'s `WorkspaceProxy` dials back. No page forward can produce it, because every page path starts `/_public/`.

A node's `onRequest` MUST compare the path only against the prefixes its class registers in a static `HTTP_PREFIXES` array, and answer 404 to anything else — `NebulaDO.HTTP_PREFIXES` holds `GATEWAY_PREFIX`, and `Galaxy.HTTP_PREFIXES` adds `PUBLIC_PREFIX` and `'/api'`.

One other forward carries page traffic into a Durable Object's `fetch`, and its target is no mesh node: nebula-auth's `forwardRaw` sends the claim `POST`s to the Registry, a raw Durable Object that reads no identity header.

**`npm run audit:do-http` is the proof.** It scans source, never tests: every `src` tree under `apps/`, the Resources plane in `packages/resources/src` and Mesh's auth layer in `packages/mesh/src/auth` for all four checks, and for the third every class in `packages/mesh/src` that declares `HTTP_PREFIXES`. It checks four things:

1. every member `.fetch(` is a named forward, or names a binding the generated `Env` declares as something other than a Durable Object namespace;
2. every `routeDORequest` call passes `bindings`;
3. every mesh node's `onRequest` compares the path only against its `HTTP_PREFIXES`;
4. no Durable Object stub is made except in a named forward or, inside Mesh's auth layer, for its own Registry — so an inline `getByName(…).teardown()` that skips `rawRpcStub` fails it.

It prints what it checked on every run, so a pass is never an empty line. A new forward or a new non-Durable-Object `.fetch(` MUST be added to its tables by name, with the reason.

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
DOs that accept and push to connected clients MUST use the Hibernation WebSocket API: accept in `fetch()` via `ctx.acceptWebSocket(server)` returning a `101` with the client socket; push with `for (const ws of this.ctx.getWebSockets()) ws.send(message)`; in `webSocketClose` echo the code, but `1005` ("no status present") MUST be mapped to `1000` since `1005` is invalid to send. vitest-plugin tests can open real `new WebSocket()` connections to deployed Workers for e2e patterns.

(In the Mesh world a Client's socket is accepted by `ClientGateway`, composed into the node that hosts it — `NebulaDO`, for every Nebula scope — and no other platform code accepts one.)

## Alarms
Schedule directly with `ctx.storage.setAlarm(...)` plus an `async alarm()` handler. (Mesh code uses `this.svc.alarms.schedule(...)` instead, which carries an OCAN continuation — see [mesh.md](mesh.md).)

## Self-referencing service bindings
A Worker binding to its own `WorkerEntrypoint` classes (the `"service"` field matches the Worker's own `"name"`) is a wrangler-config pattern — see [packaging.md](packaging.md) § Self-referencing service bindings.
