# Logging in Nebula (apps/nebula + packages/nebula-auth)

**Status**: Findings captured — plan TBD (discussion pending)

> This file records what an audit on 2026-06-01 found about `@lumenize/debug`
> usage across Nebula. It is **findings, not a plan** — what to instrument and
> at what level will be decided in a follow-up discussion.
> Branch where the audit ran: `claude/mesh-nebula-logging-audit-q4P5U`.
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

## Observations for the discussion (NOT a committed plan)

- Adopt the existing `nebula-auth` namespace style in `apps/nebula`
  (e.g. `nebula.Star.transaction`, `nebula.DagTree.resolve`).
- Highest-value first instrumentation targets: `star.ts` dispatch + error
  paths, `router.ts` top-level catch, `entrypoint.ts` JWT/routing, `dag-tree.ts`
  permission resolution, `resources.ts` conflict detection.
- Log-level balance: nebula-auth currently leans `info`/`warn`; `apps/nebula`
  would benefit from `debug`-level trace on hot control flow + `error` on the
  genuinely silent catches.
- Possible cross-cutting want: correlation IDs to trace a request across DO
  boundaries (Star → Galaxy → facet). Decide whether in scope.
