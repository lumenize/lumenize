# Nebula Studio UI (dev — rough first cut)

The chat-first authoring SPA: talks to **DevStudio** over mesh and embeds the running
**Preview app** in an iframe. This is a deliberately rough first cut to iterate on by
playing — see *Limitations* below.

## Login model — everyone self-provisions, one uniform way

There is **no dev-only login shortcut**. Real users, tests, and you all log in the same way:

1. **Enter your email → "Send magic link".** The Studio resolves your scope via **discovery**
   (`/auth/discover`), then sends a magic link to your one scope. Click the link in your email →
   you land authenticated.
2. **First run (no scope yet)** → the form offers to **claim a Universe slug**; claiming sends the
   magic link to the new scope. First access makes you its founder-admin.
3. **Returning** → the Studio remembers your last scope (localStorage) and auto-connects when a
   valid refresh cookie is present; otherwise it shows the email form again.

An explicit `?scope=<id>` query param **overrides discovery** for a fixed scope — used by the
Playwright `ui-smoke` lane (a dedicated `test-…` sandbox) and for manual debugging. The `test-`
prefix is the reaper's auto-reap marker (single hyphen — `parse-id` rejects consecutive hyphens).

## Run (local dev — two processes)

Prereqs: Docker Desktop running (`docker context use desktop-linux`).

1. **One-time** — add to the **gitignored** root `/.dev.vars` (local-only; never committed or
   deployed):
   ```
   NEBULA_AUTH_BOOTSTRAP_EMAIL=dev@example.com
   ```
   This seeds the first-login admin for the local `wrangler dev` lanes (it's an admin seed, not a
   bypass flag). Then run `npm install` at the **repo root** to register this workspace.

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

3. **Log in with your email** (the magic link arrives by real email — local dev sends from the
   account's verified Email Sending domain), then describe a change. The codegen loop writes the
   generated app to the sandbox; the preview pane reloads to show it.

   > For a throwaway sandbox, append `?scope=test-yourname.test-app.dev` — first login at a fresh
   > `.dev` scope makes you its founder-admin.

## Limitations (first cut — iterate from here)
- **No HMR under the prefix yet** — the preview iframe is force-reloaded on each change
  (HMR-through-proxy is a deferred follow-up).
- **Discovery picker (>1 scope) is Wave 2** — the form handles exactly one resolved scope today;
  more than one logs a pointer (use `?scope=` meanwhile).
- **Prod serving** is via Workers Assets (the deployed Worker serves the built SPA); local dev
  uses vite + proxy.
