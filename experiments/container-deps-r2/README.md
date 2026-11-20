# container-deps-r2

**Question:** where should a Galaxy's `node_modules` come from once a user-developer can add dependencies: the image, a container snapshot, an R2 archive, or an R2 FUSE mount?

It follows `experiments/container-snapshot-deps`, which measured snapshots on a single host. A third-party report in Cloudflare's Discord #containers (2026-11-18) says a cold-host restore takes 30–40 s for a 0.5–1 GB snapshot, and that the host cache purges every 10–20 minutes. Findings are in [RESULTS.md](RESULTS.md). The item this feeds is `tasks/nebula-pre-alpha-fast-follow.md` § *Item 11: An R2 archive replaces the deps baked into the build-box image*.

## What it measures

One Durable Object class, `Probe`, drives a container through raw `ctx.container` on `standard-2`, as `apps/nebula/src/galaxy.ts` does. Every op starts a container, builds, and destroys it. The container reaches R2 only through the Worker's own entrypoints, registered with `interceptOutboundHttp`, so builds run with internet off and no credentials enter the container.

| Op | Image | Where `node_modules` comes from |
|---|---|---|
| `baked` | `baked` | the image (today's Nebula shape, the control) |
| `restore` | from the snapshot | a container snapshot: the whole tree, or the per-Galaxy delta |
| `r2full` | `plain` | a `tar.zst` of the whole tree, fetched from R2 and unpacked |
| `r2extras` | `base` | the scaffold baked in, the app's extras from an R2 archive |
| `fuse` | `plain` | s3fs mounting the tree from R2, read-write |

`setup` installs once and produces every artifact: both archives, a snapshot of the whole tree, and a snapshot of the tree without the extras. `delta` restores that base, adds the extras from R2 and snapshots again: one shared base with a per-Galaxy delta on top. `fusesetup` copies the tree into R2 through s3fs, so s3fs writes its own metadata, such as each file's mode.

A **round** restores each snapshot from a reused Durable Object name first (one Galaxy's repeat builds), then from a fresh one (another Galaxy), then runs both R2 arms and the baked control. `rounds` runs one at each gap in minutes, which shows whether a host keeps a snapshot.

The app under `image/app/` is `experiments/container-snapshot-deps`'s: Nebula's scaffold set plus `echarts`, `three`, `date-fns` and `lodash-es`, with the same native binaries Nebula's build runs.

`S3Shim` answers the slice of the S3 API s3fs uses, over the R2 binding. It stands in for Sandbox SDK 1.0's `S3Mount`, which runs the same s3fs behind a Worker gateway, without adding the `@cloudflare/sandbox` dependency or an R2 access key.

`scripts/warm-to-build.mjs <worker>` reads Galaxy's `container warm fired` and `cycle start` markers from Workers Logs, to show how much of a container's start a real turn's generation hides.

## Running it

Standalone, with no dependencies of its own: it runs `apps/nebula`'s pinned wrangler by path. Deployed only. A headless session builds images under a scratch `DOCKER_CONFIG` without `credsStore` (the `docker-credential-helper-headless-hang` memory).

```bash
cd experiments/container-deps-r2 && npm run types && npm run deploy
```

```bash
node scripts/drive.mjs https://experiment-container-deps-r2.<account>.workers.dev setup
```

```bash
node scripts/drive.mjs https://experiment-container-deps-r2.<account>.workers.dev delta
```

```bash
node scripts/drive.mjs https://experiment-container-deps-r2.<account>.workers.dev rounds 0,5,10,15,20,30,45,60,90
```

Handles and archive keys persist in `results/handles.json`.

## Cleanup

The Worker `experiment-container-deps-r2` and the R2 bucket of the same name wait for Larry's `experiment-*` sweep. A Worker delete leaves the container application behind: `wrangler containers list`, then `wrangler containers delete <app-id>`.
