# Logging in Nebula (apps/nebula + packages/nebula-auth)

**Status (2026-06-02)**: **Complete and archived.** Plan decided + implementation
landed in commit `059bd69`. Six touch points instrumented (by impact):
star.ts handler catches (3 sites) + nebula-auth router.ts 500 catch + dag-tree.ts
typed PermissionDeniedError/NodeNotFoundError + entrypoint.ts JWT debug logs +
nebula-client.ts silent client-side warns + router.ts sub-catches. Namespace
convention `nebula.{Class}.{method}`. Sibling facet-logging task shipped just
before this one (commit `ac88a60`). callId-into-CallContext follow-up captured
in tasks/nebula-scratchpad.md § Mesh Infrastructure (commit `1d51430`).

> Findings captured 2026-06-01 on branch `claude/mesh-nebula-logging-audit-q4P5U`.
> Plan section added 2026-06-02. Verified file:line citations against current
> tree (some have drifted slightly — see Plan section for current locations).
> Facet-validation logging is tracked separately in
> `tasks/logging-parser-validator-and-facets.md`.

## Headline

Nebula's logging is **bimodal**: `packages/nebula-auth` is well-instrumented;
`apps/nebula/src` is almost entirely dark. The namespace convention, where used,
is clean and consistent — the gap is **coverage**, not quality.

## What's already good (`packages/nebula-auth/src`)

- **`nebula-auth.ts`** — ~31 log calls covering login flows, token
  management, subject CRUD, access denials, actor delegation. All ~19 catch
  blocks log. Reads as production-grade auth audit logging.
  - Namespaces: `nebula-auth.NebulaAuth.login.succeeded`,
    `…access.denied`, `…token.revoked`, `…subject.updated`, etc.
- **`nebula-auth-registry.ts`** — ~7 log calls (6 `info`, 1 `error`) on
  registry ops (email mgmt, claim universe/star, create galaxy).
  - Namespaces: `nebula-auth.Registry.claimUniverse`, etc.

**Namespace convention (consistent):** `nebula-auth.{Class}.{feature}.{action}`.
No casing/separator drift found.

## Findings — the gaps

### `apps/nebula/src` has effectively zero `@lumenize/debug` usage

Significant files with NO logging:

- **`star.ts`** — request-dispatch handler. Catch blocks (~225, ~288) in the
  transaction/read handlers propagate the error to the client but log **nothing**
  locally — critical RPC dispatch points with no observability.
- **`resources.ts`** — temporal/Snodgrass versioning state machine, eTag
  conflict detection, debouncing — no logging. (Facet validation portion tracked
  in the sibling task file.)
- **`dag-tree.ts`** — permission engine (cycle detection, cache invalidation,
  node/edge CRUD) — silent.
- **`entrypoint.ts`** — edge JWT verification + routing to /auth and /gateway —
  silent.
- **`universe.ts`**, **`galaxy.ts`** (ontology version mgmt / compilation),
  **`nebula-do.ts`** (scope locking), **`nebula-client-gateway.ts`**
  (active-scope verification), **`resource-history.ts`** — no logging.
- Pure-logic / barrel / types files (`dag-ops.ts`, `index.ts`,
  `client-index.ts`, `schemas.ts`, `types.ts`, `parse-id.ts`) — no logging is
  acceptable.

### Silent error paths

- **`packages/nebula-auth/src/router.ts`** — top-level catch (~line 133)
  returns a generic 500 with **no log**. Silent failure point on the auth
  dispatcher. (Other catches in `router.ts` at ~162/193/239 are JSON/validation
  failures, also unlogged.)
- **`star.ts`** (~225, ~288) — error propagated to client, not logged locally.
- `nebula-auth-registry.ts` (~206, ~264) — unlogged, but **acceptable**: they
  re-throw a structured `RegistryError` that the HTTP handler (~353) logs.

### Raw `console.*` instead of the debug package

- **`apps/nebula/src/nebula-client.ts`** lines ~58 and ~64 — two
  `console.warn` Phase-5.3 placeholders (`handleTransactionResult` /
  `handleReadResult` not yet implemented). Low priority; convert when those
  handlers are implemented.

## Updates since the audit

- `nebula-client.ts` no longer has the two `console.warn` Phase-5.3
  placeholders the audit flagged at ~lines 58/64 — they've been refactored
  out and a proper `log.warn` at the auto-subscribe failure path
  ([apps/nebula/src/nebula-client.ts:552](apps/nebula/src/nebula-client.ts:552))
  is the current state. The "raw console.*" section of the findings is
  obsolete; no `console.*` calls remain in `apps/nebula/src` or
  `packages/nebula-auth/src`.
- `star.ts` has **three** silent @mesh-handler catches now (transaction, read,
  subscribe) — the audit named two. Line numbers below.

## Plan

### Conventions

- **Namespace**: `nebula.{Class}.{method}` for `apps/nebula/src`, matching the
  existing `nebula-auth.{Class}.{feature}.{action}` style in
  `packages/nebula-auth/src`. Sub-events as further dot-segments only when a
  single method has multiple distinct loggable outcomes
  (e.g. `nebula.Star.subscribe.fanoutDropped`).
- **Levels**:
  - `error` — system failure, must always output (current silent-catch sites,
    top-level dispatcher 500s, RPC delivery failures).
  - `warn` — expected-but-noteworthy failures (JWT reject, validation rate,
    silent client-side fallbacks firing).
  - `info` — operational milestones, rare events (deploys, first-time
    ontology installs, cold facet load — covered in sibling task).
  - `debug` — trace / decision points / hot-path tracing; off by default.
- **Success-path policy**: don't log on success unless it's a cold milestone.
  Hot paths (every transaction, every read, every subscribe) emit nothing on
  success. The structured result the caller receives is the success record.
- **Correlation IDs — OUT of scope.** Mesh exposes `callContext.callChain`
  (see `star.ts` for examples reading `callChain[0]?.instanceName`).
  `callId` is **NOT** propagated on `CallContext` — it lives only on the
  wire-level message types in `gateway-messages.ts`, not in the per-call
  context handlers see. Use `clientId` (from `callChain[0]?.instanceName`)
  + `ontologyVersion` + timestamp for correlation. No new tracing
  infrastructure. If observability gaps remain after this lands, file a
  follow-up — don't conflate basic coverage with distributed tracing.

### `apps/nebula/src/star.ts` — three silent @mesh-handler catches (highest priority)

All three follow the same pattern: pack the error into the result and send to
the client gateway via `lmz.call`. None log locally. These are the most
load-bearing observability gaps in apps/nebula.

| Catch | Method | Namespace | Level |
|---|---|---|---|
| [star.ts:263](apps/nebula/src/star.ts:263) | `transaction` Handler 2 | `nebula.Star.transaction` | `error` |
| [star.ts:327](apps/nebula/src/star.ts:327) | `read` Handler 2 | `nebula.Star.read` | `error` |
| [star.ts:400](apps/nebula/src/star.ts:400) | `subscribe` Handler 2 | `nebula.Star.subscribe` | `error` |

Each catch logs before fire-and-forward to the gateway:

```typescript
} catch (err) {
  debug('nebula.Star.doTransaction').error('handler threw', {
    clientId,
    ontologyVersion,                                    // already in scope at each call
    bundleId: this.#row ? `${this.#galaxyId}/${this.#row.version}` : undefined,
    error: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : undefined,  // catches typed errors (OntologyStaleError, etc.)
  });
  this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId, /* ...existing forward... */);
}
```

The `bundleId` field is included on the `doTransaction` catch only, matching
the field naming the sibling facet-logging task established. `doRead` and
`doSubscribe` include `resourceId` (and `resourceType` for subscribe) instead —
the operationally relevant context for those handlers.

### `packages/nebula-auth/src/router.ts` — top-level 500 dispatcher catch

[router.ts:133](packages/nebula-auth/src/router.ts:133) — generic 500 returned
without logging. The path here ran through one of `handleRegistryPath` /
`handleInstancePath`; both can throw on unexpected error from `parseId`,
`registryStub.fetch`, `naStub.fetch`, or JWT verification side effects. The
500 hides all of it from the operator.

```typescript
const log = debug('nebula-auth.router.dispatch');
} catch (err) {
  log.error('dispatcher threw', {
    path: new URL(request.url).pathname,
    method: request.method,
    parsedType: parsed.type,
    parsedTarget: parsed.type === 'registry' ? parsed.endpoint : parsed.instanceName,
    error: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : undefined,
  });
  return jsonError(500, 'internal_error', 'An unexpected error occurred');
}
```

Sub-catches at [router.ts:162](packages/nebula-auth/src/router.ts:162),
[router.ts:193](packages/nebula-auth/src/router.ts:193),
[router.ts:239](packages/nebula-auth/src/router.ts:239) are body-parse /
instance-name validation failures — client-input bugs, not system failures.
Log at `debug` (not `warn`) — they're high-volume noise that operators
opt-in to during investigation. Namespace `nebula-auth.router.{bodyParse,instanceParse,turnstileBodyParse}`.

### `apps/nebula/src/entrypoint.ts` — silent JWT rejects

[entrypoint.ts:20-32](apps/nebula/src/entrypoint.ts:20) — `onBeforeConnect`
returns 401 (missing token) or 403 (invalid JWT) without logging. Operators
investigating "why can't user X connect" have no server-side visibility.

```typescript
const log = debug('nebula.entrypoint.onBeforeConnect');
if (!token) {
  log.debug('rejected: missing access token', { url: request.url });
  return new Response('Unauthorized: missing access token', { status: 401 });
}
const jwt = await verifyNebulaAccessToken(token, env);
if (!jwt) {
  log.debug('rejected: invalid JWT', { url: request.url });
  return new Response('Forbidden: invalid JWT', { status: 403 });
}
```

`debug` (not `warn`) — invalid tokens are normal at scale (stale clients,
expired tokens after long sleep). Operators flip it on per-investigation.
No logging on the success / accept path.

The 4 routing branches in the default fetch handler are explicit 501 / 404
responses with no error condition — nothing to log.

### `apps/nebula/src/nebula-client.ts` — three silent client-side catches

These run in the browser/Node client. The framework guarantees a fallback
behavior in each catch body, so the swallow is intentional — but if the
fallback fires, the operator wants to know via debug.

| Catch | Context | Namespace | Level |
|---|---|---|---|
| [nebula-client.ts:811](apps/nebula/src/nebula-client.ts:811) | conflict-resolver threw | `nebula.NebulaClient.handleResult.conflictResolverError` | `warn` |
| [nebula-client.ts:854](apps/nebula/src/nebula-client.ts:854) | user `onShouldRefreshUI` threw | `nebula.NebulaClient.refreshUI.userCallbackError` | `warn` |
| [nebula-client.ts:991](apps/nebula/src/nebula-client.ts:991) | user conflict-resolver threw | `nebula.NebulaClient.runResolver.userResolverError` | `warn` |

`warn` — these signal user-supplied callback bugs, not system failures.
Always-output `error` would noisy the dev console; `warn` is filterable but
visible by default in our debug setup.

```typescript
} catch (err) {
  log.warn('user callback threw — falling back to use-server', {
    error: err instanceof Error ? err.message : String(err),
  });
  this.#finalize(inFlight, this.#useServerOutcome(inFlight, result));
}
```

### `apps/nebula/src/resources.ts` — permission catch & TODO

[resources.ts:387](apps/nebula/src/resources.ts:387) currently distinguishes
typed `TransactionError` from "Node X not found" / "Authentication required"
via fragile string matching, with a TODO to make `dag-tree.ts` throw typed
errors. The catch itself doesn't need a log (the fall-through is into the
returned `validationErrors`/`permissionErrors` maps the caller handles).

Add the typed errors in `dag-tree.ts` as part of this same pass — both
`PermissionDeniedError` and `NodeNotFoundError`. The audit's "Cross-Boundary
Typed Errors" rule from `CLAUDE.md` already documents the pattern. This
removes one fragile string-match and makes the catch correct-by-construction.

### What is NOT changing

- `packages/nebula-auth/src/nebula-auth.ts` and `nebula-auth-registry.ts` —
  already well-instrumented (~31 + ~7 log calls). The audit found no quality
  gap there.
- Pure-logic / barrel / types files (`dag-ops.ts`, `index.ts`,
  `client-index.ts`, `schemas.ts`, `types.ts`, `parse-id.ts`) — no logging
  needed.
- No success-path instrumentation on hot paths.
- No distributed-tracing infrastructure (no propagation of a per-request
  correlation ID beyond the existing `callContext.callChain`).

## Sequencing

Land in this order — instrumentation by impact, not by file:

1. **`star.ts` handler catches** (highest value — three load-bearing silent
   failures in the hot path).
2. **`router.ts` dispatcher 500 catch** (operator-blind production failure
   path).
3. **`dag-tree.ts` typed errors + the `resources.ts:387` catch simplification**.
4. **`entrypoint.ts` JWT-reject debug logs**.
5. **`nebula-client.ts` silent-fallback warns**.
6. **`router.ts` sub-catches** (validation/parse fail debug logs).

1–3 are the high-value coverage; 4–6 are the polish. The sibling facet
plan lands alongside (1) since both touch `star.ts` and need to agree on
field naming (`bundleId`, `requestCount`, `ontologyVersion`, `clientId`).
