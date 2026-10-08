# Lumenize Studio UI

The two Vue apps a person sees. The auth screens run on the platform host: login, the page an
emailed link opens, the signup page, Home and logout. Studio runs on each app's own host, chat beside
the app's dev tab, which it frames from the app's `.dev` Star host. Every scope's page is its own
host (ADR-021), and every session lives on the platform host (ADR-022).

## Signing in

Everyone signs in the one way, by an emailed link followed as sent; there is no dev-only shortcut.

1. **Enter your email** on the platform host's login page, and click the link that arrives. Its page
   is a consent screen: Continue signs you in, and Accept takes up a pending membership as well.
2. **Home** lists everything your browser's cookies open, one card per person, and goes straight into
   an account's only app.
3. **An address with nowhere to go** gets the signup page instead, which names an account and its
   first app.

## Run (local dev — two processes)

Prereqs: Docker Desktop running (`docker context use desktop-linux`).

1. **One-time** — set `AUTH_BOOTSTRAP_EMAIL` in the **gitignored** root `/.dev.vars`
   (local-only; never committed or deployed): the address that holds the platform root's admin
   membership on the local stacks. Then run `npm install` at the **repo root**.

2. **One command (recommended)** — from the repo root, `npm run dev:studio`. It opens both
   processes in titled Terminal tabs via [`ttab`](https://www.npmjs.com/package/ttab) (run via
   `npx`, no global install). **One-time:** grant your terminal **Accessibility** permission
   (System Settings ▸ Privacy & Security ▸ Accessibility → enable Terminal.app / iTerm.app), or
   `ttab` can't open tabs.

   *Or by hand (two terminals):*
   - **Terminal A — the Worker** (API + DevContainer): `cd apps/nebula && npm run dev`, which boots
     `wrangler dev` on `:8787` from a derived config with production's `routes` stripped.
   - **Terminal B — the Studio UI**: `cd apps/nebula-studio-ui && npm run dev` — vite on `:5174`,
     serving every `*.lumenize.localhost` host and proxying the routes the Worker answers. *(If
     wrangler chose a non-8787 port, set `NEBULA_WORKER_URL` — `dev:studio` forwards it if you set
     it in your shell.)*

3. **Open <http://platform.lumenize.localhost:5174/auth/login>** in Chrome or Firefox. Every auth
   cookie is `Secure`; Chrome and Firefox treat a `*.localhost` host as secure and store it, and
   Safari does not, so in Safari the click works and the next request carries no cookie.

## Limitations

- **No HMR under the dev tab** — the preview frame is reloaded on each build.
- **Production serving** is via Workers Assets (the deployed Worker serves the built SPAs); local
  dev uses vite and its proxy.
