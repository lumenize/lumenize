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
| Does it add a `zod` dependency? | ✅ **No — and the swap REMOVES one** (§7) |
| Net startup cost vs `@cloudflare/shell` | ✅ **−12.4 ms, −207 KiB** (§7b) |
| Does the native Tailwind oxide plugin run on the mount? | ✅ **Yes — verified, real JIT CSS** (§7c) |
| Can `node_modules` live in the VFS and survive container death? | ✅ **Yes — but it costs ~2.3 s/build** (§7c) |
| Is `destroy()` safe mid-session? | ⚠️ **No — tears the capnweb wire** (§7d) |

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
  install** — every git call throws `requires @platformatic/vfs as an optional peer dependency`
  until it is added explicitly. This is the one peer you must actually declare.
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

## 7. ✅ CORRECTED — `@cloudflare/computer` does NOT bring `zod`. We already have it, from `@cloudflare/shell`.

An earlier revision of this file claimed adopting `computer` would drag `zod` in as an ADR-001
footgun. **That was wrong**, and it was wrong in the specific way `calibration.md` §7 describes:
it was a supporting premise asserted under a conclusion nobody was arguing with, so nobody
checked it. Checked now, three ways:

- **A clean `npm i @cloudflare/computer@0.1.1` in an empty directory installs zero `zod` and zero
  `ai`** — 85 packages, and `find -type d -name zod` over the whole tree is empty. Same with the
  dep declared in `package.json`, and same under `--omit=peer`.
- **`apps/nebula` already depends on `zod@4.4.3` TODAY**, via
  `@cloudflare/shell@0.4.0 → @cloudflare/codemode@0.4.1 → zod` (plus `zod@3.25.76` reaching every
  test-having package through `@cloudflare/vitest-pool-workers@0.18.5`).
- `@cloudflare/computer`'s own dependencies are `acorn`, `capnweb`, `just-bash` — **no codemode**,
  which is the package that carries zod on the shell side.

⇒ **Swapping `shell` → `computer` REMOVES a zod path rather than adding one.** No guard, no
`overrides`, no lint rule needed for this.

ⓘ What was actually observed: in *this monorepo's* workspace install, npm did materialize `ai` +
`@ai-sdk` under `@cloudflare/computer` (optional peers), though `zod` resolved to the copy already
hoisted for other packages. It does not reproduce in isolation, nothing bundles it, and
`--omit=peer` suppresses it. A curiosity, not a cost.

## 7b. The swap is a net startup WIN — measured

Three arms, identical DO shape, `wrangler deploy --dry-run` + `wrangler check startup
--workerBundle` (the two-command recipe in `workflow.md` § *Startup cost*):

| arm | bundle | gzip | **active CPU at startup** | GC |
|---|---:|---:|---:|---:|
| baseline (neither package) | 0.55 KiB | 0.32 KiB | **0.0 ms** | 0.0 ms |
| **`@cloudflare/shell` — what nebula imports today** (`Workspace`, `WorkspaceFileSystem`, `createGit`, per `dev-studio.ts:31-32`) | 540.07 KiB | 112.04 KiB | **22.5 ms** | 1.3 ms |
| **`@cloudflare/computer` — the proposed replacement** | 333.07 KiB | 68.49 KiB | **10.1 ms** | 1.3 ms |

⇒ **Net effect of the swap: −207 KiB bundle, −12.4 ms active startup.** The collapsed Galaxy
starts *faster* than the code it replaces, not slower.

For scale, `workflow.md`'s cautionary example (`ts-runtime-parser-validator`, 9.2 MB) spends
~295 ms with 66 ms of GC. Both of these are in a different class entirely — they define a lot and
do very little at module scope, which is the distinction that actually governs startup.

ⓘ Disk footprint runs the other way — `computer` is 85 packages / 90 MB installed vs `shell`'s
59 / 10 MB (the bulk is `just-bash` 24 MB, `sql.js` 19 MB, `@mixmark-io/domino` 9 MB). **Irrelevant
to startup and to the bundle** — none of it is in the import graph — but worth knowing for CI
install time. This is exactly the case `workflow.md` means by *"never gate on byte count."*

## 7c. ROUND 2 — the native Tailwind plugin really runs, and deps-in-the-VFS is a real option

Round 1 baked `node_modules` outside the mount and recommended keeping it there. **That
recommendation did not consider that the container is EPHEMERAL**, so any dep not in the image is
reinstalled on *every* turn, not just the turn that added it. Round 2 asks the question round 1
skipped. (Prompted by Larry, 2026-08-03.)

### The native Tailwind oxide plugin runs — verified, not assumed

This is the capability that forces a container to exist at all ([[studio-keep-container-native-tide]]),
so "the build ran" is a weaker claim than "oxide ran". Both now hold:

```
probe_oxide_native -> /node_modules/@tailwindcss/oxide-linux-x64-gnu/tailwindcss-oxide.linux-x64-gnu.node
build stdout       -> vite v6.4.3 … /*! 🌼 daisyUI 5.7.14 */ … ✓ 1561 modules transformed
                      dist/assets/index-JvU8UIWX.css  14.58 kB │ gzip: 3.66 kB
css probe          -> 14584 bytes of real JIT output
```

The native `.node` binary is present and the build emits genuine Tailwind v4 JIT CSS. **The whole
real toolchain — vite 6, `@vitejs/plugin-vue`, `@tailwindcss/vite` + oxide, daisyUI — runs against
the FUSE mount.**

### Deps in the VFS survive container death — confirmed

| step | time | note |
|---|---:|---|
| `copy_deps_into_vfs` (one-time seed) | **11 753 ms** | 115 MB / 4604 files crossing into DO SQLite |
| `verify_deps_in_vfs` | 1152 ms | 113 MB / 4604 files present |
| build, deps in VFS, cold FUSE cache | **11 530 ms** | vite self-reported 9.87 s |
| **build on a NEW container, no seed step** | **6816 ms** | vite self-reported 4.11 s |

The last row is the important one: the previous container was **destroyed**, a fresh one booted,
**no seed ran**, and the build still succeeded — so `/workspace/node_modules` was still there,
because the VFS lives in Galaxy's SQLite. **Durable `node_modules` across ephemeral containers
works.**

### The trade-off, and why it is not the one-liner either of us assumed

| model | per-turn build | install cost |
|---|---:|---|
| deps baked outside the mount (round 1) | **~4.5 s** | 0 s **while the user stays inside the baked set** — but **2.3–6.6 s on EVERY turn** once they add anything outside it, because the container is ephemeral |
| deps in the VFS | **~6.8 s** | 0 s, always, after an 11.7 s one-time seed |

So it is **+2.3 s on every turn** against **−2.3 to −6.6 s on every turn after the user's first
non-baked dependency**. Not "rare turn" vs "common turn" — that framing was wrong in round 1,
and it is what made the baked recommendation look free.

### ⇒ The hybrid is what both measurements point at

Node resolution from `/workspace/app` walks `/workspace/app/node_modules` → `/workspace/node_modules`
→ `/node_modules`. That is the same property round 1 exploited to keep deps out of the VFS, and it
supports a **two-tier** tree:

- **baked set at `/node_modules`** (ext4, outside the mount) — the curated libs, fast reads, no
  per-turn FUSE cost, no durable storage cost;
- **user-added deps at `/workspace/app/node_modules`** (in the VFS) — durable across ephemeral
  containers, installed once and never again, and **only those few packages pay the FUSE penalty**,
  so the per-turn cost scales with what the user added rather than with the whole 115 MB tree.

⚠️ **Measured endpoints only — the hybrid itself is NOT yet measured.** 4.5 s (all baked) and 6.8 s
(all VFS) bracket it; the mechanism (resolution walk) is verified but the middle of the range is an
inference. Measure before pinning.

ⓘ This also interacts with the separate **http(s)-imports-only** proposal, which was motivated by
exactly this install cost. If deps become durable in the VFS, that proposal's main justification
weakens — it should be re-derived rather than inherited.

### 7d. ⚠️ `destroy()` during a live Workspace session tears the capnweb wire

`mode=recycle` (calling `ctx.container.destroy()` from inside a request that already holds a
Workspace session) failed the whole request with
`Peer closed WebSocket: 1006 WebSocket disconnected without sending Close frame.` The next request
reconnected fine against a fresh container.

⇒ **The ephemeral `start()` … `destroy()` cycle must not run while a Workspace session is open**, or
it must tolerate a 1006 and reconnect. The collapse's build-box drive does `destroy()` after
delivering `dist` — that is exactly this shape, so it needs an explicit teardown order rather than
inheriting round 1's assumption that `destroy()` is a fire-and-forget.

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
3. **`node_modules` placement is NOT settled — go two-tier.** Round 1's "keep it baked" ignored that
   the ephemeral container reinstalls any non-baked dep on *every* turn. Baked set on ext4, user-added
   deps in the VFS (§7c). The hybrid's middle is unmeasured; measure before pinning.
4. **Container-side real git** for any repo-to-repo work (§5); Artifacts stays a later swap.
6. **Order the container teardown explicitly** — `destroy()` during a live Workspace session fails the request (§7d).
5. **No zod guard needed** — `computer` has none, and dropping `shell` removes the path we already have (§7). The swap is also **−12.4 ms of startup and −207 KiB of bundle** (§7b).
