# FINDINGS — Workers RPC stub disposability + `using` semantics

**Run:** 2026-07-15 · toolchain pinned to `wrangler 4.111.0` (workerd `1.20260710.1`),
`@cloudflare/vitest-pool-workers 0.18.5`, `vitest 4.1.10` · compat date `2026-07-10`.

## Verdict

**H1 (local-pointer) is CONFIRMED. H2 (test-harness stripping) is REFUTED.** The three environments —
vitest-pool-workers (miniflare), `wrangler dev` (real local workerd), and **deployed** (real
Cloudflare) — returned a **byte-for-byte identical** matrix. The earlier inference that this was a
"miniflare-only quirk, real DO stubs are disposable" is **wrong**: pool-workers is faithful to real
workerd here, and no environment makes a DO stub disposable.

## The matrix (identical in ALL THREE environments)

| # | stub kind | `Symbol.dispose` | `Symbol.asyncDispose` | `constructor.name` | `using` throws? |
|---|---|---|---|---|---|
| 1 | DO stub via `env.NS.get(idFromName)` | `undefined` | `undefined` | `DurableObject` | **yes** |
| 2 | DO stub via `env.NS.getByName(name)` | `undefined` | `undefined` | `DurableObject` | **yes** |
| 5 | WorkerEntrypoint binding (`env.SERVICE`) | `undefined` | `undefined` | `Fetcher` | **yes** |
| 4 | **RpcTarget returned from a WE method** | **`function`** | `undefined` | `RpcStub` | **no** |
| 3 | **RpcTarget returned from a DO method** | **`function`** | `undefined` | `RpcStub` | **no** |
| 6 | **DO facet stub** (`ctx.facets.get`) | `undefined` | `undefined` | `Fetcher` | **yes** |

`using` throw message, every throwing row: **`"Object is not disposable."`** — the exact string that
started this investigation (`profile.ts` `lookupProfileScopes`).

**Behavioral tells** (identical in all three):
- `doStatePersistsAcrossFreshStub: true` — write via one DO stub, drop it with **no** dispose, read
  back via a **fresh** stub → the value is there. The stub was a pointer; there was nothing to release.
- `rpcSessionIsPerStub: true` — a `ProbeCap` (RpcTarget) counter increments to 1, 2 on one stub;
  a **fresh** `getCap()` starts again at 1. Each RpcTarget is a distinct server-side session.

Raw captures: `matrix-raw-pool-workers.json`, `matrix-raw-wrangler-dev.json`, `matrix-raw-deployed.json`
(gitignored `*-raw-*.json` intermediates; this table is the record).

## Why (the mechanism)

A **DO stub, a service/WorkerEntrypoint binding stub, and a facet stub are local pointers.** They carry
no server-side session — each call opens a connection, dispatches, and tears down immediately. There is
nothing to keep alive, therefore nothing to dispose, therefore **no `Symbol.dispose` in any
environment**, and `using` on one is meaningless — it throws `"Object is not disposable."`

An **RpcTarget returned from a method is a session.** The server holds the live object (here, a
`ProbeCap` with its `#counter`) so the caller can keep calling it; the returned `RpcStub` carries
`Symbol.dispose` so the caller can **release that session** when done (otherwise it lives until the
stub is GC'd / the caller context ends). This is the object-capability pattern.

That asymmetry is exactly why Cloudflare's docs show `using` for **RpcTarget / WorkerEntrypoint
return values** but **never for DO stubs** — it was never an oversight.

## Secondary observations

- **`Symbol.asyncDispose` is absent even on the disposable `RpcStub`** (only the sync `Symbol.dispose`
  is present). `await using` on an `RpcStub` still works — the explicit-resource-management protocol
  falls back to `Symbol.dispose` when `Symbol.asyncDispose` is missing. So `await using` is never
  *required* over plain `using` for these stubs.
- **`using` message is transform-shaped, but the ground truth isn't.** The `"Object is not
  disposable."` text comes from the down-level helper; all three environments use esbuild and produced
  the same string. The decisive signal is `typeof stub[Symbol.dispose]`, which is pure runtime and
  agreed across all three regardless of transform.
- **H3 (facets) answered:** a DO facet stub is a `Fetcher` with **no** `Symbol.dispose` — it behaves
  like a DO/service pointer, not like an RpcTarget. Facets ran fine on the latest toolchain in **all
  three** environments (including deployed real-CF), so this is a solid answer, not a deferral.

## Implications for the repo (the record to correct)

1. **`reference_using_on_do_stub_not_disposable.md` memory** — finalize: not miniflare-only; universal;
   H1. `using` is for **method-returned RpcTarget / WorkerEntrypoint session stubs only**, never DO /
   service / facet stubs. Plain `const` + `await` is correct for a DO/service stub in every environment.
2. **`packages/nebula-auth/src/profile.ts`** `lookupProfileScopes` comment — drop the "OPEN question /
   miniflare-only?" hedge; state the resolved rule.
3. **`.claude/rules/durable-objects.md` § Wall-clock billing** — the `using stub = env.MY_DO.get(id)`
   example is **actively wrong** (a DO stub isn't disposable → it throws). Fix the example to a plain
   `const`, and note that `using` applies to RpcTarget/WorkerEntrypoint session stubs. (The wall-clock
   *billing* claim itself was descoped from this experiment and is left as-is / unverified.)
4. **`.claude/rules/raw-comm.md` § Raw Workers RPC** — the "Hold the stub for the narrowest scope
   (`using stub = ...`)" bullet has the same DO-stub-`using` footgun; correct it.
5. **Repo-wide:** grep for any `using` on a `.get(` / `.getByName(` DO stub (or a service binding
   stub) and replace with `const` + `await`.

## Toolchain / hygiene note

Pinned to the **latest** wrangler+vitest to reach DO facets; kept **out of the root `workspaces`** so
the monorepo's `wrangler ^4.86.0` wasn't hoisted up to 4.111 repo-wide (standalone `npm install` in
this dir). The deployed worker was a throwaway (`rpc-stub-disposability.transformation.workers.dev`),
probed, then `wrangler delete`d (confirmed HTTP 404 after). A separate backlog item tracks the real
monorepo-wide toolchain upgrade.
