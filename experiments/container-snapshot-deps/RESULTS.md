# Results — container-snapshot-deps (2026-09-30)

**Snapshots do what `tasks/nebula-pre-alpha-fast-follow.md` § *Item 11* needs.** A container restored
from a snapshot is ready in about a second, carries the whole installed tree, builds with internet
off, and costs no more per build than today's baked image. A per-Galaxy delta on top of a shared
snapshot is a 1 MB layer.

Three things stand between that and Nebula, and none is about speed:

1. `@cloudflare/computer` cannot start a container under the new policy.
2. `@swc/core` fails to load under the new policy's filesystem, deployed only.
3. After a deploy, a snapshot restores its *own* image, not the new one — version skew, not an error.

The sections below give the numbers, then each finding, then an outline for the session that drafts
the task file.

## The numbers

Deployed on `standard-2` (what `apps/nebula` runs), one fresh container per row, n = 3 unless noted.
The tree is Nebula's baked scaffold set plus `echarts`, `three`, `date-fns` and `lodash-es`: 49
top-level packages, 280–310 MB. "Build" is `vite build` running rolldown, swc, tailwind's oxide and
lightningcss.

| Path | Ready | Install | Build | Whole build |
|---|---:|---:|---:|---:|
| **Today: deps baked into the image** | 1.0–1.1 s | — | 6.4–7.6 s | **~7.5–8.7 s** |
| **Restore a snapshot, host already has it** | 1.0 s | — | 4.9–5.7 s | **~6–7 s** |
| Restore a snapshot, first time on that host | 7.8–12.0 s (n = 3) | — | 5.5 s, 7.8 s (n = 2) | ~15–20 s |
| No bake, no snapshot: `npm ci` every build | 0.8–0.9 s | 17.0–18.5 s | 5.5–6.7 s | ~24–27 s |
| Managed `cloudflare/debian-trixie`, start only | 0.8–1.2 s | — | — | — |

| Snapshot operation | Deployed | Local |
|---|---:|---:|
| Create, full tree (`snapshotContainer`) | 10.6 s, 176 MB | 7.1 s, 222 MB |
| Restore → ready | 1.0 s (8–12 s first on a host) | 0.73–0.76 s |
| Build from the restored tree, internet off | 4.9–5.7 s | 2.6–2.7 s |
| Delta: restore, `npm install dayjs`, snapshot again | install 2.3 s, create 6.7 s, **1.05 MB** | not run |
| Restore the delta → ready | 1.2 s (n = 1) | not run |

Raw lines are in `results/*.jsonl`. A handful of one-off probes were run with `curl` rather than
the driver and are quoted inline below.

## Findings

**1. A restore costs what baking costs, once the host has the snapshot.** Ready in 1.0 s, against
1.0–1.1 s for the baked image. The restored build was about 1.5 s *faster* than a baked one; the
likeliest reason is that whatever swc unpacks on first load (finding 7) comes back with the
snapshot, where a baked box unpacks it every build, but that was not isolated. Either way the baked
image can go with no per-build penalty.

**2. The first restore on a host is the real cost: 8–12 s.** Nothing controls which host a
container lands on (`experiments/container-cold-start-probe` § *Container placement does NOT follow
the caller*). A new image pays the same after a deploy: the first starts of a freshly deployed
image took 6.8 s and 17 s, and two failed outright with `internal error` and
`container is not listening`. Nebula's speculative warm fires at the turn's first write, so most of
this would hide behind the model's generation.

**3. Snapshots are layered.** Restoring the 176 MB base, adding one package and snapshotting again
produced a **1.05 MB** snapshot, which restored in 1.2 s with the package present and built. So
"one shared snapshot plus a per-Galaxy delta" costs about a megabyte per Galaxy, not a copy of the
tree.

**4. A snapshot carries its image — so after a deploy it restores the OLD one.** In both venues,
after changing `plain`'s image and redeploying (fresh starts then reported `plain-v2`), restoring
the earlier snapshot worked and came back with `mark=plain`. The docs' "tied to the image" is
literally true — you cannot get the new image under an old snapshot — but it fails open. For Nebula
that means a Galaxy restoring after a deploy would build with the previous deploy's computerd,
compiler and `@lumenize` frontend. The record that stores a snapshot handle has to store the image
digest beside it, and compare it with `ctx.container.images.<name>` (digest-pinned) before restoring.
`ctx.container.inspect()` reports the running image afterwards.

**5. `start()` must name an image, and computer 0.3.1 does not.** The runtime types make `image` and
`containerSnapshot` mutually exclusive — a restore names no image. A `start()` with neither does
not throw; it never produces a container. Deployed, the readiness poll gets *"There is no container
instance that can be provided to this Durable Object, try again later"*; locally, *"Container
ingress proxy is not running"*. `@cloudflare/computer` 0.3.1's `start()` sends only
`{ enableInternet, env }`.

**Starting the container ourselves and letting computer attach does not work either.** Computer's
container backend mints a per-launch `RPC_CLIENT_SECRET` inside its own `start()` and passes it in
`env` (`#launchAs` in `dist/backends/container/index.js`), so computerd only trusts containers
computer launched. The plausible interim is a wrapper around `ctx.container.start` that adds
`image` or `containerSnapshot` to computer's own call. **Not run** — it needs the computerd image
and workspace wiring, and upstream support may land first.

**6. `snapshotDirectory` is gone.** It is in the runtime types at compatibility date 2026-08-15
(`apps/nebula`'s) and absent at 2026-09-29, and `typeof ctx.container.snapshotDirectory` is
`undefined` at runtime in both venues. The `directorySnapshots` restore parameter is still in the
types. Only whole-container snapshots can be made, which finding 3 makes fine.

**7. Under the `durable_object` policy, `/` is owned by uid 2346, and `@swc/core` 1.16.12+ refuses
to load.** swc 1.16.12 (2026-09-29, the first stable release after 1.16.2) started unpacking its native binding into `~/.cache` and
refusing to load it when any ancestor directory is *"writable by another user without trusted
sticky protection"* — `ERR_SWC_NATIVE_CACHE`. Measured:

- **`durable_object` policy, deployed:** `/` is `755` owned by uid 2346; every build fails.
- **Default policy, deployed** (what Nebula runs today; the same `baked` image by digest): `/` is
  owned by root, and the same swc 1.16.13 builds fine. **Nebula is not exposed today.**
- **Local `wrangler dev`:** `/` is root-owned, so the probe was green locally and red deployed —
  the deploy-only class `calibration.md` §9 warns about.
- **`SWC_NATIVE_BINDING_CACHE=/tmp/…` does not help**, since `/` is still an ancestor.
  **`chown 0:0 /` at the start of the build does**; the probe's build command now carries it.

The version arrived unasked: the probe app's lockfile was generated today and took the newest swc.
Nebula's container app has no lockfile at all (`tasks/backlog.md` § *Nebula*, the committed-lockfile
row), so its next cold image build takes 1.16.13 the same way.

**8. Local runs the whole snapshot contract, so local stays the default venue.** Create, restore, an
offline build and the image-tie behaviour all match deployed. A local snapshot is a Docker image
commit (`workerd-container-snap-<id>`). The divergences:

- the swc failure above (deploy-only);
- first-restore-on-host latency (deploy-only);
- local `wrangler dev` delivers `start()`'s `entrypoint` as the container's **CMD** (reproduced by
  hand with `docker run`), so an image whose own ENTRYPOINT is `sleep infinity` ran
  `sleep infinity node -e …` and exited. The deployed
  behaviour for that image shape was not tested, since the probe switched to a CMD image;
- locally, `cloudflare/debian-trixie` resolves to `node:24.20.0-trixie-slim`.

**9. A full install is 4× slower deployed than local.** `npm ci` of the ~300 MB tree: 17–18.5 s
deployed, 4.3 s local. Adding one package to a restored tree is 2.3 s. Budget from the deployed
numbers.

### Not measured

- Snapshot pricing, storage billing, size limits, and how long an old image stays restorable
  (snapshot handles have a 30-day TTL, refreshed on each restore).
- A snapshot taken while computerd has `/workspace` FUSE-mounted. The docs say separately mounted
  filesystems are excluded, which is what Nebula wants, but nothing here had a mount.
- Restore latency across colos and under concurrent restores — n is small and every install ran in
  `ATL` or `EWR`.

## Outline for the task-file session

Notes for whoever drafts the child task file, not a pass 1. Where a line states a number, the
section above is its source.

### Target state

- **The image is the toolchain only:** debian, node, fuse3, computerd, and the compiler under
  `/build`. No app dependencies, no vendored `@lumenize` source, and it changes only on a toolchain
  bump.
- **One shared snapshot per image digest** holds the scaffold's installed tree.
- **A per-Galaxy delta snapshot** holds a user-developer's extras, keyed by `(image digest,
  lockfile hash)`.
- **Restore order at build time:** the Galaxy's delta if its key matches, else the shared
  snapshot if the lockfile is the scaffold's, else a fresh start plus `npm ci`, then snapshot.
- **Install is its own step**, the only one with `enableInternet: true`. Builds stay offline, as
  they are today.
- **The `@lumenize` frontend packages** reach the tree through `npm` as tarball URLs our Worker
  serves, content-hashed, so they need no npmjs.org release. `interceptOutboundHttp` could route
  that host to a binding so it needs no public egress either.

### What gets deleted

- The Dockerfile's app `npm install` layer and the whole `COPY … /node_modules/@lumenize/*` block.
- The curated-set maintenance, and the "deps are fully baked for the demo" deferral in
  `apps/nebula/container/app/package.json`.
- Possibly `rollout_step_percentage` / `rollout_active_grace_period`: each DO now starts the image
  of the Worker version running it, which is what those pins were approximating. Re-derive.
- `max_instances`, which the `durable_object` policy does not support.

### Blockers and prerequisites

1. **`@cloudflare/computer` passes `image` and `containerSnapshot` through `start()`**, or we wrap
   `ctx.container.start` (finding 5). Ask upstream first.
2. **wrangler 4.135 or later**, which arrives with the `@cloudflare/vitest-plugin` move
   (`tasks/nebula-pre-alpha.md` § *The test toolchain and the compatibility date*).
3. **A new container application** — the policy cannot change in place. Ride the wipe gate.
4. **`chown 0:0 /` before any build** under the new policy, until Cloudflare changes `/`'s owner or
   swc relaxes its check (finding 7). Worth reporting to both.
5. **A committed lockfile for the container app** — it becomes half the delta's cache key, and its
   absence is how swc 1.16.13 slipped in.

### Open questions

- **Who makes the shared snapshot, and where does its handle live?** Written once per deploy, read
  on every build: ADR-018 keeps that read off a singleton. After a deploy, N Galaxies could each
  miss and each run a full install at once — decide whether that herd matters.
- **Does the first-on-a-host restore (8–12 s) hide behind the model's generation?** Measure it in a
  real turn, deployed.
- **Does computerd's mount come back cleanly on a restored container?** The entrypoint reruns on
  restore, so it should.
- **The install step's egress:** registry-only through `interceptOutboundHttps`, or open? This is
  where `docs/vision/_ai-security.md`'s dependency half — a model-chosen package name — gets its
  control point.
- **What bounds instance count and cost** without `max_instances`?
- **Snapshot storage pricing** per Galaxy, once Cloudflare publishes it.

## Housekeeping

The Workers `experiment-container-snapshot-deps` and `experiment-container-snapshot-deps-default`
wait for Larry's `experiment-*` sweep. The `-default` container application is already deleted; the
main one showed 0 live instances at the end.
