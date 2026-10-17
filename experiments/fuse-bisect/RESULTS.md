# fuse-bisect — why the deployed FUSE mount served zero entries (2026-08-29)

**Question.** The first post-collapse deploy of `test-nebula` found the kernel FUSE mount up
(`/dev/fuse /workspace fuse rw,…` in `/proc/mounts`) yet serving nothing, while the exec's sync
bracket reported `pushed: 47` — on the matched 0.1.1 AND 0.2.1 `@cloudflare/computer`/computerd
pairs. The 2026-08-03 `computer-vfs-build` experiment had run real vite builds through the same
mount. Did the platform move, or is Galaxy's wiring wrong?

**Answer: Galaxy's wiring. The mount serves the VFS's `/workspace` SUBTREE — the same absolute
path on both sides — and Galaxy seeded the VFS root.** The platform never changed.

## The bisect, in order

1. **Redeployed the Aug-03 experiment verbatim** (`experiment-computer-vfs-build`, computerd
   0.1.1). `mode=seed` ran a real `vite build` through the deployed mount (`✓ built in 4.79s`,
   real dist, tailwind CSS); after `destroy()`, a genuinely new container built again from the
   surviving VFS with no re-seed (`✓ built in 1.55s`). Platform exonerated, same day.
2. **Rebuilt this probe on the proven image recipe** (first attempt used a minimal image —
   no node/git/curl — and computerd's session died at connect with a bare 1006; too far from
   the proven shape to discriminate anything).
3. **Walked the wiring deltas by query param** — mixin-vs-direct construction, git client,
   warm pre-start, destroy+reconstruct teardown, seed-before-vs-after first exec. **Every arm
   failed identically**, including the experiment's exact wiring and order: mount up,
   `pushed: 4`, `/workspace` empty. So none of those was the delta.
4. **The tell:** after the boot exec's `pulled: 1`, the host-side `readdir('/')` showed a
   `workspace` DIRECTORY in the VFS root — computerd mirroring the (empty) mount at its own
   absolute path inside the VFS. And the original experiment's `FUSE_APP` constant is
   literally `"/workspace/app"` — its host-side writes carried the prefix all along, reading
   like container paths.
5. **Falsifying arm** (`where=mount`): the same seed under `/workspace/…` serves immediately —
   `ls` shows the tree, `cat` returns the bytes, exit 0.
6. **Full Galaxy shape on the subtree contract** (`shape=direct&git=1&where=mount&warm=1&cycles=2`):
   green on both cycles — direct `new Workspace` + `WorkspaceContainerAPI` thunks, git rooted at
   `/workspace` (`.git` visible in the mount like a normal checkout), warm `start({})`,
   destroy+reconstruct between cycles.

## Why the counts read healthy while nothing served

Push is not subtree-scoped — the exec bracket pushes every VFS entry and computerd stores them
all; **serving** is what is scoped to the `/workspace` subtree (`MOUNT_POINT`). So a root-level
seed produces `pushed: N, pulled: 1` and an empty mount: every count reads healthy, and the only
symptom is the absence the job trips over (readdir 0, ontology ENOENT, vite
`Cannot resolve entry module`).

## What changed where

- `apps/nebula/src/build-report.ts` — `WS_ROOT` + `wsPath()` (the one home for the prefix).
- `apps/nebula/src/galaxy.ts` — every host-side `ws.fs` path goes through `wsPath()`; every
  `ws.git` op passes `dir: WS_ROOT`; the scaffold repo roots at `/workspace`.
- `.claude/rules/containers.md` § *There is NO source-push step* — the subtree contract, and the
  quiet failure shape.
- `tasks/backlog.md` § *Nebula* — the 🚨 row, resolved.

## Addendum — LOCAL works too (same day)

The same probe under local `wrangler dev` (no `/dev/fuse`; `docker inspect` shows Devices=null)
answered the follow-up question: computerd's fallback **materializes the synced `/workspace`
subtree onto the container's real disk** — `where=mount` serves (real ext4 entries, correct
bytes), and the Galaxy-shaped `shape=direct&cycles=2` arm survives destroy → fresh container →
re-serve. The prior "local shim serves empty — structural" finding (2026-08-28) was this same
root-seeding bug observed locally, and is retracted. Consequences landed the same day: the full
`build-box` contract passes under local `wrangler dev` + Docker, and `ui-smoke`'s codegen test is
un-skipped and green locally.

**Teardown:** delete `experiment-fuse-bisect` from the DASHBOARD (a project-delete also removes
the DO namespaces; `wrangler delete` orphans them). `experiment-computer-vfs-build` was
redeployed as the control — same teardown note applies when it is retired.
