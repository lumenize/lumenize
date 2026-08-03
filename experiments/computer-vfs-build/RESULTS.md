# Results — computer-vfs-build (2026-08-03)

**Status: PARTIAL. The headline number is NOT yet measured** — the deploy is blocked on Docker
Desktop having no registry connectivity on this machine (§4). Everything reachable without a
container image is measured below and stands on its own.

| Question | Status |
|---|---|
| Does the FUSE mount carry our real `vite build`? (headline) | ⛔ **blocked** — needs the deploy |
| Does the mount survive `destroy()`/`start()`? | ⛔ blocked |
| Container boot delta with `computerd` + FUSE | ⛔ blocked |
| Worker **startup** cost of importing `@cloudflare/computer` | ✅ **22 ms / 345.71 KiB** (§1) |
| Does host-side `file://` git work? | ✅ **No — it does not** (§2) |
| Do the optional peers (`zod`, `ai`) land on us? | ✅ **Resolvable but not bundled** (§3) |

---

## 1. Worker startup cost — 22 ms, and it is not a concern

Reported server-side by `wrangler deploy` (the Worker upload succeeded; only the container
image build failed afterwards, so this number is real and from Cloudflare, not local):

```
Total Upload: 345.71 KiB / gzip: 73.56 KiB
Worker Startup Time: 22 ms
```

That is a minimal Worker whose only dependency is `@cloudflare/computer` (workspace + container
backend + `just-bash` + `acorn` + capnweb in the import graph). For scale, the
[do-cold-start-bundle-ab](../do-cold-start-bundle-ab/RESULTS.md) arms measured
`ts-runtime-parser-validator` at 9.2 MB spending ~295 ms of local startup. `@cloudflare/computer`
is nowhere near that class — it defines a lot and does little at module scope, which is exactly
the distinction `workflow.md` § *Startup cost* says to measure rather than infer from bytes.

⚠️ This is the cost **in a minimal Worker**. It is a lower bound on the delta to `apps/nebula`,
not the delta itself — that has to be measured by actually adding the import there.

ⓘ Needed wrangler **4.118.0** (this workspace declares `wrangler` with no pool-workers, so the
caret floated forward). That is *load-bearing here*, not an accident: the `Worker Startup Time`
summary line requires wrangler ≥ 4.116. It stayed contained — **no root-hoisted `wrangler`**, and
the repo's 42 copies of 4.111.0 are untouched.

## 2. Host-side `file://` git does NOT work — the docs and the scheme gate are both wrong

This is the one that answers *"can two repos in one Workspace talk without a git server?"*
Run with a **filesystem-only Workspace** (no `backends`), so no container was involved:

```
  OK   git init /a          OK   git add          OK   git commit -> 93bf420…
  FAIL git clone file:///a -> /b
       UnknownTransportError: Git remote "file:///a" uses an unrecognized transport protocol: "file"
  OK   git remote add origin file:///a
  FAIL git pull origin main (file://)
       GitError: git pull failed: … unrecognized transport protocol: "file"
  FAIL CONTROL git clone ssh://…   ← identical error class
```

**The `ssh://` control is what makes this conclusive.** `file://` fails with the *same*
`UnknownTransportError` as a scheme nobody claims to support. So `file://` is not partially
implemented or misconfigured — isomorphic-git has never heard of it, exactly as the source
reading predicted:

- `git/cli.ts`'s `isSupportedTransport` **permits** `file://`, and `docs/13_git_interface.md`
  states *"`https://`, `http://`, and `file://` are the only supported URL schemes"*.
- `git/network.ts` passes `http:` to isomorphic-git for **every** network op.
- **Zero** occurrences of `file://` in `clone.test.ts`, `cli.test.ts`, or `network.test.ts`.

⇒ **A vendor bug worth reporting upstream** (the gate advertises a transport the layer below
rejects), and ⇒ **for us: local repo-to-repo git must happen container-side with real git**
(`git clone /workspace/app /workspace/build`), never host-side. The task file's
*git as the transport* bullet already says this; it is now measured rather than inferred.

### 2b. Two smaller API findings from the same probe

- **`@cloudflare/computer/git` requires `@platformatic/vfs`,** an optional peer that **npm does
  not install** — every git call throws `requires @platformatic/vfs as an optional peer
  dependency` until you add it explicitly. Note the asymmetry with §3: npm auto-installed the
  peers we *don't* want and skipped the one we do.
- `git.add` takes **`paths`**, not `filepaths`. (Our probe had this wrong first; the failure was
  ours, not the library's. Recorded so the next reader doesn't re-derive it.)

## 3. `zod` and `ai` are installed but not bundled

`peerDependenciesMeta.optional: true` means *"fine if absent"*, **not** *"don't install"* — npm
pulls optional peers by default, so `@cloudflare/computer` physically brings `ai@7.0.48` and
`zod@4.4.3` into `node_modules`.

- **Bundle impact: none.** The 345.71 KiB upload above never imports them; esbuild tree-shakes by
  import graph. They only load via `@cloudflare/computer/tools` (the AI-SDK tool wrappers).
- **Footgun impact: real.** `import { z } from 'zod'` *resolves* once the package is present, so
  a future agent reaching for it gets a working import and a silent **ADR-001** violation.
  ⇒ If `apps/nebula` ever takes this dependency, that needs a guard (lint rule or an explicit
  `overrides`), not just the standing "never import `/tools`" note.

## 4. ⛔ What blocked the headline — Docker registry connectivity, not the spike

The Worker uploaded fine; the container image build then failed:

```
#2 [internal] load metadata for ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.1
#3 [internal] load metadata for docker.io/library/debian:stable-slim
ERROR: failed to build: failed to solve: DeadlineExceeded: context deadline exceeded
```

Both registries — not just GHCR. Diagnosis:

| Check | Result |
|---|---|
| Host reachability of both registries | ✅ `ghcr:401 dockerhub:401` (reachable; 401 is the expected anonymous response) |
| `docker pull debian:stable-slim` | ❌ hangs indefinitely |
| Cloudflare WARP | **Disconnected** ("Manual Disconnection") |
| Docker Desktop proxy | `HTTP/HTTPS Proxy: http.docker.internal:3128` |

So the host has network and Docker does not — the failure is inside Docker Desktop's own proxy
path. **Try, in order: (1) restart Docker Desktop; (2) turn WARP on** — [[cf-container-deploy-proxy]]
records that the deploy *push* needs WARP, and the same proxy chain is in play here.

Not attempted from this session: toggling WARP or restarting Docker are machine-level changes to
a environment that had in-flight work in it.

## 5. Method notes (read before citing anything above)

- **The A/B is within-container by design.** container-cold-start-probe measured colo as a ~3.5×
  nuisance variable, assigned not chosen, so a cross-session comparison against its 8–10 s
  baseline would measure placement. Both arms share one boot, one colo, one baked
  `/node_modules`, identical source bytes.
- **A discarded warm-up build runs first** so neither measured arm pays to populate vite's shared
  `/node_modules/.vite` dep cache.
- **Timing marks are all separated by awaited RPCs**, so `Date.now()` advances between them
  ([[cf-clock-traps]] #3); `drive.mjs` times each request from outside as the external-observer
  cross-check.
- **`/proc/mounts` for `/workspace` is recorded in every result.** `FUSE_MOUNT=auto` silently
  degrades to a userspace shim where `/dev/fuse` is absent (i.e. under `wrangler dev`), which
  would make every number meaningless — so the arm is checked, not assumed.
- ⓘ `apps/nebula`'s containers block is currently **`standard-2`**; the collapse task's prose
  still says `standard-1`. This spike matches the code (`standard-2`), not the prose.

## 6. Next round, already designed

If the FUSE ratio comes back bad, the follow-up is a 2×2 rather than a verdict — split which
*side* of the build touches FUSE, because our dist is tiny (~2 kB gz per container-vite-spike)
while `node_modules` reads are huge:

| arm | source | outDir |
|---|---|---|
| A | FUSE | FUSE |
| B | disk | disk |
| **C** | FUSE | disk (`vite build --outDir /var/tmp/dist`, copy back in one bulk write) |
| **D** | disk | FUSE |

**C is the likely hybrid answer**: durable source in the VFS (what the collapse actually wants)
without paying FUSE for build-output churn. Adding C/D is a worker-code change only — the image
is unchanged, so it is a fast redeploy once §4 is unblocked.
