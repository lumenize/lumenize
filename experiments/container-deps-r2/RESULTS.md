# Results — container-deps-r2 (2026-11-18)

**A Galaxy's `node_modules` can come from a snapshot or from an R2 archive; it cannot come from an R2 FUSE mount.** A build on an s3fs mount of the tree did not finish in 15 minutes, against about 5 s on local disk. The other two both work, and both land a build in about 6–11 s when warm. Their cold starts mostly fall inside the time a real turn's generation already takes.

So the choice between snapshots and an R2 archive rests on what they cost to run, not on latency:

- **A snapshot is tied to the image**, so every deploy that changes the image throws away every Galaxy's snapshot and makes a fresh one.
- **An archive keyed by its lockfile** survives an image change, and Galaxies with the same lockfile share one object.

The sections below give the numbers, then each finding. Every number is deployed, on `standard-2`, with internet off for the build.

## The numbers

The tree is `experiments/container-snapshot-deps`'s app: Nebula's scaffold set plus `echarts`, `three`, `date-fns` and `lodash-es`. That is 49 top-level packages, 16,698 entries, 309 MB.

Rounds ran every 5–15 minutes for an hour, then once more after a 30-minute gap (`results/rounds-*.jsonl`, n = 8–9 per arm). "Same" restores from one reused Durable Object name, the way one Galaxy's repeat builds would. "Fresh" restores from a new name each time, the way another Galaxy would. Whole is start() to the build's end.

| Arm | Ready, median (max) | Fetch + unpack | Build, median | Whole, median (max) | Cold starts |
|---|---:|---:|---:|---:|---:|
| Snapshot of the whole tree, same Galaxy | 0.5 s (0.6) | — | 4.9 s | 6.5 s (6.9) | 0 of 9 |
| Per-Galaxy delta snapshot, same Galaxy | 0.6 s (0.7) | — | 5.0 s | 6.6 s (7.1) | 0 of 9 |
| Snapshot of the whole tree, fresh object | 0.7 s (7.6) | — | 4.8 s | 8.0 s (15.9) | 3 of 8 |
| Per-Galaxy delta snapshot, fresh object | 0.7 s (11.5) | — | 5.2 s | 7.2 s (20.6) | 2 of 8 |
| Plain image, whole tree from an R2 archive | 0.5 s (7.9) | 4.8 s (8.8) | 4.3 s | 10.9 s (15.5) | 2 of 15 |
| Scaffold baked in, extras from an R2 archive | 5.5 s (12.3) | 2.0 s (3.3) | 5.7 s | 14.0 s (26.2) | 5 of 8 |
| Everything baked into the image (today) | 0.6 s (7.0) | — | 6.3 s | 8.2 s (14.3) | 3 of 8 |
| s3fs mount of the tree in R2 | 4.3 s | — | **killed at 15 min** | — | — |

A cold start is a ready time over 2 s; every one fell between 4.2 s and 12.3 s. The whole-tree archive's ready and fetch figures count all 15 of its runs, the diagnostics' included; its build and whole figures count only the 3 rounds after the fix in finding 6, since the rounds before it waited on a DNS lookup. The 90-minute round lost both fresh-object restores to this laptop's connection resetting, not to anything on Cloudflare's side.

| Artifact | Size | Make it | Notes |
|---|---:|---:|---|
| Snapshot, whole tree | 176.7 MB | 7.2 s | |
| Snapshot, tree minus extras (the shared base) | 142.5 MB | 6.8 s | taken from the same container as the whole-tree one, after deleting the extras |
| Delta snapshot: base restored, extras added | 34.4 MB | 6.8 s | restores in 0.5–0.8 s warm |
| Archive, whole tree (`tar \| zstd -3`) | 64.7 MB | 2.0 s to pack, 3.5 s to upload | one part, under the 100 MiB outbound body limit |
| Archive, extras only | 19.3 MB | 0.7 s to pack, 2.0 s to upload | |

## Findings

**1. An R2 FUSE mount cannot carry a build.** s3fs mounted the tree in 0.7 s and listed it in 0.7 s, then the build ran into its 15-minute cap. Rolldown's own timing line shows vite had only bundled its config. Node's module resolution checks many paths that do not exist, and s3fs turns every miss into several HEAD requests, each a round trip through the Worker to R2. The shim saw 1,000–2,000 requests a minute for the whole run. Two measurements on a fresh mount show the size of it:

- **Stat-ing every entry**, `find node_modules`, took 407 s for 16,694 entries, about 24 ms each.
- **Reading every byte**, `tar -cf - node_modules`, got through 87 MB of the 309 MB before its 10-minute cap.

The same tree comes out of an archive in under 5 s.

This agrees with what `experiments/container-dep-restore-bench` predicted without running it, and it is why Alex's case differs from ours. A CI cache reads a small part of a large store, which a lazy mount wins at. A build reads thousands of small files, which a mount loses at.

**2. A Galaxy's own snapshot stays warm.** Restored from the same Durable Object name, both the whole-tree snapshot and the delta were ready in 0.5–0.7 s every time, 18 restores in all, at gaps of 5, 10, 15 and finally 30 minutes. The third-party report of a host cache purged every 10–20 minutes did not show up for one Galaxy's repeat builds. Fresh objects restoring the same snapshots, which model a different Galaxy, were cold 5 times in 16.

**3. Cold starts hit images as often as snapshots, and the less an artifact is used, the colder it is.** A start on a host that has not seen the artifact took 4.2–12.3 s, whether the artifact was a snapshot or an image:

- the `base` image, started once per round from a fresh object, was cold 5 times in 8;
- the `baked` image, 3 in 8;
- the `plain` image, which more ops used, 2 in 15;
- snapshots from a fresh object, 5 in 16.

So the September figure of 8–12 s for a first restore on a host roughly holds, and it is not a snapshot penalty. One image that every Galaxy starts is the warmest artifact there can be. Nothing here reached the reported 30–40 s, at our sizes of 34–177 MB against the report's 0.5–1 GB.

**4. An R2 archive costs about the same on every host.** The whole tree fetched and unpacked in 4.4–5.1 s in 11 of 15 runs and 7.1–8.8 s in the other 4; the extras took 1.9–2.1 s in 8 of 9 and 3.3 s once. The spread is R2's and the network's, not the host's: nothing about an archive is cached on a host, so there is no cold case to fall into. The container reached R2 only through `interceptOutboundHttp` to a WorkerEntrypoint holding the bucket binding, so the build ran with internet off and no credentials entered the container. Uploading went at about 18 MB/s.

**5. A real turn's generation covers 7.5–38 s.** That is the time from the turn's first write, which starts the box, to the build call. `tasks/nebula-pre-alpha-fast-follow.md` records five turns from 7.5 s to 32.3 s, and `test-nebula`'s logs hold one more at 38 s (`scripts/warm-to-build.mjs`). A cold start of 4.2–12.3 s fits inside every turn longer than 12.3 s; at the shortest, 7.5 s, up to 4.8 s of it would show. An archive's 2–5 s fits inside all of them, if the fetch runs at the warm rather than at the build. That covers a run's first build only: `#buildOnce` destroys the container when each build ends, and the warm fires once per run, so a rebuild after a failed build starts cold and waits the whole fetch. Item 11 re-arms the warm after each build for that reason, and the model's time to write its fix is unmeasured. Production has never had a build box, so it has no turns to read.

**6. Offline, any DNS lookup hangs for 56 s before it fails.** `getent hosts registry.npmjs.org` took 56,048 ms in a container started with `enableInternet: false`. It first showed as a whole-tree build taking 28.7 s against 3 s for a second build in the same container. The cause was the first `npx`: on an image with no `~/.npm/_update-notifier-last-checked`, npm's update notifier looked up the registry and waited. The baked images carry that file from their Docker build, and snapshots carry it from the install that made them, so only the plain image paid. Nebula's job spawns `vite` directly, so it does not hit this one. But a package a user-developer adds whose build looks up a host would stall the build box for a minute per lookup, with nothing in the output to say why.

**7. Installing inside a deployed container quietly adds `@swc/wasm`.** The tree `npm ci` produced in the container carried an 18 MB `@swc/wasm`, and its swc binding unpacked in place (30 MB). The image's tree, installed under `docker build`, had neither. swc's postinstall failed to load the native binding, because `/` is owned by uid 2346 under the `durable_object` policy (the earlier experiment's finding 7), and fell back to installing the WASM build. The native binding still loaded at build time, after `chown 0:0 /`, so it cost only 18 MB. A design that installs inside the container should run the install after that `chown` too.

**8. Writing the tree through s3fs is too slow to be a write path either.** s3fs's own `cp` into the mount, 16 at a time, logged about 300 PUTs a minute, which puts 16,698 entries past an hour. Workers Logs can drop lines, so that rate is a floor. Putting the same 16,698 entries straight to R2 with s3fs's metadata, 64 at a time, took 89 s.

**9. What leaves a container through an intercept counts as egress; what comes in does not.** The GraphQL dataset `containersUsageAdaptiveGroups` reports `txBytes`, which Cloudflare's docs name as the figure for billing estimates (`scripts/container-usage.mjs`). In 5-minute buckets for this experiment's application:

- **19:20, 84.3 MB:** the two archive uploads, 64.7 + 19.3 MB. The same bucket held both snapshots and the delta's, so making a snapshot adds nothing.
- **20:05, 279.1 MB:** the populate, which wrote 278 MB.
- **19:25–19:45, 0.1–0.6 MB a bucket:** rounds that each pulled 84 MB of archives in and restored two snapshots.

Container egress is $0.025/GB in North America and Europe past 1 TB a month. The intercepted calls were not counted as Worker requests: the Worker logged 58 and 153 requests in those two hours, against tens of thousands of intercepted ones. R2 counted 2 `GetObject` per archive fetch. In 10 of the FUSE build's 15 minutes it counted 10,816 `HeadObject`, 1,681 `GetObject` and 237 `ListObjects`, the last at the Class A rate.

## What this does to Item 11

`tasks/nebula-pre-alpha-fast-follow.md` § *Item 11* planned one shared snapshot and a per-Galaxy delta. The measurements support that design on latency. What they do not change is that a snapshot is tied to its image. On this comparison Larry moved Item 11 to the whole-tree archive on 2026-11-18:

| | Per-Galaxy snapshot | R2 archive keyed by lockfile |
|---|---|---|
| Warm build, whole op | 6.5 s | 8.9 s (extras only) to 10.9 s (whole tree) |
| Cold start | 4–12 s when the snapshot is new to the host; generation hides most of it | only the image's own, which today's build box already pays |
| After a deploy that changes the image | every snapshot restores the old image; each Galaxy rebuilds its own | archives stay valid unless the Node major or platform changes |
| State to keep | handle + image digest per Galaxy, a shared handle, 30-day expiry | one object per distinct lockfile, which Galaxies share |
| Price | free in beta; GA unannounced; no container egress to make or restore one | R2: $0.015/GB-month, $0.36 per million reads; each upload is container egress, past 1 TB a month |

## Not measured

- Restore latency at Alex's sizes, 0.5–1 GB.
- Same-Galaxy warmth across gaps longer than 30 minutes, and across a day. Whether one object's container lands on the same host each time, or on any host that has the snapshot, is not visible from inside the container.
- Placement across colos: every container reported the same CPU model, and the intercepted requests carried no colo.
- tigrisfs, which Cloudflare's own FUSE example uses and which caches more than s3fs. A tenfold gain would still leave a build at minutes.

## Housekeeping

The Worker `experiment-container-deps-r2` and the R2 bucket of the same name wait for Larry's `experiment-*` sweep. The bucket holds the two archives and the s3fs tree, about 360 MB.
