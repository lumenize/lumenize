# Local container dev-loop matrix — RESULTS (2026-06-19)

**Question:** can we run a Cloudflare Container locally (`wrangler dev`) on this machine,
to avoid the deploy-to-Cloudflare friction in the Studio dev loop? Prior memory said no —
that a `LumenizeContainer` (`enableInternet=false`) won't start locally because the
`proxy-everything` egress sidecar severs. This experiment isolates the real variable.

Minimal bare `@cloudflare/containers` Container (trivial HTTP server on 8080, no mesh,
no npm install), `wrangler dev` 4.86, `@cloudflare/containers` 0.3.7.

## Matrix

| Engine          | `enableInternet` | Container starts? | Result |
|-----------------|------------------|-------------------|--------|
| Colima 0.10.3   | `false`          | ❌ | `Failed to start container` / `Network connection lost` |
| Colima 0.10.3   | `true`           | ❌ | `Failed to start container` / `Network connection lost` |
| Docker Desktop  | `false`          | ✅ | `200 OK` — `hello from container` |

## Conclusion — the prior diagnosis was WRONG about the cause

- It is **not** about `enableInternet=false` / the egress sidecar. `enableInternet=true`
  fails on Colima too. The container won't start on **Colima** *regardless* of the flag.
- The real variable is the **container engine**: **Colima fails, Docker Desktop works.**
- The `proxy-everything` sidecar (`workerd-<app>-<class>-<id>-proxy`) is spawned on **both**
  engines (always, independent of `enableInternet`). On Docker Desktop it stays `Up`; on
  Colima it `Exited (1)` — i.e. Colima's VM networking can't sustain the
  workerd↔container(↔sidecar) connection. Mechanism note: in `@cloudflare/containers`
  0.3.7, `enableInternet` is read at **container start** (`doStartContainer`:
  `options?.enableInternet ?? this.enableInternet`), not captured in the base constructor —
  so the "ctor-timing trap" the memory described doesn't apply to start config, and a
  subclass override *does* take effect. It just doesn't matter here, because the engine is
  the blocker.

## Real-stack confirmation (`experiments/container-node-phase0`, the actual LumenizeContainer)

Ran the full phase0 node — `LumenizeContainer` + vite (5173) + command-server (9000) +
mesh + `allowedHosts`+`interceptHttps` — under `wrangler dev` on **Docker Desktop**. Every
deployed-validated behavior reproduced locally:

- `/coexistence` → mesh `pong from demo.app.dev`; identity stamped; `container_schedules`
  table + alarm coexist with Lumenize identity kv.
- `/cmd` → `exec git --version` over the mesh via :9000 → `git version 2.39.5`, **~25ms warm**.
- `/preview` → vite shell (200, `/@vite/client` present) + server-derived scope
  `{activeScope:"demo.app.dev",authScope:"demo.app",appVersion:"dev"}`.
- `/preview-decoy` → request-supplied `?activeScope=evil.g.dev` **ignored** (wrong-Star guard).
- `/boundary` → `cf-container-target-port:9000` stripped → vite shell, not the command-server.
- **HMR loop** (`/tmp/hmr-local-probe.mjs`, built-in WebSocket): file-write → vite recompile
  → HMR push, **`js-update` hot-swap (no full reload), ~114ms end-to-end** (vs deployed ~131ms).

## Follow-up: WARP fixes the *deploy* push from Docker Desktop too → drop Colima (2026-06-19)

Colima was originally installed only to dodge the large-layer registry-push sever
(`wrangler deploy`). That was later fixed by Cloudflare WARP — but only ever proven via
Colima, leaving an "engine split" (dev on Docker Desktop, deploy on Colima). Tested it:
forced a **~200MB uncacheable random layer** (matching the proven Colima figure) and ran
`wrangler deploy` from **Docker Desktop with WARP Connected**.

- `711b2b81d06b` (the 200MB fresh layer): **`Pushed`** clean — the exact path that severed before.
- Container application created; deployed to `https://cld-matrix.transformation.workers.dev`;
  deployed container served `hello from container` (200). Then torn down (`wrangler delete`
  + `wrangler containers delete`).

**Conclusion: Docker Desktop + WARP does BOTH dev and deploy. Colima is redundant — the
engine split is gone.** Colima stopped 2026-06-19; default docker context = `desktop-linux`.

## How to run the local loop

```sh
docker context use desktop-linux      # Docker Desktop must be RUNNING (Colima won't work)
npx wrangler dev --config <container worker>   # builds image, starts container on first fetch
# edit Worker code → [r] rebuilds the image; in-container source edits hot-swap via vite HMR
```

To reproduce this matrix: edit `enableInternet` in `src/index.ts`, swap `docker context use
colima|desktop-linux`, and `npx wrangler dev --config experiments/container-local-dev-matrix/wrangler.jsonc`.
