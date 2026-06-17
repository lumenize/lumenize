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

_Status: **LAUNCHED 2026-06-17** — both kill-fast gates (Q1, Q2) PASS. Image builds, container
boots, vite serves + HMR-patches through the DO proxy. Q3/Q4/Q6 not yet run; Q5 partial._

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

## Q3 — Dev→prod handoff (build → static assets → cheap serving)

- `vite build` in the container → static assets: _TBD_
- app-version (#1b registry) → built-asset set mapping; rollback = repoint: _TBD_

**Verdict:** _TBD_

## Q4 — Cost model at N tenants

- Dev-container cost per active developer (warm-while-focused); prod static: _TBD_
- Build cost per publish + accumulating R2 asset storage across versions/tenants: _TBD_

**Verdict:** _TBD_

## Q5 — Agent control surface — 🟡 partial

- **`docker exec <container> sh -c "…"`** works locally as the command surface — used it to edit
  `src/App.vue` inside the running container and trigger HMR (~70–80 ms spawn overhead/call).
  This is the *local* analogue; in prod the equivalent is a **DO-mediated exec channel** (or the
  container's own command endpoint), since there's no host `docker` at the edge. ssh-tunnel
  feasibility still _TBD_.
- Still to probe: `git`, `grep`, `kill`, `vite build` via the same channel; latency of a
  DO-mediated channel vs. local docker exec.

**Verdict:** _partial — local command surface proven; the prod (edge) channel is the open question._

## Q6 — Source durability on an ephemeral container

- Container stop/restart loses no source; working tree re-hydrates from Galaxy draft store: _TBD_
- per-app `package.json`/lockfile durably stored: _TBD_

**Verdict:** _TBD_

---

## Go / no-go

_Pivot from in-DO-compile to container-in-dev only if no Q hits its kill AND Q1 latency is
within tolerance AND source durability (Q6) is solved. Fill in._
