# Nebula Studio UI (dev — rough first cut)

The chat-first authoring SPA: talks to **DevStudio** over mesh and embeds the running
**Preview app** in an iframe. This is a deliberately rough first cut to iterate on by
playing — see *Limitations* below.

## Run (local dev — two processes)

Prereqs: Docker Desktop running (`docker context use desktop-linux`).

1. **One-time** — add to the **gitignored** root `/.dev.vars` (local-only; never committed
   or deployed — these are privilege/test knobs):
   ```
   NEBULA_AUTH_TEST_MODE=true
   NEBULA_AUTH_BOOTSTRAP_EMAIL=dev@example.com
   ```
   (`dev@example.com` must match `DEV_EMAIL` in `src/App.vue`.) Then run `npm install` at the
   **repo root** to register this new workspace.

2. **Terminal A — the Worker** (API + DevContainer): `cd apps/nebula && npm run dev`
   (`wrangler dev`, default `http://localhost:8787`).

3. **Terminal B — the Studio UI**: `cd apps/nebula-studio-ui && npm run dev` (or from the
   repo root, `npm run dev -w nebula-studio-ui`) — vite on `:5174`, proxying `/auth`
   `/gateway` `/dev-container` → `:8787`. Open <http://localhost:5174>. *(If wrangler chose
   a non-8787 port, set `NEBULA_WORKER_URL`.)*

4. Click **Log in (dev)**, then describe a change. The stub codegen writes a placeholder
   `App.vue` to the sandbox; the preview pane reloads to show it.

## Limitations (first cut — iterate from here)
- **Codegen loop** — `DevStudio.chat` drives the real self-correcting tool-calling loop
  (built; spec frozen at `tasks/archive/nebula-codegen-loop.md`, design ref
  `tasks/reference/nebula-agentic-engine-design.md`). This README's "first cut" notes predate
  that landing.
- **No HMR under the prefix yet** — the preview iframe is force-reloaded on each change
  (HMR-through-proxy is a deferred follow-up).
- **Fixed dev scope** `acme.app.dev`; dev-login relies on `NEBULA_AUTH_TEST_MODE` (local
  only — unreachable in a deployed Worker, since `.dev.vars` is never deployed).
- **Prod serving** via Workers Assets (Decision 3) is a later step; dev uses vite + proxy.
