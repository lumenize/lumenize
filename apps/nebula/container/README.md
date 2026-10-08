# Build-box image

The baked image for the Galaxy's **ephemeral build box** — a stateless Cloudflare
Container that exists only for the duration of one `vite build`. `computerd`
(the `@cloudflare/computer` daemon) is PID 1: it FUSE-mounts the Galaxy's SQLite VFS at
`/workspace` and executes `runtime.exec` commands against it. There is no dev server, no
HMR, no command-server, and no push step in either direction — the mount IS the transfer
(source is already there; `dist` is already back in the Galaxy's VFS when the exec
resolves).

- **`Dockerfile`** — the proven computerd recipe (`debian:stable-slim` + nodesource
  Node 24 + `fuse3`; see the header for why not `node:*-slim`) + the baked dep tree at
  the image **root** (`/node_modules`, from `app/package.json`). Node resolution from
  `/workspace` walks up to `/node_modules`, so deps never live in the mount — never
  crossing FUSE, never landing in DO SQLite (the containers.md pin).
- **`app/`** — the **framework scaffold**, and this directory is its EDITABLE source of
  truth: `scripts/gen-scaffold.mjs` embeds it into `src/scaffold-seed.ts` (committed;
  the package `test` script runs `--check` so drift is loud), and the Galaxy seeds it
  into its own Workspace VFS at git-init. The image itself only consumes
  `app/package.json` (the baked deps). `vite.config.ts` builds with `base: './'` —
  the serve injects `<base href>` per request (`src/serve.ts`).

## Lifecycle (driven from `Galaxy`, raw `ctx.container`)

One build = one container: the loop's `build` tool (or the admin `buildNow()`) runs
`ws.runtime.exec('vite build')`; the `CloudflareContainerBackend` starts the container,
health-probes readiness, and attaches `ctx.container.monitor()` on every start (the
containers.md homework, done by the vendor); the exec's own sync bracket lands `dist/`
in the Galaxy's VFS; the container is destroyed after. Overlapping builds queue on the
Galaxy's promise-chain latch. A container that never outlives a build cannot reach the
cloud-only stuck state — that apparatus is designed away, not recovered from.

## Verify with `wrangler dev` + Docker Desktop

`npx tsx apps/nebula/harness/drive.ts build-box` drives the whole contract (sequential
builds, overlap, buildError vs retryable, the serve readback). ⚠️ Local runs prove the
**drive**, never the **mount**: `wrangler dev` exposes no `/dev/fuse`, so computerd
degrades to its userspace shim — mount-dependent criteria are verified DEPLOYED (an
`experiment-*` Worker), per `containers.md`.
