# Real-browser tests for `@lumenize/mesh`

This directory is **the template for real-browser testing of any `@lumenize/*` package that bundles a `LumenizeClient`-derived front end** (mesh itself, nebula-frontend, customer apps).

Why this exists: the `@lumenize/debug` lazy-`import('cloudflare:workers')` regression silently passed every vitest-pool-workers test in 2026-06 because pool-workers resolves dynamic imports at runtime. Real Vite resolves them at bundle-time and refused — users couldn't bundle a NebulaClient. This setup catches that class of bug (and several others) by running tests in real chromium against a real `wrangler dev` worker.

## Two test tiers

| File | What it catches |
|---|---|
| `../lumenize-client-browser.test.ts` | Bundle-time regressions — any `cloudflare:workers` / `node:async_hooks` / browser-incompatible import slipped into `@lumenize/mesh/client` fails Vite resolution and the test never starts. Constructor-time runtime regressions (env-specific API access). |
| `ws-roundtrip-browser.test.ts` | End-to-end runtime regressions — real Cloudflare Email Sending → Email Routing → email-test Worker → cookie → JWT → real WebSocket → `@mesh()` call. Any break anywhere in this pipeline trips the test. |

## Architecture

```
chromium (real browser, headless)
  │  test page at http://localhost:VITE_PORT
  │  fetch('/worker/auth/...')   ─┐
  │                                │ same-origin (cookies flow)
  ↓                                ↓
vite dev server                   dynamicEnvProxyPlugin (vitest.config.js)
                                   │  http-proxy with secure: false
                                   ↓
                                  wrangler dev → ECHO_DO / DocumentDO / SpellCheckWorker
                                  spawned by ./global-setup.ts
```

The Vite plugin proxies `/worker/*` → wrangler-dev via an env var resolved per-request, so chromium and the worker share an origin and `SameSite=Strict` cookies (LumenizeAuth's refresh-token) flow naturally without rewriting attributes.

## Adoption checklist for a new package

1. **Add devDeps**: `@vitest/browser`, `@vitest/browser-playwright`, `playwright`, `http-proxy`. (Match the versions used here unless you have a reason to diverge.)
2. **Copy `dynamicEnvProxyPlugin`** from `packages/mesh/vitest.config.js`. Parameterize per project: `dynamicEnvProxyPlugin({ prefix: '/worker', envVar: 'WRANGLER_PROXY_TARGET' })`.
3. **Add a `browser` project** to your `vitest.config.js`:
   ```js
   plugins: [dynamicEnvProxyPlugin({ prefix: '/worker', envVar: 'WRANGLER_PROXY_TARGET' })],
   test: {
     projects: [
       // ... your other projects
       {
         extends: true,
         plugins: [swcPlugin],  // if your tests use decorators
         test: {
           name: 'browser',
           include: ['test/**/*-browser.test.ts'],
           globalSetup: ['./test/browser/global-setup.ts'],
           browser: {
             enabled: true,
             provider: playwright(),
             headless: true,
             instances: [{ browser: 'chromium' }],
           },
         },
       },
     ],
   },
   ```
4. **Author `test/browser/global-setup.ts`** mirroring this directory's. Spawn `wrangler dev` against your test worker, set `process.env.WRANGLER_PROXY_TARGET` to its announced URL, `project.provide('wranglerBaseUrl', '/worker')`.
5. **Author `test/browser/worker/wrangler.jsonc` + `index.ts`** mirroring whatever your package's getting-started doc shows. Keep `from = 'auth@nebula.lumenize.com'` (or another verified sending domain) on `AuthEmailSender` if you want real email; otherwise use `LUMENIZE_AUTH_TEST_MODE=true` to get the magic-link in the response body directly.
6. **Author your test files**:
   - `test/<your-client>-browser.test.ts` for bundle + instantiate.
   - `test/browser/<your-flow>-browser.test.ts` for the full e2e if you want runtime coverage too.

## Required vars on the test worker

These have to be set in `wrangler.jsonc` `vars:`, **not** secrets:

- `PRIMARY_JWT_KEY` = `"BLUE"` (or `"GREEN"` if you've rotated)
- `LUMENIZE_AUTH_REDIRECT` = some path (`/app` is fine — it's the 302 target on magic-link click)
- `LUMENIZE_AUTH_BOOTSTRAP_EMAIL` = `"test@lumenize.io"` (the test's admin email — first subject registered with this address is auto-approved, so the JWT has `isAdmin: true` and the auth gate doesn't 403)

And these are real secrets that must be set via `wrangler secret bulk`:

- `JWT_PUBLIC_KEY_BLUE` / `JWT_PRIVATE_KEY_BLUE` (and `_GREEN` slot if you use rotation)

> **Heads-up: deployed-worker DO state is permanent.** Once `test@lumenize.io` registers against the *deployed* `lumenize-mesh-browser-e2e` worker, that subject's record persists in DO storage. Subsequent test runs find the existing admin user (still `isAdmin`, so the gate still passes — no breakage). But if you ever need to exercise the "first-time bootstrap" code path against the deployed worker, you'll have to either use a different email, delete the DO storage via the dashboard, or tear down + redeploy the worker. Local `wrangler dev` is fine — `.wrangler/state` can be cleared (`rm -rf .wrangler/state`).

## Deploy bootstrap (one-time per Cloudflare account)

`await createRouteDORequestAuthHooks(env)` at module top-level fails Cloudflare's deploy-time validation if JWT_PUBLIC_KEY_BLUE isn't set yet — but `wrangler secret put` requires the Worker to exist. Resolution:

1. **First deploy** with placeholder PEM-format JWT keys via `--var` (use real PEM strings — Cloudflare validates the SPKI format):
   ```bash
   npx wrangler deploy --config ./test/browser/worker/wrangler.jsonc \
     --var "JWT_PUBLIC_KEY_BLUE:$(cat any-real-public.pem)" \
     --var "JWT_PRIVATE_KEY_BLUE:$(cat any-real-private.pem)" \
     --var "JWT_PUBLIC_KEY_GREEN:..." \
     --var "JWT_PRIVATE_KEY_GREEN:..."
   ```
2. **Set the real secrets** via bulk-upload from a JSON file (gitignored):
   ```bash
   wrangler secret bulk secrets.json --config ./test/browser/worker/wrangler.jsonc
   ```
3. **Re-deploy** normally. The placeholder vars are now superseded by the secrets.

## Cloudflare destination address verification

For real-email tests: the email destination (`test@lumenize.io`) must be marked as a verified destination address for the *specific Worker* sending it. Cloudflare's destination verification is per-Worker, not per-account. Walk through it once via the dashboard (**Email → Send Email → Destination Addresses**). The verification email goes through Email Routing to the deployed `email-test` worker; grab the verification link from `https://email-test.transformation.workers.dev/emails?token=$TEST_TOKEN`.

## Cleanup

To tear down a deployed test worker that's no longer needed:
```bash
wrangler delete --name lumenize-mesh-browser-e2e
```

Storage cleanup happens automatically (DOs get reaped). The bundled artifacts can be removed from the dashboard if you don't want them sitting there.

## Reference files

- `../lumenize-client-browser.test.ts` — bundle + instantiate test
- `ws-roundtrip-browser.test.ts` — full e2e test
- `auth-bootstrap.ts` — magic-link helper used by the e2e
- `global-setup.ts` — wrangler-dev spawner
- `worker/wrangler.jsonc` + `worker/index.ts` — test worker
- `../../vitest.config.js` (top of file) — `dynamicEnvProxyPlugin` definition
