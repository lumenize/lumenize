# Does `request.cf` survive into a Durable Object's `fetch()`?

**Date**: 2026-06-12 · **wrangler**: 4.86.0 · **compatibility_date**: 2026-03-12 · deployed to `do-request-cf-probe.transformation.workers.dev` (deleted after measurement). Deploy-only probe — no `package.json` on purpose, so it is intentionally NOT in the root `workspaces` list.

## Question

Community lore (and several Discord/forum threads) says `request.cf` is undefined inside a DO when a Worker forwards a request via `stub.fetch()`, requiring cf fields to be copied into headers at the edge. CF's own in-memory-state example reads `request.cf.city` inside a DO, contradicting that. Which is true in production today? And does our `routeDORequest` rebuild pattern (`new Request(request, { headers })` — [route-do-request.ts:387](../../packages/routing/src/route-do-request.ts)) drop `cf` even if raw forwarding preserves it?

## Method

Worker + DO, three forwarding variants, each echoing what the DO's `fetch()` sees in `request.cf` alongside the Worker-side ground truth:

| Path | Forwarding | Worker saw | DO saw |
|---|---|---|---|
| `/raw` | `stub.fetch(request)` (original eyeball Request) | full cf (31 keys, colo=IAD) | **identical full cf (31 keys)** |
| `/rebuilt` | `stub.fetch(new Request(request, { headers }))` — routeDORequest's exact pattern | full cf | **identical full cf** |
| `/rebuilt-with-cf` | `new Request(request, { headers, cf: request.cf })` | full cf | **identical full cf** |

## Conclusions

1. **`request.cf` DOES survive `stub.fetch()` into a DO** in production (2026-06). The "undefined in DOs" lore is wrong today.
2. **`new Request(request, { headers })` does NOT drop `cf`** — no need to pass `cf` explicitly in init when rebuilding from an existing Request.
3. Implication for mesh `originRequest`: the **Gateway DO can read `request.cf` directly in its WebSocket-upgrade handler** — no Worker-side header injection needed for geo data.

## Caveats

- miniflare/vitest-pool-workers **fakes** `request.cf` locally — local tests cannot validate this; only a deployed probe can. Re-run this probe if behavior ever looks suspect after a runtime/compat-date change.
- `/rebuilt-with-cf` proves an intermediate Worker *can* forge `cf` via `new Request(req, { cf: fake })`. Ours never does, and external clients cannot (the runtime sets `cf` at the edge; clients can only influence headers). Trust statement: `request.cf` at a DO is trustworthy iff every Worker between edge and DO is ours.
