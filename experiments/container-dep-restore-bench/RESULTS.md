# Results — container dep-restore bench (2026-07-20)

Docker Desktop, `node:22-slim`, **arm64** (Apple silicon), `--cpus=0.5` (≈ the `standard-1` ½ vCPU our
`apps/nebula/wrangler.jsonc` asks for). Timing taken **inside** the container around the operation only,
so ~1 s of container start is excluded — this is why absolute numbers differ from the older
`container-dep-install-bench`, which timed the whole `docker run`.

> ⚠️ **SUPERSEDED FOR ABSOLUTE NUMBERS (2026-07-20, same day).** Everything below is **local Docker on
> Apple silicon** and proved **3–5× optimistic** against real Cloudflare. A deployed probe
> ([container-cold-start-probe](../container-cold-start-probe/RESULTS.md)) measured the same sequence at
> **8–10 s baked / 11–33 s with a user dep**, where this file predicts 2.1 s / 7.9 s. The *relative*
> findings here still hold (restore mechanisms all tie baked; tar.zst beats squashfs; a read-only
> `node_modules` cannot build) — but **do not budget from the absolutes on this page**, and note the
> superlinear CPU-scaling result in particular did **not** reproduce on CF.

**Bottom line: the whole snapshot/restore question is competing for a ~1 s prize against a 6 s build.
Adding a user dep on top of the baked tree costs 1–4 s, and no restore mechanism beats baked-into-the-image
by more than ~1 s. The real blocker for user-supplied deps is container egress, not speed — and no
snapshot mechanism avoids it, because you have to install the deps somewhere before you can snapshot them.**

---

## Part 1 — install cost

### The headline: incremental install on the baked tree

The relevant baseline is *not* a clean install of everything (that's already baked). It's "user adds one
library." Measured on top of the baked tree, at ½ vCPU:

| user dep added | wall | Δ size | Δ pkgs |
|---|---|---|---|
| `date-fns` | 4.0 s | +40 MB | +4 |
| `@tiptap/vue-3` + `starter-kit` | 3.3 s | +25 MB | +52 |
| `echarts` | 3.2 s | +80 MB | +13 |
| `ag-grid-community` | 1.9 s | +37 MB | +12 |
| `@tanstack/vue-table` | 1.6 s | +17 MB | +5 |
| `chart.js` | 1.0 s | +19 MB | +7 |
| **NO-OP re-install (floor)** | **0.7 s** | +13 MB | +3 |

⚠️ **Subtract the 0.7 s floor.** A no-op `npm install` on the baked tree is not free — it pulls
`lightningcss-linux-arm64-musl`, a **musl** platform variant onto a **glibc** image (~13 MB), because the
baked lockfile doesn't pin optional platform deps to the one platform in play. So every row above carries
~0.7 s / ~13 MB of that, and the true incremental cost of a user dep is roughly **0.3–3.3 s**.

Package **count** matters more than bytes: tiptap adds 52 packages for 25 MB and costs about what echarts
does at 80 MB / 13 packages.

### What dominates the clean install (the oxide hypothesis)

Full curated set, cold: **12.5 s / 13.4 s** (two runs) → 111 MB, 64 packages. Each dep alone, cold:

| package alone | wall | size | pkgs |
|---|---|---|---|
| `@tailwindcss/vite` | 7.4 s | 47 MB | 40 |
| `@vitejs/plugin-vue` | 7.4 s | 48 MB | 45 |
| `vite` | 6.3 s | 30 MB | 18 |
| `lucide-vue-next` | 5.1 s | 56 MB | 34 |
| `vue` | 2.4 s | 19 MB | 33 |
| `typescript` | 2.0 s | 30 MB | 3 |
| **`tailwindcss`** | **0.8 s** | **1 MB** | **1** |
| `daisyui` | 0.7 s | 4 MB | 1 |

**Verdict on the hypothesis: half right.** Native oxide *is* there —
`@tailwindcss/oxide-linux-arm64-gnu`, alongside `lightningcss-linux-arm64-gnu` (9 MB) and
`@rollup/rollup-linux-arm64-gnu`. (The old `container-dep-install-bench` RESULTS.md says
*"No native binaries"* — **that is wrong** and should not be relied on.)

But `tailwindcss` the package is **1 MB / 1 package / 0.8 s** — genuinely thin. The weight rides in
`@tailwindcss/vite`, which drags in oxide + lightningcss. And the single largest thing in the tree isn't
Tailwind at all:

| largest packages | MB |
|---|---|
| `lucide-vue-next` | 33 |
| `typescript` | 23 |
| `@esbuild` | 10 |
| `lightningcss-linux-arm64-gnu` | 9 |
| `@vue` | 7 |

**`lucide-vue-next` (icons) + `typescript` = 56 of 111 MB — half the tree.** Two leads worth a look,
neither chased here: whether `typescript` is load-bearing for the container build at all (`vite build`
strips types with esbuild and does **not** typecheck — though Vue's `defineProps<T>()` macro resolution
*can* need it, so this needs checking against real generated apps, not this fixture), and whether lucide
can be slimmed.

### CPU is not the lever (for the clean install)

`--cpus=2` made the full install **slower** (14.7 s vs 12.5 s) — it's network/metadata-bound at this size,
and run-to-run network variance exceeds the CPU effect. The *incremental* install is genuinely CPU-bound
though: echarts went 3.2 s → **1.1 s** at 2 vCPU. Treat all absolute numbers as ±1 s.

### Side finding: ~31% of our image is dead npm cache

`RUN npm install` leaves a **179 MB** npm cache behind, and `apps/nebula/container/Dockerfile` never cleans
it. Clean A/B on the same tree:

| image | size (docker accounting) |
|---|---|
| `node:22-slim` base | 76 MB |
| baked, cache left in (**our current shape**) | **142 MB** |
| baked + `npm cache clean --force` | **98 MB** |

`docker history` confirms the install layer is **306 MB uncompressed** (111 MB `node_modules` + 179 MB
cache). Dropping the cache cuts the image **31%**, and CF cold start is image-dependent
(`containers.md` § Cost/sizing).

Is the cache load-bearing? It makes a *runtime* `npm install` warm (5.0 s vs 12.5 s cold — see the
`npm-cold` row in Part 2, which ran with the cache present). But it only helps re-installing packages
already in it, which in the baked design never happens; a **user's new** dep isn't in the cache anyway.
So it is dead weight — **clean it.**

---

## Part 2 — restore bake-off

Tree under test: **111 MB / 4598 files / 308 dirs.**

### Archive creation — the "backup" half, and it is not cheap

| artifact | create | size |
|---|---|---|
| `node_modules.tar.zst` | **0.6 s** | 20 MB |
| `node_modules.tar.gz` | 3.8 s | 23 MB |
| `node_modules.sqsh` (squashfs, zstd) | **50.7 s** | 21 MB |

Squashfs is **~85× slower to create than tar.zst** for the same ~20 MB, at ½ vCPU. That's the half CF's
API does on every `createBackup()` — full archive, no diffing (as the docs describe, and as suspected).

### End-to-end: fresh container → node_modules → `vite build`

| method | restore | build | **TOTAL** | 2nd build |
|---|---|---|---|---|
| **control** (baked into image) | 0.0 s | 6.1 s | **6.1 s** | 5.9 s |
| **sqsh-ovl** (squashfs + tmpfs COW overlay) | 0.0 s | 6.5 s | **6.5 s** | 6.0 s |
| **tar.zst** | 0.4 s | 6.6 s | **7.1 s** | 5.7 s |
| **tar.gz** | 1.0 s | 6.2 s | **7.3 s** | — |
| **npm-cold** (warm npm cache present) | 5.0 s | 6.4 s | **11.4 s** | — |
| `sqsh-ro` (read-only mount) | — | — | **FAILS** | — |
| `squashfuse` + overlay | — | — | **FAILS** | — |

Archive *fetch* is excluded (pure bandwidth — sizes are above, so compute it for any link). These are a
**lower bound** on a real R2-backed restore.

**The build dominates.** At ½ vCPU the build is ~6 s and every viable restore method lands within ~1 s of
the baked control. Squashfs-with-overlay is essentially free to mount (0.0 s) and costs ~0.4 s in build —
it is a *good* mechanism; there is just almost nothing left for it to win.

### Two failure modes worth keeping

**1. A read-only `node_modules` cannot build.** `vite build` must **write** into `node_modules` —
`mkdir '/app/node_modules/.vite-temp'`, used to load a TypeScript `vite.config.ts` — so a plain read-only
mount dies immediately. This is presumably *why* CF's `restoreBackup()` uses a COW overlay, and it kills
the simplest R2-FUSE shape ("just mount `node_modules` from R2 read-only").

**2. Kernel overlayfs stacked on a FUSE lower breaks native-binary exec.** Isolated cleanly:

| stack | exec `esbuild` off it |
|---|---|
| squashFUSE mount, direct | ✅ `0.25.12` |
| kernel squashfs → overlay | ✅ `0.25.12` |
| **squashFUSE → overlay** | ❌ `Invalid argument` (EINVAL) |

Our tree has ≥3 native binaries (esbuild, oxide, lightningcss, rollup) that a vite build *needs* to exec.
⚠️ **Caveat before repeating this as fact about CF:** their docs say `restoreBackup()` uses "FUSE
overlayfs," which may mean `fuse-overlayfs` (userspace) rather than kernel overlayfs over a FUSE lower —
a different stack that may not have this problem. What's established here is that **the shape their docs
describe has an exec hazard for native binaries**, which is worth verifying against their implementation
before trusting either backup/restore *or* a writable R2-FUSE layer for a `node_modules` tree.

(Also: `squashfuse` daemonizes, so a following `mount` races it — needs a `mountpoint -q` wait. And
overlayfs refuses an overlayfs `upperdir`, so on Docker the upper/work dirs must go on a tmpfs. Both are
harness notes, not findings.)

---

## Conclusions

1. **Adopting backup/restore now remains wrong**, and the margin is bigger than the desk research
   suggested. Baked = 0.0 s restore; the best alternative mechanism ties it; `createBackup()` costs 50.7 s
   per snapshot. Confirms the [backlog.md](../../tasks/backlog.md) verdict.
2. **The prize is ~1–4 s, against a ~6 s build.** Even a perfect restore mechanism saves less time than
   the build it precedes. Any complexity here should be justified by something other than latency.
3. **User-supplied deps is an egress/security question, not a speed question.** Installing one is already
   1–4 s. What's missing is the decision to let a tenant container reach the npm registry (the Dockerfile
   calls runtime egress "deferred"; `tasks/nebula-outside-world.md` designs an `EgressBroker` for the
   app-server facet, not this). **A snapshot mechanism does not route around this** — the deps must be
   installed *somewhere* before there is anything to snapshot. Egress is upstream of, and unavoidable by,
   the whole snapshot question. That reordering is the most decision-relevant thing here.
4. **If a restore mechanism is ever wanted, `tar.zst` is the one to reach for** — 0.6 s to create vs 50.7 s
   for squashfs, smaller output, 0.4 s to restore, no FUSE, no overlay, no privileged mount, no exec
   hazard. The lazy-mount sophistication buys ~0.4 s of build time and costs every constraint above.
5. **Two immediately actionable, unrelated-to-snapshots wins:** drop the npm cache from the image
   (142 → 98 MB, −31%, faster CF cold start), and pin the platform for optional deps so a runtime
   `npm install` stops pulling a musl lightningcss onto a glibc image (~13 MB + 0.7 s).

### Not run

**R2 FUSE mounts** ("Leg B") — needs an R2 bucket, a scoped API token, and a deployed run. Deliberately
skipped once Part 1 landed: it would be measuring a way to save ~1 s, while inheriting the read-only
failure (finding 1), the exec hazard (finding 2), a documented perf profile CF explicitly disclaims for
high-IOPS work, and R2 credentials inside the tenant container. Worth revisiting only if user-supplied
deps arrive *and* the egress question is answered in a way that makes a pre-built per-tenant tree the
natural artifact.
