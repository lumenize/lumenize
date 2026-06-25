# Nebula Studio UI (dev — rough first cut)

> ⚠️ **TEMP dev-login recipe — NOT the model.** The `NEBULA_AUTH_TEST_MODE` + one-click "Log in (dev)" +
> `acme.app.dev` flow documented below is a dead interim kept only for the local dev loop. The real model:
> **every actor (users, tests, you) self-provisions one uniform way** — real-email magic-link login →
> discovery-resolved scope → (first-run) claim a slug. B2 replaces this recipe; see
> [`tasks/nebula-release-process.md`](../../tasks/nebula-release-process.md) § B2 + the `interim-unlearning-tax` rule.

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

2. **One command (recommended)** — from the repo root, `npm run dev:studio`. It opens both
   processes in titled Terminal tabs via [`ttab`](https://www.npmjs.com/package/ttab) (run via
   `npx`, no global install). **One-time:** grant your terminal **Accessibility** permission
   (System Settings ▸ Privacy & Security ▸ Accessibility → enable Terminal.app / iTerm.app), or
   `ttab` can't open tabs. Then open <http://localhost:5174>.

   *Or by hand (two terminals):*
   - **Terminal A — the Worker** (API + DevContainer): `cd apps/nebula && npm run dev`
     (`wrangler dev`, default `http://localhost:8787`).
   - **Terminal B — the Studio UI**: `cd apps/nebula-studio-ui && npm run dev` — vite on
     `:5174`, proxying `/auth` `/gateway` `/dev-container` → `:8787`. *(If wrangler chose a
     non-8787 port, set `NEBULA_WORKER_URL` — `dev:studio` forwards it if you set it in your shell.)*

3. Click **Log in (dev)**, then describe a change. The stub codegen writes a placeholder
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
