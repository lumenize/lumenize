# Experiment: Workers RPC stub disposability + `using` semantics

Settles whether a Workers RPC stub is **disposable** (`Symbol.dispose` present, so `using` works) and
whether that answer **differs by environment** — the question that arose when
`using registry = env.NEBULA_AUTH_REGISTRY.getByName(...)` threw **"Object is not disposable"** under
vitest-pool-workers. See `tasks/rpc-stub-disposability.md` for the full framing.

## Hypotheses
- **H1 (local-pointer):** a DO stub / service binding stub is a *local pointer* that connects at call
  time and tears down immediately — nothing to dispose, so **no `Symbol.dispose` in ANY environment**.
  Only a **method-returned RpcTarget** holds a server-side *session* and is therefore disposable. This
  predicts the identical result in pool-workers, `wrangler dev`, and deployed.
- **H2 (test-harness stripping):** `cloudflare:test` proxies the DO namespace and *strips*
  `Symbol.dispose`, so **real workerd** (`wrangler dev` + deployed) DO stubs *are* disposable and only
  pool-workers throws.

**Discriminator:** `wrangler dev` is real local workerd with **no `cloudflare:test` proxy**. If DO
stubs still lack `Symbol.dispose` there, H2 is refuted and H1 stands; deployed is gold-standard
confirmation.

## The 6 stub kinds probed (`src/probe.ts`)
1. DO stub via `env.PROBE.get(idFromName)`
2. DO stub via `env.PROBE.getByName`
3. RpcTarget returned from a **DO** method (`ProbeDO.getCap()`)
4. RpcTarget returned from a **WorkerEntrypoint** method (`ProbeEntrypoint.getCap()`)
5. The **WorkerEntrypoint binding** stub itself (`env.SELF_SERVICE`)
6. **DO facet** stub (`ctx.facets.get(...)`) — best-effort (needs a recent runtime)

Plus two behavioral tells: DO state persists across a fresh stub (pointer), and an RpcTarget's session
is per-stub (fresh cap ⇒ counter resets).

## Toolchain note
Deliberately **NOT** a root `workspaces` member: it pins the **latest** `wrangler` / `vitest` (to reach
DO facets), and the monorepo's `wrangler: ^4.86.0` would otherwise hoist the newer version repo-wide.
Standalone install keeps it isolated.

## Run
```sh
cd experiments/rpc-stub-disposability
npm install
npm run types            # generates worker-configuration.d.ts

# pool-workers (miniflare)
npm test                 # matrix printed between POOL_WORKERS_MATRIX_BEGIN/END

# wrangler dev (real local workerd)
npm run dev              # then: curl 'http://localhost:8787/probe?runtime=wrangler-dev'

# deployed (real Cloudflare) — throwaway worker, delete after
npm run deploy           # then: curl 'https://rpc-stub-disposability.<subdomain>.workers.dev/probe?runtime=deployed'
npm run delete
```

Results + resolved hypothesis captured in `FINDINGS.md`.
