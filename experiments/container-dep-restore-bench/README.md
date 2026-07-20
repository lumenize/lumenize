# container-dep-restore-bench

Point-in-time spike (2026-07-20). **Results and conclusions live in [RESULTS.md](RESULTS.md)** —
this file is just how to re-run it. Per `.claude/rules/workflow.md` § Experiments, this is not a
maintained artifact; expect it to break as the source it samples moves.

## The question

Cloudflare's [Sandbox backup/restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/)
was offered as a stopgap until native container disk snapshots ship. Our container currently
repopulates on every boot, so the pitch sounds relevant. Two things needed measuring before we could
judge it:

1. **What does one user-supplied dep actually cost?** The existing
   `experiments/container-dep-install-bench` measured a **clean** install of the whole curated set
   (20.1 s). That's the wrong baseline for "a user adds a library" — the curated set is already baked
   into the image, so the real question is the **incremental** install on top of it. Larry, 2026-07-20:
   *"I'm guessing Tailwind is the biggie since it has a binary, oxide."*
2. **If a restore mechanism did exist, would it beat that?** Bake off the restore shapes against each
   other and against plain `npm install`, end-to-end through an actual `vite build`.

## Layout

| path | what |
|---|---|
| `fixture/` | the DevContainer app skeleton (copied from `apps/nebula/container/app/`) with a heavier `App.vue` so `vite build` does representative work. `nebula.ts`/`ontology.d.ts` removed — they import `@lumenize/nebula/frontend`, which is vendored at deploy build and unresolvable here. |
| `Dockerfile.baked` | mirrors the **shape** of our real dep layer (curated install, npm cache left in place). The starting tree for every measurement. |
| `Dockerfile.baked-clean` | same + `npm cache clean --force`. Exists only for the image-size A/B. |
| `Dockerfile.tools` | baked + `squashfs-tools`/`squashfuse`/`zstd`/`fuse3`. |
| `Dockerfile.bare` | tools image with `node_modules` deleted — the "fresh container with no deps" starting point. |
| `bench-install.sh` | Part 1 — install cost: full cold baseline, per-dep decomposition, native-binary census, **incremental install on the baked tree**, CPU sensitivity. |
| `bench-restore.sh` | Part 2 — restore bake-off: archive creation, then end-to-end restore → `vite build` for each method. |
| `raw-install.txt` / `raw-restore.txt` | raw captured output. |

## Running

Needs Docker (Desktop — see `.claude/rules/containers.md` § Local dev). Both scripts are
self-contained; nothing in the repo is touched.

```sh
./bench-install.sh    # ~4 min
./bench-restore.sh    # ~5 min, needs --privileged for the squashfs/overlay legs
```

`--cpus=0.5` throughout, mimicking the `standard-1` (½ vCPU) instance our
`apps/nebula/wrangler.jsonc` asks for. Timing is taken **inside** the container around the operation
only, so container start (~1 s) is excluded — the older `container-dep-install-bench` timed the whole
`docker run`, which is part of why its absolute numbers differ from these.

## What this does NOT cover

- **Real R2.** Archive *fetch* is a pure bandwidth term. Rather than fake a network number, the
  archives sit on a local volume and RESULTS.md reports archive **size**, so fetch time can be
  computed for any bandwidth. The restore numbers here are a **lower bound**.
- **R2 FUSE mounts** ([docs](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)) —
  needs an R2 bucket, a scoped API token, and a deployed run (FUSE wants `/dev/fuse` +
  `CAP_SYS_ADMIN`, and per `containers.md` some container behavior is cloud-only). That was scoped as
  "Leg B" and deliberately not run; RESULTS.md explains why the Part 1 numbers make it moot.
- **arm64 only.** Apple silicon; CF runs x64. The native packages differ by platform
  (`*-linux-arm64-gnu` here vs `*-linux-x64-gnu` there) and sizes will shift somewhat.
