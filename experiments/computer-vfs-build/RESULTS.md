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
| Can `node_modules` live in the VFS and survive container death? | ✅ Yes — **but it is not worth it** (§7c, §7e) |
| Best `node_modules` placement? | ✅ **ext4 — both hybrids lose** (§7e) |
| Does a tenant container have npm registry egress? | ✅ **Yes, HTTP 200 in 46–57 ms** (§7e) |
| Is `destroy()` safe mid-session? | ⚠️ **No — tears the capnweb wire** (§7d) |
| What dominates a turn once a user adds a heavy lib? | ⚠️ On vite 6, **bundling** (4.2 s → 11–18.5 s) (§7f) — **fixed by vite 8** (§7g) |
| Does an http(s)/CDN import skip that? | ❓ UNMEASURED (§7f) — and **largely moot** now (§7g) |
| ⭐ Does vite 8 (rolldown) help? | ✅ **YES — 4–5.8× on heavy deps, cliff gone** (§7g) |

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

## 7e. ROUND 3 — both hybrids LOSE, and registry egress works. Keep deps off the VFS.

Round 2 proposed a two-tier hybrid and left its middle unmeasured. Measured now, 3 runs, one
container per run, using `lucide-vue-next` (**33 MB / 3112 files**) as the stand-in user dep —
chosen because the seed `App.vue` genuinely imports from it, so the build really resolves it.
Times are vite's own self-reported build time, which excludes process startup:

| arm | run 1 | run 2 | run 3 | median | per-build total |
|---|---:|---:|---:|---:|---:|
| **H0** all deps baked on ext4 | 4.78 s | 3.38 s | 4.24 s | **4.24 s** | **4.24 s** |
| **H1** user dep in the VFS (resolution walk) | 9.13 s | 7.64 s | 8.36 s | **8.36 s** | **8.36 s** |
| **H2** user dep durable in VFS, bulk-copied to ext4 first | 3.48 s | 3.18 s | 3.39 s | **3.39 s** | **9.36 s** (5.97 s copy + build) |

- **H1 roughly DOUBLES the build.** 3112 files resolved through FUSE costs ~4.1 s every build,
  forever. The warming trend runs *against* this reading — H1 ran between the two ext4 arms, so
  cache warming would have flattered it, and it was still 2×.
- **H2 is worse.** The bulk copy alone (5.97 s median, in either direction — the VFS seed was
  7.1 s) costs more than an entire baked build. Larry's intuition that chattiness matters was
  right; the problem is that the copy is *also* chatty at 3112 files, so it does not convert the
  per-file cost into a cheap sequential one.
- **H2's build is the fastest arm** (3.39 s) — as expected, since it resolves everything from
  ext4. All the cost moved into the copy.

⇒ **Neither hybrid beats simply keeping `node_modules` on ext4.** The FUSE penalty scales with
file count, and dependency trees are the most file-count-heavy thing in the system. This is the
same conclusion round 1 reached, but round 1 reached it without asking the question.

### Registry egress works — which changes what the real options are

| probe | result (3 runs) |
|---|---|
| `curl https://registry.npmjs.org/lucide-vue-next` from the container | **HTTP 200 in 46–57 ms** |
| `npm config get cache` | `/root/.npm`, 124 K (image build ran `npm cache clean`) |

So a tenant container **can** reach the npm registry today, and fast. Against the earlier probe's
measured `npm install` of one big dep (**2.3–6.6 s**), that means **download is under 2 % of an
install** — the cost is unpack and link, not network.

⇒ **Hybrid C (persist npm's cache in the VFS) is dead on arrival.** It optimises the 46 ms and
leaves the 2–6 s untouched. Worth recording so it is not re-proposed.

⇒ **And plain `npm install` at build time is competitive with H1** (2.3–6.6 s vs H1's +4.1 s
every build) while costing **no DO storage** and adding nothing to DO cold start — which
*does* scale with SQLite size.

### ⚠️ This RETRACTS round 2's read on the http(s)-imports proposal

Round 2 said durable deps in the VFS would weaken that proposal's justification. **They would
not, because the VFS cannot hold deps cheaply.** Both options that keep a real `node_modules`
pay 2–6 s per turn on any non-baked dep, because the container is ephemeral either way. So the
per-turn install cost the http(s)-imports idea was invented to remove is **still there and still
unaddressed** — that proposal stands on its own merits, un-weakened. The levers that actually
move it are (a) curating the baked set so fewer turns need an install at all, and (b) sidestepping
`node_modules`, which is what http(s) imports do.

## 7f. ROUND 4 — ⚠️ THE DOMINANT COST IS BUNDLING, NOT THE FILESYSTEM OR THE INSTALL

Every number in rounds 1–3 used the **baked scaffold only**. Larry asked what happens when a
user-developer adds something *serious*. Measured end to end on a cold container — boot + FUSE
mount + `npm install` + `vite build` + dist back:

| what the app imports | cold boot | npm install | **build** | **whole turn** |
|---|---:|---:|---:|---:|
| baked set only (rounds 1–3) | ~3.0 s | — | **~4.2 s** | **~7.5 s** |
| + `echarts` | 1.7 s / 0.4 s | 4.0 s / 1.4 s | **15.5 s / 11.5 s** | **21.3 s / 13.3 s** |
| + `echarts three date-fns lodash-es` | 0.1 s | 7.1 s | **18.5 s** | **25.6 s** |

**The build is where it goes, and it is rollup bundling the user's imports.** Adding one heavy
library takes the build from ~4.2 s to 11.5–15.5 s; four libraries take it to 18.5 s. Against
that:

- the FUSE-vs-ext4 question (§1, **1.05×**) is **noise**;
- the install itself is **1.4–7.1 s**, secondary;
- and `npm install` was never the thing worth optimising.

⇒ **Larry's "isn't it all under 10 s anyway?" holds for the baked set (~7.5 s) and breaks the
moment a user pulls in a heavy library (13–26 s).** That is the real cliff, and neither the
filesystem work nor the dep-placement work in rounds 1–3 touches it.

⚠️ **This does NOT re-weaken the http(s)-imports proposal — it re-motivates it for a different
reason.** Round 3 said that proposal stands on its install-cost merits. Round 4 says its install
cost is the *small* term; the interesting property is that a CDN/ESM import is **externalised
rather than bundled**, so it would skip the 11–18 s that dominates. That is a much stronger
argument than the one it was originally proposed under.

⚠️⚠️ **But that is a HYPOTHESIS — the http-import arm did NOT produce a valid measurement.**
Three attempts died on shell escaping inside this harness (multi-level TS-template → JSON → sh →
`printf` quoting), not on anything about the platform. **Do not cite an http-import build number;
there isn't one.** The known-good A/B path was re-run afterwards and returned a clean 0.99× with
`cold+mount 1713 ms`, confirming the failures were harness-local. Fixing that arm is the single
highest-value next measurement in this experiment.

ⓘ Two harness bugs worth recording because both produced *plausible* wrong answers first:
`NODE_ENV=production` (pinned in `EXEC_ENV` for build determinism) makes `npm install` **prune
devDependencies**, which silently deleted vite and produced `vite: not found` — fixed with
`--include=dev`. And `ws.fs.writeFile` from the DO during this flow raised `WritableStream RPC
stub was disposed without calling close()`; doing the same write container-side via `exec`
avoids it.

## 7g. ROUND 5 — ⭐ vite 8 (rolldown) DELETES the bundling cliff. This is the biggest result here.

Round 4 concluded that bundling dominates a turn. **That is a rollup fact, not a law.** vite 8.2.0
(published 2026-07-30) drops rollup and esbuild entirely for **rolldown** — the Rust bundler.
Larry asked why we were not already on it. Measured, with the running toolchain verified per run
(`vite/8.2.0 linux-x64 node-v22.23.2 | rolldown: ~1.2.0 | rollup: none`):

| what the app imports | **vite 6 build (rollup)** | **vite 8 build (rolldown)** | speedup |
|---|---:|---:|---:|
| baked set only | ~4 200 ms | **1 770 / 2 885 ms** | ~1.8× |
| + `echarts` | 11 468 / 15 540 ms | **2 702 / 2 812 ms** | **~4–5.5×** |
| + `echarts three date-fns lodash-es` | 18 496 ms | **3 049 / 3 387 ms** | **~5.8×** |

**The cliff is gone.** Under rollup, adding four heavy libraries cost **+14 s** over the baked
baseline. Under rolldown it costs **+1 s**. Whole turns landed at **2.8–7.7 s** warm and 9.9 s on
the one genuinely cold container — i.e. inside Larry's "under 10 s and I stop caring" bar even
with four heavy libraries.

### What this overturns

1. **Round 4's headline is now half-wrong.** Bundling dominated *because we were on a two-major-old
   vite*. It is no longer the dominant term — on vite 8 the **install** (0.6–4.3 s) is usually
   larger than the build (1.8–3.4 s).
2. **The http(s)-imports-only proposal loses its strongest argument again.** Round 4 re-motivated
   it on "a CDN import is externalised rather than bundled, so it skips the 11–18 s". That 11–18 s
   no longer exists. Judge the proposal on install cost and UX, not on build cost. *(The
   http-import arm itself was never successfully measured — see §7f — but it no longer matters
   much what it would have shown.)*
3. **`apps/nebula` should move to vite 8.** Both plugins already declare support —
   `@vitejs/plugin-vue@6.0.8` peers `vite: ^5 || ^6 || ^7 || ^8`, `@tailwindcss/vite@4.3.3` peers
   `^5.2 || ^6 || ^7 || ^8` — and vite 8's engines (`^20.19.0 || >=22.12.0`) are satisfied by the
   container's node 22.23.2. ⚠️ **Only this spike's `seed/app/package.json` was bumped;
   `apps/nebula/container/app/package.json` is untouched.** That adoption is a separate call.
4. It is squarely on the trajectory already recorded in [[studio-keep-container-native-tide]],
   which named "vite→Rolldown (Rust)" as part of the native tide the container exists to ride.

### ⚠️ Method note — the first vite 8 attempt produced WRONG numbers, and that is the lesson

An earlier pass measured vite 8 at **11 179 ms** for `echarts` — barely different from vite 6 — and
nearly got reported as "rolldown does not help much". It was almost certainly executing on a
**stale container** still running the vite 6 image (warm instances linger under `max_instances`,
and a fresh DO can be handed one). Adding a `probe_toolchain` step that prints the *running*
`vite --version` and whether its deps list `rolldown` or `rollup` is what caught it. **Every number
in the table above comes from a run that verified its own toolchain.** ⇒ When an image changes,
probe the runtime rather than trusting the build log — `docker` reporting a rebuilt layer says
nothing about which container answered the request.

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
3. **Keep `node_modules` entirely on ext4 — SETTLED by measurement (§7e).** Both hybrids lose: deps in
   the VFS double the build, and bulk-copying them out costs more than a whole build. Registry egress
   works (46–57 ms), so user extras go through `npm install` at build time. The per-turn install cost
   on non-baked deps is real and unsolved by FUSE — curate the baked set, and judge the http(s)-imports
   proposal on its own merits.
4. **Container-side real git** for any repo-to-repo work (§5); Artifacts stays a later swap.
6. **Order the container teardown explicitly** — `destroy()` during a live Workspace session fails the request (§7d).
5. **No zod guard needed** — `computer` has none, and dropping `shell` removes the path we already have (§7). The swap is also **−12.4 ms of startup and −207 KiB of bundle** (§7b).
