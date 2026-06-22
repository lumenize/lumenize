# DevContainer image

The baked image for `DevContainer` (the `DEV_CONTAINER` binding) — a disposable
Cloudflare Container running real **vite** that fronts the Studio dev-loop preview.

- **`Dockerfile`** — `node:22-slim` + git + the baked UI-lib set + the framework
  skeleton (`app/`) + `command-server.mjs`. Deps baked → **zero `npm install` on cold
  boot** (CF containers have no persistent volume; baking is the only durable store).
- **`command-server.mjs`** — PID 1 / vite supervisor on `:9000` (host-DO-only). Endpoints:
  `/healthz`, `/exec`, `/write`, `/apply` (batch — the `applyChanges` receiver),
  `/read`, `/vite/{start,stop,restart}`. Carries the receiver-side path-traversal
  guard (`resolveConfined`); the DO-side `assertSafeRelPath` re-checks (defense-in-depth).
- **`app/`** — the **framework layer** (baked): vite config, `index.html`, `main.ts`,
  the `nebula.ts` bootstrap (reads the server-injected `<meta name="nebula-scope">`),
  HMR wiring, and a trivial seed `App.vue`/`ontology.d.ts`. The **app layer** (the real
  `App.vue`/components/ontology) is **pushed by DevStudio** (`applyChanges`) at runtime.

## Ports
- `:5173` **vite** — public preview shell + HMR, reached via `DevContainer.fetch()`
  (which strips `cf-container-target-port`, so the public path can never reach `:9000`).
- `:9000` **command-server** — host-DO-only, reached exclusively by `DevContainer`'s
  internal `containerFetch`; the command `@mesh` methods carry `@mesh(requireAdmin)`.

## Run with `wrangler dev`
`extends Container` cannot construct under vitest-pool-workers, so the assembled image
(vite boot + HMR + the `applyChanges` round-trip) is exercised by running it with
**`wrangler dev` + Docker Desktop** (WARP — [[cf-container-deploy-proxy]]); a `wrangler deploy`
to Cloudflare is only needed to invite alpha testers. The mechanism is proven on the (torn-down)
`experiments/container-node-phase0` + `experiments/interim-dev-loop` spikes. Pure
helpers + the entrypoint gates are unit-tested (see `test/test-apps/container-node/`
+ `test/test-apps/baseline/dev-container-serve-gate.test.ts`).

`@lumenize/nebula/frontend` (the factory `nebula.ts` imports) is a private workspace
package, so it is **vendored into the image at build** — present only in the assembled
container (exercised by running it with `wrangler dev` + Docker Desktop).
