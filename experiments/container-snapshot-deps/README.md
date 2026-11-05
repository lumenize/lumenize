# container-snapshot-deps

**Question:** can Cloudflare's container snapshots, shipped 2026-09-30 with the `durable_object`
scheduling policy, replace baking dependencies into Nebula's build-box image?

Findings, and the outline for the session that drafts the task file, are in [RESULTS.md](RESULTS.md).
The item this feeds is `tasks/nebula-pre-alpha-fast-follow.md` § *Item 11*.

## What it measures

One Durable Object class, `Probe`, drives a container through raw `ctx.container`, the same way
`apps/nebula/src/galaxy.ts` does. Each op runs on a fresh DO name, so it gets a fresh container, and
destroys the container when done — the build box's ephemeral shape.

| Op | What it does |
|---|---|
| `start` | cold start → ready, on the managed `cloudflare/debian-trixie` image and on our own |
| `fresh` | no snapshot: the `baked` image builds as-is; the `plain` image runs `npm ci`, then builds |
| `snap` | `plain` installs and builds, then `snapshotContainer()` saves it |
| `restore` | start from the snapshot with `enableInternet: false`, then build |
| `tie` | restore after the image has changed |

The app under `image/app/` is Nebula's baked scaffold set plus the four heavy libraries
`experiments/computer-vfs-build` used, and its `vite.config.ts` runs the same native binaries Nebula's
does — rolldown, swc, tailwind's oxide and lightningcss. A restored tree that cannot exec one of
them fails the build.

## Running it

Standalone, not a root workspace: it needs wrangler 4.135 or later, and the repo pins 4.124.0.

```bash
cd experiments/container-snapshot-deps && npm install
```

Local, on Docker Desktop:

```bash
npm run dev
```

```bash
node scripts/drive.mjs http://localhost:8799 all 1
```

Deployed (WARP on for the image push, per the `cf-container-deploy-proxy` memory):

```bash
npm run deploy
```

```bash
node scripts/drive.mjs https://experiment-container-snapshot-deps.<account>.workers.dev all 3
```

The image-tie test needs a redeploy between its halves: run `snap`, change `plain`'s `MARK` in
`wrangler.jsonc`, deploy, then run `tie`. Snapshot handles persist in `results/handles-<venue>.json`
for 30 days.

The deployed Worker waits for Larry's `experiment-*` sweep. Its container application does not go
with a Worker delete; see `.claude/rules/containers.md` § *Local dev*.
