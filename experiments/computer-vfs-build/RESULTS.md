# Results — computer-vfs-build (2026-08-03)

**Headline: the FUSE mount carries our real `vite build` at a median cost of 1.05× — effectively
free.** 15 within-container pairs on real Cloudflare hardware, real kernel FUSE confirmed on
every run. The planned 2×2 follow-up (splitting source-side vs output-side) is **not needed**;
there is nothing to isolate.

| Question | Answer |
|---|---|
| Does the FUSE mount carry our real `vite build`? | ✅ **Yes — 1.05× median** (§1) |
| Cost of `computerd` + FUSE at container boot | ⚠️ **+~1.5–2 s** over the old baseline (§2) |
| What does getting `dist` back to the DO cost? | ✅ **0 ms — it is already there** (§3) |
| Worker startup cost of importing `@cloudflare/computer` | ✅ **20–22 ms / 346 KiB** (§4) |
| Does host-side `file://` git work? | ❌ **No — unimplemented** (§5) |
| Does container state outside the mount survive between execs? | ✅ **Yes** (§6) |
| Do the optional peers (`zod`, `ai`) land on us? | ⚠️ Resolvable, not bundled (§7) |

---

## 1. The headline — 1.05× median, distributions overlap

Both arms run back-to-back **inside one container**: arm A builds in `/workspace` (the computerd
FUSE mirror of DO SQLite), arm B builds in `/var/tmp` (the container's own ext4), identical
source bytes, identical baked `/node_modules`, one boot, one colo.

| | n | min | median | max |
|---|---:|---:|---:|---:|
| **ratio (fuse / disk)** | 15 | 0.56× | **1.05×** | 1.30× |

```
fuse builds (ms): 3870 3906 3927 3971 4053 4190 4383 4532 4579 4610 4788 4819 4916 4942 5056
disk builds (ms): 3522 3627 3689 3731 3791 3866 3983 4128 4202 4283 4441 4703 4706 5130 8624
```

The distributions overlap almost completely; five pairs came out **below 1.0** (FUSE faster).
The 0.56× outlier is an 8624 ms *disk* build, not a fast FUSE one — noise in arm B.

**Why this is unsurprising in hindsight, and consistent with the vendor's own bench:**
`docs/19_performance.md` reports computerd *beating* ext4 on metadata-heavy work (`stat`, `rm`,
`find`, `git init`, `npm init`) and losing 17–40× only on large sequential I/O. A vite build of
a small app is almost entirely the former — thousands of small module reads plus a **587-byte**
`index.html` and 5 dist files out. The earlier concern was pointed at the right measurement but
guessed the wrong side of it.

⚠️ **This result is about OUR build shape, and does not generalize.** It says nothing about a
build that moves large files (a big asset pipeline, a source-map-heavy bundle, a `npm install`
into the mount — the vendor measured that last one at ~2× ext4). If the scaffold's build profile
changes materially, re-measure; the harness is the point, not the number.

## 2. ⚠️ Cold start + FUSE mount is ~3.2 s — up ~1.5–2 s

`cold_start_and_mount` (container acquisition + computerd boot + FUSE mount + capnweb connect),
across 6 fresh instances: **2315, 2683, 2943, 3518, 3581, 3657 ms.**

[container-cold-start-probe](../container-cold-start-probe/RESULTS.md) measured plain container
cold start at **0.3–1.6 s**. So `computerd` + the FUSE mount adds roughly **1.5–2 s** to boot.

This is the one real cost the spike found. In the collapse's design it lands where the task
already says cold start hides — behind LLM latency at codegen-start — so it is bounded and
tolerable, **but it is no longer "~1–2 s"**; budget ~3 s and update the prose that says otherwise.

## 3. `dist` arrives in the DO for free — this is the finding that changes the design

`A*_dist_readable_from_do` measured **0 ms on every single run**, with the exec result reporting
`pulled=5` (the 5 dist files) on the build itself.

The build's own post-exec sync bracket carries `dist` back into the DO's SQLite. By the time the
`exec` promise resolves, `ws.fs.readFile('/workspace/app/dist/index.html')` is a local read.
Writing the 9-file scaffold *in* is likewise **0 ms** for 7741 B.

⇒ **Both directions of the transport the collapse planned to build already happen, at no
measurable cost.** That is the concrete form of "the FUSE mount dissolves the transport problem
rather than solving it."

## 4. Worker startup — 20–22 ms, not a concern

Reported server-side by `wrangler deploy` across three deploys: `346 KiB / gzip 73.7 KiB`,
`Worker Startup Time: 20–22 ms`, for a minimal Worker whose only dep is `@cloudflare/computer`
(workspace + container backend + `just-bash` + `acorn` + capnweb in the graph). For scale,
[do-cold-start-bundle-ab](../do-cold-start-bundle-ab/RESULTS.md) measured
`ts-runtime-parser-validator` at 9.2 MB / ~295 ms. Different class entirely.

⚠️ Lower bound on the delta to `apps/nebula`, **not** the delta itself — that needs measuring there.

ⓘ Used wrangler **4.118.0** (this workspace declares `wrangler` with no pool-workers, so the
caret floated). Load-bearing, not accidental: the `Worker Startup Time` line needs ≥ 4.116. It
stayed contained — no root-hoisted `wrangler`, the repo's 42 copies of 4.111.0 untouched.

## 5. Host-side `file://` git does NOT work — docs and scheme gate are both wrong

Run against a **filesystem-only** Workspace (no `backends`), so no container was involved:

```
OK   git init /a · git add · git commit -> 93bf420…
FAIL git clone file:///a   UnknownTransportError: unrecognized transport protocol: "file"
FAIL git pull  file:///a   same
FAIL CONTROL ssh://…       identical error class
```

**The `ssh://` control is what makes it conclusive** — `file://` fails exactly like a scheme
nobody claims to support, so it is unimplemented rather than misconfigured. Matches the source:
`git/cli.ts`'s `isSupportedTransport` **permits** `file://` and `docs/13_git_interface.md`
advertises it, but `git/network.ts` hands `http:` to isomorphic-git for every network op and
**zero** tests mention `file://`.

⇒ **Vendor bug worth filing.** For us: local repo-to-repo git must be container-side with real
git (`git clone /workspace/app /workspace/build`), never host-side.

### 5b. Two API rough edges from the same probe

- **`@cloudflare/computer/git` requires `@platformatic/vfs`,** an optional peer **npm does not
  install** — every git call throws until it is added explicitly. Note the asymmetry with §7:
  npm auto-installed the peers we don't want and skipped the one we do.
- `git.add` takes **`paths`**, not `filepaths`; `GitInitOptions` has no `initialBranch`. (Both
  were our probe's errors first — recorded so the next reader doesn't re-derive them.)

## 6. Container state outside the mount DOES persist between execs

Probed directly because the first run suggested otherwise:

```
diag_shell_chaining              -> "first\nsecond"   (&& chains fine)
diag_write_outside_mount         -> "persisted"
diag_read_outside_mount_next_exec-> "persisted"       (separate exec)
```

So `/var/tmp` survives across `runtime.exec` calls; only *syncing* is scoped to the mount.

ⓘ **The original arm-B failure was our bug**: `cwd` is validated at **spawn**, before the command
runs, so `rm -rf X && cp -r … X` with `cwd: X` can never start. One residual anomaly is
**unexplained and was not reproduced** after the fix: a `B1_disk_prep` exec reported `exit=0` yet
its target directory did not exist for the next exec. Recorded rather than explained — do not
build on an invented mechanism for it.

## 7. `zod` and `ai` are installed but not bundled

`peerDependenciesMeta.optional: true` means *"fine if absent"*, **not** *"don't install"* — npm
pulls optional peers, so `@cloudflare/computer` brings `ai@7.0.48` and `zod@4.4.3` into
`node_modules`.

- **Bundle impact: none.** The 346 KiB upload never imports them; esbuild tree-shakes by import
  graph. They load only via `@cloudflare/computer/tools`.
- **Footgun impact: real.** `import { z } from 'zod'` *resolves* once present, so a future agent
  gets a working import and a silent **ADR-001** violation. ⇒ If `apps/nebula` takes this dep,
  that needs a guard (lint rule or `overrides`), not just a "never import `/tools`" note.

## 8. Method notes — read before citing anything above

- **Within-container A/B by design.** container-cold-start-probe measured colo as a ~3.5×
  nuisance variable, *assigned not chosen*, so a cross-session comparison against its 8–10 s
  baseline would measure placement. Both arms share one boot, one colo, one baked
  `/node_modules`. **The ratio is the trustworthy number; absolute times are not comparable
  across experiments.**
- **A discarded warm-up build runs first** so neither arm pays to populate vite's shared
  `/node_modules/.vite` dep cache.
- **Arm B's `rm`+`cp` prefix is measured separately** (`B*_prep_only_control`, 36 ms) and is
  inside arm B's number — i.e. arm B is *flattered* by at most 36 ms, which does not move a 1.05×.
- **Real kernel FUSE verified per run** — `/proc/mounts` showed
  `/dev/fuse /workspace fuse rw,nosuid,nodev,relatime,user_id=0,group_id=0,max_read=524288`
  on all of them. `FUSE_MOUNT=auto` degrades silently to a userspace shim where `/dev/fuse` is
  absent (under `wrangler dev`), which is why this is checked and not assumed.
- **Timing marks are all separated by awaited RPCs**, so `Date.now()` advances between them
  ([[cf-clock-traps]] #3). `drive.mjs` times each request externally: driver and worker totals
  agreed within ~0.2 s on every run, so the DO-side clock is trusted.
- **n = 15 pairs, one account, one app, two colos (IAD, CMH), one afternoon.** Enough to
  distinguish 1.05× from the 2×+ that would have mattered; not a powered result.
- ⓘ `apps/nebula`'s containers block is currently **`standard-2`**; the collapse task's prose
  still says `standard-1`. This spike matched the code.
- ⓘ `max_instances: 3` capped out after a handful of runs — each `?instance=` name is a distinct
  DO and container — and new acquisitions then failed with
  `connect failed at stage=health … aborted due to timeout`, which reads exactly like a
  cold/stuck failure but is self-inflicted. Raised to 10.

## 9. What this means for the Galaxy collapse

1. **Adopt `@cloudflare/computer` in the collapse.** The measured objection did not survive
   contact with the measurement, and the design win is real: `applyChanges` /
   `syncToDevContainer` and the bespoke dist-return **are deleted, not ported** (§3).
2. **Budget ~3 s of cold start, not ~1–2 s** (§2), and keep it behind LLM latency.
3. **Keep `node_modules` baked outside the VFS.** Both the mount design and the vendor's
   `npm install` numbers point the same way.
4. **Container-side real git** for any repo-to-repo work (§5); Artifacts stays a later swap.
5. **Guard `zod`** before this dep enters `apps/nebula` (§7).
