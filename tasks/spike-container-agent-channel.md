# Spike — Agent command channel into the dev container (no host docker at the edge)

**Status**: Proposed (drafted 2026-06-17). A **spike**: throwaway, time-boxed 1–2 days, results in `experiments/container-agent-channel/FINDINGS.md` (+ harvested to a reference memory). Not a build — no production code merges (workflow.md § Experiments).
**This spike IS Q5 of the container-vite pivot** (`tasks/nebula-studio.md` § *UI-build architecture* gate 2; `tasks/container-vite-spike.md` Q5). The container-vite spike proved the dev-loop, prod handoff, and cost (GO lean) but left Q5 as the **riskiest unproven piece**: how Studio's server-side coding agent drives the container in production.
**Decision gate**: the FINDINGS feed the go on the pivot. If there's no usable, low-latency command surface, the "feels like real dev" premise — and likely the pivot — fails.

## Why

In the container-vite spike I drove the container with **`docker exec` on the host**. In production there is **no host docker**: the container runs on Cloudflare's infra, fronted by its lifecycle DO, and Studio's agent lives **server-side** in a Nebula DO/facet (`nebula-studio.md` § *Generation engine*). The agent must be able to, against the running `DevContainer`:
- **edit source files** (write `App.vue`, ontology `.d.ts`, `package.json`) and have vite HMR pick them up,
- **run `vite build`** (the publish step) and **start/restart the dev server**,
- **run `git`, `grep`, `kill`, `npm install`** — bash-grade commands,
- **read/stream logs** (vite output, dev-server stderr) to see what broke.

The mechanism is unproven and it's the linchpin. `@cloudflare/containers` exposes the container over a **port** (`containerFetch`), not a native exec API — so the likely shape is a **small command-server baked into the image** that the DO reaches via `containerFetch`, with the **agent → DevContainer** leg over mesh (`lmz.call`). This spike proves that channel and measures its latency, **deployed** (the number that matters — local `docker exec` told us nothing about the edge path).

## The architecture under test

- **Agent (server-side, Nebula DO/facet) → `DevContainer` DO** over mesh (`lmz.call` — never raw RPC; mesh.md).
- **`DevContainer` DO → container** via `containerFetch` to a **command-server** running inside the image (a tiny HTTP server on a second port, e.g. `9000`, distinct from vite's `5173`) that runs the command (`child_process`) and returns/streams stdout+stderr+exit code.
- **Trust boundary (name it):** the command-server port is **only reachable by the DO** (server-side), never browser-routable — the preview proxy exposes vite, not the command port. The agent is Nebula's own class, so scope isolation applies.
- Measured both local (`wrangler dev` + Docker) and **deployed** (via the GHA workflow `.github/workflows/deploy-container.yml` — local image push is blocked by the network path, `[[cf-container-deploy-proxy]]`).

## Spike questions (each: measurable outcome + kill criterion)

Tag: **all phases Exploratory — mechanism TBD.** Deliverable per phase = a captured finding in `FINDINGS.md`. **Run order: Q1 (mechanism) and Q2 (deployed latency) are the kill-fast gates — do them first.**

### Q1 — Exec mechanism through the DO — *kill-fast gate*
A command-server in the image + a `DevContainer` `@mesh` method (e.g. `exec(cmd)`) running it via `containerFetch`. Prove the agent can, by *some* mechanism, run a command in the container and get stdout/stderr/exit code back.
- **Success**: the agent (via a DO mesh call) runs `vite build`, `git status`, writes `App.vue`, and restarts the dev server — each returns output + exit code.
- **Kill**: no usable in-container exec (can't reach a second port via `containerFetch`, or no way to run+return commands).

### Q2 — Deployed command latency — *kill-fast gate*
Round-trip **agent → DevContainer DO → container → back**, deployed (not local docker exec). Measure small commands (`grep`, `git status`, a file write) and a no-op.
- **Success**: warm small-command round-trip is interactive for an agent loop (target < ~300 ms incl. the mesh + WAN legs); comparable to or better than a human-perceptible pause.
- **Kill**: per-command latency so high the loop is painful (e.g. > ~1 s/command warm) and can't be batched around.

### Q3 — Long-running + streaming output
Stream incremental output of a long command (`vite build`, tailing dev-server logs) back to the agent, rather than buffering until exit.
- **Success**: chunked/streamed stdout reaches the agent during a long command; a multi-second build doesn't block or time out the DO call.
- **Kill**: only blocking buffered exec — long builds time out, logs can't be tailed live.

### Q4 — File-write parity with the dev loop
The agent writes source files into the container working tree (by path) and **vite HMR fires** on the change (ties to the container-vite spike's warm save→HMR).
- **Success**: agent writes `App.vue` via the channel → HMR `js-update` pushes to a connected preview (no full reload).
- **Kill**: no reliable write path, or writes don't trigger the watcher (e.g. overlayfs/watch quirk).

### Q5 — Trust boundary (name it, don't fully harden)
Confirm the exec channel is **server-side only**: reachable by the Nebula agent DO over mesh, never by the browser/preview; the command port is not on a browser-routable path; commands are confined to the container.
- **Success**: there is **no browser route** to the command-server; the DO is the sole caller; the choke point is server-side.
- **Kill**: the only way to reach exec also exposes it to the browser/preview (sandbox-escape) with no server-side gate.

### Q6 — ssh tunnel feasibility *(nice-to-have, not load-bearing)*
Probe whether an ssh tunnel into the container is viable as an adjunct (e.g. for human power-user debug). The DO-mediated command-server is the load-bearing path regardless.
- **Success**: feasibility + rough mechanism noted in FINDINGS.
- **Kill**: n/a — its absence doesn't kill the spike.

## Out of scope
- Productionizing anything (spike code never merges).
- The data layer / ontology / mesh / reactive store (untouched).
- The actual Studio agent loop — this spike provides the **channel**, not the agent.
- Full sandbox-escape / command-injection hardening (Q5 names the boundary; full analysis is a later review-panel concern if the pivot proceeds).
- Source durability (Q6 of the container-vite pivot) — separate; design-pinned in `nebula-app-versioning.md`.

## Prior art / references
- `tasks/container-vite-spike.md` + its `FINDINGS.md` — the container + lifecycle-DO proxy + vite loop this builds on; `docker exec` was the local analogue of this channel.
- `@cloudflare/containers` `Container` (`containerFetch`, multi-port) — Cloudflare MCP docs.
- `.github/workflows/deploy-container.yml` — the proven deploy path (local push is blocked, `[[cf-container-deploy-proxy]]`).
- `tasks/nebula-studio.md` § *Generation engine* (agent home = Nebula DO/facet) + § *UI-build architecture* (the pivot this gates); `.claude/rules/mesh.md` (agent→DO is `lmz.call`, never raw RPC).

## Setup (per workflow.md § Experiments)
Fork/extend the container-vite spike: `experiments/container-agent-channel/` (own `package.json`, `wrangler.jsonc`, `Dockerfile` adding the command-server + `git`). Add it as an **individual** `workspaces` entry; `npm install` at root. Capture results in `FINDINGS.md`. Deploy via the GHA workflow for the Q2 deployed numbers. Prune the workspace entry + `git rm` once findings are captured.
