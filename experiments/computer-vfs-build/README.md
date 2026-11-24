# computer-vfs-build — can `@cloudflare/computer`'s FUSE VFS carry our real `vite build`?

Throwaway, deployed spike. Gates the design of
[nebula-galaxy-collapse-and-chat.md](../../tasks/archive/nebula-galaxy-collapse-and-chat.md): if the
FUSE mount carries the build, that task should **not write a source-push at all** — the
container's `/workspace` *is* Galaxy's tree and `applyChanges` stops existing rather than
getting ported. If it doesn't, the task proceeds exactly as designed.

Results: [RESULTS.md](RESULTS.md).

## Why a within-container A/B

[container-cold-start-probe](../container-cold-start-probe/RESULTS.md) measured **colo** as a
~3.5× nuisance variable (EWR 28.1 s vs CMH 7.7 s on identical config), and colo is *assigned,
not chosen*. Comparing a fresh FUSE number against that experiment's 8–10 s baseline across
sessions would therefore measure **placement**, not filesystems.

So both arms run back-to-back inside **one** container, one boot, one colo:

| arm | source | build output | filesystem |
|---|---|---|---|
| **A** | `/workspace/app` | `/workspace/app/dist` | computerd FUSE mirror of DO SQLite |
| **B** | `/var/tmp/app` | `/var/tmp/app/dist` | the container's own ext4 disk |

Identical bytes (`seed/app` is a copy of the real `apps/nebula/container/app` scaffold),
identical baked `/node_modules`. **The headline is the ratio.**

Two design points that keep the comparison honest:

- **`node_modules` is baked at the filesystem ROOT, not in the VFS.** Node resolution from
  `/workspace/app` walks up to `/node_modules`, so both arms resolve the same tree. This is
  also the realistic production shape (Nebula bakes deps; only source is durable) and it
  avoids pushing ~111 MB through FUSE into DO SQLite on every build.
- **A discarded warm-up build runs before either measured arm.** Both arms share vite's
  dep-optimize cache under `/node_modules/.vite`; without the warm-up whichever arm ran first
  would pay to populate it and the second would free-ride.

## Must be measured DEPLOYED

`FUSE_MOUNT=auto` picks the real kernel FUSE backend where `/dev/fuse` is exposed
(Cloudflare Containers) and **silently falls back to a userspace shim under `wrangler dev`**,
which doesn't. A local run measures the shim. The bench records `/proc/mounts` for
`/workspace` in every result so the arm can be thrown out if it ever degrades.

## Run

```bash
npx wrangler deploy
```

```bash
node scripts/drive.mjs 3 2
```

`drive.mjs <runs> <repsPerRun>` uses a fresh instance name per run so each gets fresh
first-touch placement, and times each request from outside as the external-observer
cross-check the clock-traps guidance asks for.

## Teardown

Delete the Worker **from the dashboard** — a project-delete also removes its DO namespaces.
`wrangler delete` leaves them orphaned and there is no CLI to clean them up afterward.
Then drop `experiments/computer-vfs-build` from the root `package.json` `workspaces` list.
