# container-cold-start-probe

Point-in-time spike (2026-07-20). **A DEPLOYED, throwaway probe** — it exists to measure the one thing
local Docker cannot see, then be deleted. Per `.claude/rules/workflow.md` § Experiments, not a
maintained artifact.

## Why

[`container-dep-restore-bench`](../container-dep-restore-bench/RESULTS.md) measured the Nebula
build-box sequence under local Docker and got a **0.14–0.36 s** container cold start. Larry flagged
that as implausible: a DO cold start is ~300 ms, and a container should be *slower*, not faster.

He's right, and the resolution is that the two numbers measure different things. The local figure is
`docker run` on an already-warm LinuxKit VM with the image resident and page-cached — **no scheduling,
no image pull, no network**. The ~300 ms DO figure is CF-side and includes all of that. So the local
number is a floor that omits precisely the term in question.

This probe measures the real thing: CF's own x64 hardware, real instance acquisition, at a chosen
`instance_type`.

## What it measures

The build-box sequence from `tasks/archive/nebula-galaxy-collapse-and-chat.md` — the container is a stateless
`build(source) → dist` box, **not** a vite dev server (the probe stops the image's vite child so it
does not compete for the limited vCPU):

1. **cold start** — `ctx.container.start()` → first `200` from the command-server's `/healthz`
2. **restore source** — `POST /apply` with the app's `App.vue`
3. **npm install** — one big user dep (`echarts`), or `0` on the baked path
4. **`vite build`**
5. **return dist** — tar + base64 the build output

`?dep=1` adds the user dep, `?dep=0` is the common baked path. Each run uses a **fresh DO id** and
destroys any prior container, so every measurement is a genuine cold start.

## Design notes

- **Raw `ctx.container`, not `extends Container`** (`containers.md`), with `monitor()` attached —
  without it `.running` goes stale and the DO wedges on every container death.
- **Reuses Nebula's REAL image** (`../../apps/nebula/container/Dockerfile` with `image_build_context`
  pointing at its directory), so the numbers describe the image we actually ship — not a lookalike.
- **Clock discipline** (the `cf-clock-traps` memory): `Date.now()` is pinned *within* an invocation but
  advances across awaits. Every mark is separated by an awaited `containerFetch` (real I/O), so the
  deltas are true wall-clock. The harness additionally reports an **external-observer** total, which is
  the sanity check that memory requires on first use.

## Running

```sh
npx wrangler deploy                       # needs WARP ON for the image push ([[cf-container-deploy-proxy]])
curl "https://<deployed-url>/probe?dep=0"  # baked path
curl "https://<deployed-url>/probe?dep=1"  # user adds a dep
npm run teardown                          # REQUIRED — see below
```

⚠️ **Tear it down when finished.** `wrangler delete` does **not** remove the container app or its
running instances; they linger and consume the account's running-instance quota, which then blocks
*new* containers from starting anywhere in the account. `npm run teardown` does both
(`wrangler delete` + `wrangler containers delete`).

Results land in [RESULTS.md](RESULTS.md).
