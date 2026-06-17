# FINDINGS — Cloudflare Container for the Studio dev loop (real vite)

Spike task file: `tasks/container-vite-spike.md`. Throwaway, time-boxed 1–2 days.
Baseline to beat (in-DO compile): **~sub-2 ms p50 local / ~36 ms p50 deployed** compile+reload
round-trip (network-dominated), warm, free.

**Run order:** Q1 + Q2 are kill-fast gates — if either fails, stop and write the finding.

---

## Environment / setup log

- Docker: 28.0.4 (daemon up).
- wrangler: 4.86.0. Account: larry@maccherone.com (OAuth).
- `@cloudflare/containers`: 0.3.7.
- Container image: `node:22-slim` + a Vue 3.5 + vite 6 SFC app (`app/`), deps baked at build.
- Architecture standing up: Worker → `ViteDevContainer` (lifecycle DO, `defaultPort 5173`,
  `sleepAfter 5m`) → `container.fetch()` proxies HTTP + HMR-WS to vite.

_Status: **2026-06-17** — Q1 ✅, Q2 ✅, Q3 ✅, Q4 ✅ (modeled), Q5 🟡 partial, Q6 🟡 (ephemerality
confirmed; durability = integration work). No kill criterion fired. **Strong lean toward the pivot**,
pending a deployed re-measure of Q1 latency and the Q5 edge-channel work._

Measurement harness: `wrangler dev` local (Docker), `curl -w` for HTTP timing, a Node global
`WebSocket` probe (`/tmp/ws-probe.mjs`, `/tmp/hmr-measure.mjs`) for the HMR ws. All numbers are
**local** (no edge network) — compare against the in-DO **local** baseline (~sub-2 ms), not the
deployed ~36 ms (which is network-dominated). A deployed re-run is needed for the real comparison.

---

## Q1 — Dev-loop latency (cold start + warm save→see) — *kill-fast gate* — ✅ PASS (local)

Metric (apples-to-apples with the in-DO baseline): file-write → HMR module pushed to the
browser (pre-paint), alongside the fuller save→paint number.

- **Cold start** (first request → container boot → vite ready → first byte): **~3.18 s** (TTFB).
  Image already built; this is pure runtime boot of `node:22-slim` + vite. The warm-while-focused
  strategy must hide this — it's an order too slow to pay per-save.
- **Warm HTTP** (vite running, doc/asset through the proxy): **~11–14 ms**.
- **Warm save→HMR-push**: **~133–222 ms** measured end-to-end, of which **~70–80 ms is the
  `docker exec` edit harness** (subprocess spawn) → vite's true recompile→push is **~55–140 ms**
  (first edit ~140 ms cold-cache, repeat ~55 ms). Emitted as `js-update` (in-place patch,
  **not** `full-reload`) — preserves component state, exactly the warm loop Studio wants.
- **vs. baseline**: in-DO is ~sub-2 ms local — vite warm HMR is ~1–2 orders slower *locally*,
  but still well under the ~500 ms interactive target and the ~3 s save→refresh target. The
  per-save `docker exec` cost is a harness artifact, not the real agent-edit path.
- Warm-while-focused mitigation (spin-up on focus, idle-stop): `sleepAfter = "5m"` set; not yet
  exercised (need a focus/blur driver). _TBD._

**Verdict:** **success (local).** Warm HMR is interactive; cold start is real and MUST be hidden
by the warm-tab strategy. Re-measure deployed before the go/no-go.

## Q2 — Expose the dev server through the wrapping DO — *kill-fast gate* — ✅ PASS

- **HTTP proxied through the DO loads the app**: ✅ `GET /` returns vite's `index.html` with
  `<script src="/@vite/client">` injected; `/src/App.vue` returns the **compiled** SFC; the
  compile is *correct* — `$setup.marker` bindings (vite threads `bindingMetadata` for free, so
  the in-DO [[sfc-compile-needs-bindingmetadata]] bug simply doesn't exist here).
- **HMR WebSocket survives the DO proxy**: ✅ `ws://…:8787/` (subprotocol `vite-hmr`) upgrades
  **101 in ~39 ms**, receives `{"type":"connected"}`, and `update` frames push through on save.
  **No special header/config handling** — `@cloudflare/containers` `container.fetch()` forwards
  the WS upgrade transparently (and `server.allowedHosts: true` in vite.config to accept the
  proxied Host).
- Server-side auth/scope choke point: not yet wired (the spike Worker proxies blindly). The DO
  *is* the natural choke point — inject scope/deny before `container.fetch()`. _TBD._

**Verdict:** **success.** HTTP + HMR-WS both proxy cleanly through the lifecycle DO.

## Q3 — Dev→prod handoff (build → static assets → cheap serving) — ✅ PASS

`vite build` in the container (one-shot `docker run`, 1561 modules) → **899 ms**, output:

| artifact | raw | gzip |
|---|---|---|
| `index.html` | 0.40 kB | 0.27 kB |
| `assets/index-*.css` | 6.22 kB | **2.09 kB** |
| `assets/index-*.js` (Vue runtime + 1 Lucide icon) | 64.35 kB | 25.66 kB |

- **The minimal-CSS / JIT win the in-DO path can't do** (the whole reason for the pivot):
  - In-DO ships the **entire DaisyUI stylesheet (~58 kB gz)** regardless of use. Here the CSS is
    **2.09 kB gz** — only the utilities actually referenced. **~28× smaller.**
  - The arbitrary value `w-[347px]` is in the CSS as `.w-\[347px\]{width:347px}` — **JIT arbitrary
    values work**; the in-DO DaisyUI-only path can't emit them. `:hover`, `@media(hover:hover)`,
    and the `md:` breakpoint `@media(min-width:48rem)` all present.
  - Lucide tree-shakes to the single imported `House` icon (no ~1.8 MB shared-core hack).
- **Clean artifact boundary**: `dist/` is a standard static bundle (hashed `index.html` + `assets/`).
  `docker cp spike-build:/workspace/dist` extracts it; nothing container-specific leaks in.
- **Served from the edge with NO container**: a pure **Workers Static Assets** worker (`prod/`,
  `assets.directory` + `not_found_handling: single-page-application`, **no `main`, no containers**)
  serves `/` (text/html), `/assets/*.css` (text/css), `/assets/*.js` (text/javascript) all warm
  ~3–16 ms, and SPA deep-link `/items/42` → index.html 200. `prod.log`: **0 container mentions.**
- **app-version → asset-set**: an app-version = one such `dist/` directory; **rollback = repoint**
  the asset directory (or, in #1b's registry, point the version row at a prior R2 prefix).

**Gotcha (productionization note):** `wrangler dev` run from `prod/` walked **up** to the parent
container `wrangler.jsonc` instead of using `prod/wrangler.jsonc` (built a container, ran the proxy
code). Fix: explicit `--config prod/wrangler.jsonc`. Nested wrangler configs need the explicit flag.

**Verdict:** **success.** Real toolchain → tiny tree-shaken bundle → container-less edge serving.
This is the strongest result for the pivot: it directly dissolves the in-DO CSS-bloat / no-JIT /
no-tree-shaking ceilings.

## Q4 — Cost model at N tenants — ✅ PASS (modeled)

CF Containers pricing (Workers Paid $5/mo base): **stopped containers cost $0** — "charges start
when a request is sent … stop after the container goes to sleep." Memory $0.0000025/GiB-s, vCPU
$0.000020/vCPU-s, disk $0.00000007/GB-s; included 25 GiB-h mem + 375 vCPU-min + 200 GB-h disk/mo.

Per **active-developer-hour** (container running while the tab is focused/editing):

| instance | mem/vCPU | worst-case (vCPU billed continuous) | likely (vCPU on actual ~5% duty) |
|---|---|---|---|
| `basic` (1 GiB, ¼ vCPU, 4 GB) | | ~$0.028/hr | ~$0.011/hr |
| `standard-1` (4 GiB, ½ vCPU, 8 GB) | | ~$0.074/hr | ~$0.040/hr |

At ~44 warm-hours/active-dev/month (2 h/day × 22 d — generous; idle-stop caps it): **~$1.2–3.3 /
active-dev / month** worst-case, less likely. First ~25 running-hours/mo are largely covered by the
included allotments. **Cost scales with concurrent *active* editing time, not tenant count** —
idle tenants are stopped = $0, which is exactly the success condition.

- **Prod**: Workers Static Assets (no container, no egress beyond normal) + R2 for versioned asset
  sets — 1000 app-versions × ~70 kB ≈ 70 MB ≈ **$0.001/mo**. Negligible.
- **Build cost**: each publish = a few seconds of container vCPU for `vite build` (~0.9 s CPU here
  + cold spin). Negligible per publish.
- **Cold-start tradeoff**: `sleepAfter` trades idle running-cost for fewer user-visible cold starts
  (Q1). Tune per the warm-while-focused UX.

**Verdict:** **success (no kill).** Stopped = $0 confirmed; warm-while-focused gives a defensible
per-active-dev cost. Risk = heavy *concurrent* editing or oversized instances → use the smallest
viable instance (`basic`) + aggressive idle-stop. _Caveat: vCPU-billed-continuous-vs-actual is the
biggest unknown; confirm against a real metered bill before committing the model._

## Q5 — Agent control surface — 🟡 partial (local proven; edge channel open)

Proven via `docker exec`/`docker run` (the *local* analogue of the agent driving the sandbox):
- **Edit source + trigger HMR** (`sed` in-container → `js-update` push). ~70–80 ms spawn/call.
- **`npm install`** new deps (tailwind v4 + lucide) into the sandbox.
- **`vite build`** (the publish step). Start/stop is the lifecycle DO itself.

Findings:
- **`node:22-slim` has no `git`** — the Dockerfile must `apt-get install -y git` for the agent's
  git surface. `grep` is present; `kill` is a shell builtin.
- **Prod (edge) channel is the real open question**: there's no host `docker` at the edge, so the
  agent must drive the container via a **DO-mediated exec channel** (or a command endpoint inside
  the container). ssh-tunnel feasibility still unprobed. Latency of that channel vs. local docker
  exec is the number that matters for "feels like real dev."

**Verdict:** _partial — local command surface (edit/install/build) proven; the prod DO-mediated
exec channel + its latency is the remaining work. Kill criterion (no usable surface) did NOT fire._

## Q6 — Source durability on an ephemeral container — 🟡 ephemerality confirmed; solution is integration work

- **Ephemerality demonstrated (not just assumed):** the dev container **idled out and was removed**
  (`sleepAfter: 5m` → `docker ps -a` empty); the next request **cold-started a fresh** container.
  Any in-container edits (the `docker cp`'d source) would be **lost**. This confirms the premise:
  the container working tree is disposable.
- **Implication:** #1b Decision 3's parallel source dual-write to the **Galaxy draft store** is
  **load-bearing**, not optional — Galaxy must be authoritative; the container is a regenerable
  working copy re-hydrated on (re)start. The per-app `package.json`/lockfile must be part of the
  durably-stored source set.
- **Out of spike scope to *solve*:** wiring the Galaxy dual-write + rehydrate-on-start reaches into
  nebula (the data layer the spike doesn't touch). Recorded as the integration requirement, not
  built here.

**Verdict:** _ephemerality confirmed; durability is a known, tractable integration (Galaxy dual-write
→ rehydrate). Did NOT hit its kill — no evidence the platform forces un-backable state._

---

## Go / no-go

**Lean: GO (pivot to container-in-dev + static-assets-in-prod), pending two confirmations.**

No kill criterion fired across Q1–Q6. The decisive result is **Q3**: a real toolchain dissolves the
exact in-DO ceilings that motivated the spike — CSS dropped ~28× (58 kB gz → 2.09 kB gz), arbitrary
Tailwind utilities + variants work, Lucide tree-shakes to the one icon used, and the built bundle
serves from the edge with **no container** (≈ free prod). Q2 also retires half of
`preview-iframe-spike.md` (HMR-WS proxies through the DO cleanly).

### Deployed re-measure — ✅ DONE (deployed via GitHub Actions)

Local `wrangler deploy` was blocked by large-layer registry-push failures — **NOT Docker**: both
Docker Desktop (`broken pipe` to its `192.168.65.1:3128` httpproxy, a 4.70+ regression) AND Colima
(`broken pipe` on a *direct* connection `192.168.5.1→104.18.8.144:443`, proxy out of the path) failed
identically, proving it's **the machine's network path to `registry.cloudflare.com` severing large
uploads** → [[cf-container-deploy-proxy]]. **Fix: deploy from CI** — a manual `workflow_dispatch`
GitHub Actions job (`.github/workflows/deploy-container.yml`) that runs only `wrangler deploy` (no
test suite) on a clean-network runner. **It worked first try:** all layers Pushed, build→push→rollout
**~40 s**, live at **`https://container-vite-spike.transformation.workers.dev`**.

**Real deployed numbers (2026-06-17):**
- **Cold start at edge: ~4.1 s** (container provision + vite boot + first byte) — close to local ~3.2 s
  plus edge scheduling. **Must be hidden by warm-while-focused** (same conclusion as local).
- **Warm HTTP through the edge DO: ~150 ms** (3 samples 150–214 ms); compiled SFC serves over the
  edge (`text/javascript`).
- **HMR-WS through the edge DO: 101 upgrade in ~186 ms**, `connected` at ~188 ms — Q2 confirmed at
  the edge (WS proxies through the lifecycle DO over the WAN).

**Caveat:** these are from the measuring client's location (unknown egress), so the absolute WAN
figures aren't directly comparable to the in-DO baseline's Pittsburgh→IAD ~36 ms. The takeaways that
*are* robust: cold start ~4 s (hide it), warm loop interactive (~150–200 ms incl. WAN), HMR-WS works
deployed. This **confirms the earlier ~90–175 ms reasoned estimate** was in the right range and the
**GO** conclusion holds.
**Remaining before committing the pivot (deployed re-measure now ✅ done above):**
- **Q5 edge command channel** — prove a DO-mediated exec channel (no host docker at the edge) with
  acceptable latency; add `git` to the image.
- **Q6 Galaxy dual-write + rehydrate** integration (nebula-side), plus productionizing the Dockerfile /
  lifecycle DO (per-tenant container naming, instance sizing, warm-while-focused spin-up/idle-stop).

**Deploy mechanism (resolved):** container deploys go through `.github/workflows/deploy-container.yml`
(manual `workflow_dispatch`) — local `wrangler deploy` can't push large layers from this machine's
network. CI build→push→rollout ≈ 40 s.

**Honest counter-bet status:** in-DO is still ~1–2 orders faster on warm save *locally* (sub-2 ms vs
vite's ~55–140 ms), but vite's warm loop is well under the interactive bar both local and deployed
(~150–200 ms incl. WAN), and the flexibility win (JIT, tree-shaking, per-app pinning, real dev
surface) is large. Deployed re-measure confirmed the latency gap is acceptable. **GO.**
