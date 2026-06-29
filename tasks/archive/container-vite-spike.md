# Spike — Cloudflare Container for the Studio dev loop (real vite), static assets for prod

**Status**: Proposed (drafted 2026-06-17). A **spike**: throwaway, time-boxed 1–2 days, results captured in `experiments/container-vite-spike/FINDINGS.md` (+ harvested to a reference memory). Not a build — no production code merges from the experiment (workflow.md § Experiments).
**App**: `apps/nebula/` adjacent — explores an alternative to the in-DO compile/serve half of Studio build-seq #1a/#1b.
**Decision gate**: the FINDINGS feed a go/no-go on pivoting the UI-build layer from "compile-in-DO + vendored assets" to "container-in-dev + static-assets-in-prod". The data layer (ontology versioning, mesh, Stars, the Vue reactive store) is **out of scope and untouched** either way.

## Why

The in-DO compile + self-hosted-assets approach (`tasks/nebula-studio-compile-pipeline.md` #1a, `tasks/nebula-self-hosted-assets.md`) works, but every rough edge is a symptom of **reimplementing a build toolchain inside a constrained runtime**:
- A committed 3.4 MB tsc bundle + a 1.8 MB Lucide map, **because** `typescript` can't load in workerd and a 5.5 MB module crashed the isolate at load (had to share the Lucide core to fit).
- **No Tailwind JIT** → no arbitrary/parameterized utilities (`grid-cols-3 gap-4 p-6`, `w-[347px]`, `md:`/`hover:` variants) and **no minimal CSS** — we ship the entire DaisyUI stylesheet (58 KB gz) regardless of usage. An AI building real layouts wants exactly the utilities we don't have.
- **No per-app platform-lib pinning** — Vue/DaisyUI/Lucide live in the *Worker code*, so a bump deploys to **all** tenants atomically; an app can't upgrade (or stay back) on its own schedule.
- Landmines this surfaced: `nodejs_compat_v2` (broke real `wrangler dev`), the `bindingMetadata` blank-render bug ([[sfc-compile-needs-bindingmetadata]], [[nodejs-compat-not-v2-suffix]]).

A real toolchain in a **Cloudflare Container** dissolves all of these: vite tree-shakes Lucide, Tailwind JIT gives minimal CSS + arbitrary values, a per-app `package.json`/lockfile gives **per-app version pinning + alternative component libraries**, and the agent gets a real dev surface (start/stop servers, `git`, `grep`, `kill`).

Honest counter-bet (what the spike must beat): in-DO compile is **warm, free, ~sub-2 ms/save** — a genuinely instant dev loop. Containers add cold-start + cost. The spike exists to **quantify** that tradeoff, not argue it.

## The architecture under test (dev-only container)

- **Dev**: a Cloudflare Container per dev sandbox runs real `vite` (HMR), fronted by its lifecycle DO; the agent drives it via a command channel (ssh tunnel is a *nice-to-have*, not load-bearing). **Cold start is mitigated by keeping the container warm while the Studio UI tab is focused** (spin up on focus / first edit; idle-stop on blur+timeout).
- **Prod**: `vite build` in the container → static assets to **R2 / Workers Static Assets** → served from the edge with **no running container in prod** (cheap, CDN). This split is the cost container — heavy toolchain is dev-only.
- **Data layer mostly unchanged**: the app still talks to its Star over mesh/WS; `tasks/nebula-app-versioning.md`'s ontology/app-version *registry concept* stays and now maps an app-version → a built-asset set in R2 (the **UI-bundle-in-SQLite** storage of #1b Decision 2 is the part this would supersede — per-save SQLite writes give way to a container working tree + static build). The one genuine coupling the pivot pulls in is **source durability** (Q6) — the container is ephemeral, so #1b's Galaxy dual-write becomes load-bearing, not optional.
- **Frameworks**: still mandate Vue (+ our reactive store) unless we explicitly add React with an equivalent custom store; the container makes "different component libraries" *possible*, but the store integration is the gating constraint, not the bundler.

## Spike questions (each: measurable outcome + kill criterion)

Tag: **all phases Exploratory — mechanism TBD.** Deliverable per phase = a captured finding (what worked + what failed) in `FINDINGS.md`, not pinned-spec conformance.

**Run order — Q1 and Q2 are kill-fast gates; do them FIRST.** If cold-start/HMR latency (Q1) or proxying HMR-WS through the DO (Q2) fails, the pivot is dead on arrival — **stop and write the finding; don't spend the time-box on Q3–Q5.** Q3 (handoff), Q4 (cost), Q5 (agent surface), Q6 (durability) only matter if Q1+Q2 clear. The 1–2 day box is realistic only with this gating; don't try to answer all six in parallel.

### Q1 — Dev-loop latency (cold start + warm save→see) — *kill-fast gate, run first*
Measure container cold start, `vite` dev-server ready time, and warm HMR save→paint. Test the **warm-while-focused** mitigation (spin-up on tab focus/first edit; idle-stop).
- **Apples-to-apples metric (pin before measuring).** The in-DO baseline measured **compile + reload round-trip**: ~sub-2 ms p50 local (warm) / ~36 ms p50 deployed (Pittsburgh→IAD, network-dominated) — *not* including browser paint. To compare honestly, measure the container's **same segment** (file-write → HMR module pushed to the browser, pre-paint) alongside the fuller save→paint number, so the go/no-go isn't comparing a paint-inclusive number against a network-only one.
- **Success**: warm save→HMR-push beats or approaches the deployed ~36 ms baseline (or is close enough that flexibility justifies the gap); cold start with the warm-tab strategy is rarely user-visible.
- **Kill**: cold start is unavoidable per-save, OR warm save→HMR-push is worse than the deployed baseline by an order users feel and the flexibility doesn't justify it.

### Q2 — Expose the dev server *through* the wrapping DO — *kill-fast gate, run first*
Prove the container's HTTP + **WebSocket (HMR)** survive being proxied through the lifecycle DO (the documented Container-binding pattern), same-origin to the browser preview.
- **Success**: the preview loads + HMR pushes work through the DO proxy; auth/scope injection still has a server-side choke point (no browser-trusted scope).
- **Kill**: WS/HMR can't be proxied through the DO, or the proxy adds prohibitive latency.

### Q3 — Dev→prod handoff (build → static assets → cheap serving)
`vite build` in the container → push the built bundle to R2 / Workers Static Assets → serve prod from the edge with no container. Map an **app-version** (the #1b registry) → a built-asset set.
- **Success**: a built app serves from static assets at the edge; an app-version cleanly addresses its asset set; rollback = repoint to a prior set.
- **Kill**: no clean artifact boundary, or prod serving still needs a running container.

### Q4 — Cost model at N tenants
Model dev-container cost: per-tenant vs pooled vs on-demand, with the warm-while-focused lifecycle. Prod is static (≈ R2 + edge, cheap).
- **Success**: a defensible per-active-developer cost that scales (most tenants idle most of the time → containers stopped).
- **Kill**: idle/stopped containers still bill materially, or per-tenant always-on is required → cost untenable.

### Q5 — Agent control surface
Drive the container from the coding agent: start/stop a dev server, `git`, `grep`, `kill`, run the build. Probe whether an **ssh tunnel** into the container is feasible (uncertain); fall back to a DO-mediated command channel if not.
- **Success**: the agent can run the real dev loop (bash-grade commands) against the container, by *some* mechanism.
- **Kill**: no usable command surface (neither ssh nor a DO command channel) → the "feels like real dev" premise fails.

### Q6 — Source durability on an ephemeral container
Cloudflare Containers have **no guaranteed durable disk across stop/restart** — and the whole warm-while-focused lifecycle (Q1) *deliberately* stops them. So the dev working tree (`.vue`, ontology `.d.ts`, `package.json`/lockfile) can't be trusted to survive on the container. This is the coupling the "data layer untouched" framing hides: #1b Decision 3's parallel source dual-write to the Galaxy draft store stops being optional and becomes **load-bearing** — Galaxy must be the authoritative source, the container a regenerable working copy re-hydrated on (re)start.
- **Success**: a container stop/restart (or eviction) loses **no** source — the working tree re-hydrates from the Galaxy draft store, and the per-app `package.json`/lockfile is part of what's durably stored. The dual-write seam from #1b extends cleanly to "rehydrate a container," not just "rehydrate a DevStar."
- **Kill**: the container model forces source to live somewhere the platform can't durably back (e.g. only-in-container state the agent mutates faster than it can be mirrored), or rehydrate latency makes warm-on-focus impractical → the durability story regresses vs. the in-DO baseline.

## Out of scope
- Productionizing anything (spike code never merges).
- The data layer / ontology / mesh / reactive store (untouched).
- Multi-framework (React store) — note feasibility only; Vue stays mandated for now.
- Security hardening of the container sandbox beyond "name the trust boundary" (full sandbox-escape analysis is a later review-panel concern if we pivot).

## Prior art / references
- `experiments/{dwl-spike,dw-bundler-spike}` (prior Worker-Loader / bundler spikes — check before re-treading).
- Cloudflare Containers + the container-lifecycle-DO + proxy pattern (Cloudflare MCP docs).
- The proven in-DO baseline this is measured against: `tasks/nebula-self-hosted-assets.md` (built, green — its FINDINGS are the concrete ceilings to beat) + `tasks/nebula-studio-compile-pipeline.md` (#1a) + `tasks/nebula-app-versioning.md` (#1b — the registry that survives either way).
- `tasks/preview-iframe-spike.md` (authoring-UX preview — overlaps Q2's proxy/same-origin concern).

## Setup (per workflow.md § Experiments)
Create `experiments/container-vite-spike/` (own `package.json`, `wrangler.jsonc`, container `Dockerfile`); add `"experiments/container-vite-spike"` as an **individual** entry to the root `package.json` `workspaces`; `npm install` at the repo root. Capture results in `experiments/container-vite-spike/FINDINGS.md`. Prune the workspace entry + `git rm` once findings are captured.
