---
paths:
  - "**/package.json"
  - "**/wrangler.jsonc"
  - "**/tsconfig*.json"
  - "**/vitest.config.*"
  - "**/.dev.vars*"
---

# Package Structure, Env & Secrets

## Development-mode `package.json`
No build scripts; point at source. (Publish scripts repoint to `dist/` then revert — see [workflow.md](workflow.md) § Releases.)
```json
{ "type": "module", "main": "src/index.ts", "types": "src/index.ts", "files": ["src/**/*"] }
```
Intra-monorepo deps use `"*"` as the version.

## Standard package files
- `package.json` — no build scripts, points to `src/`
- `src/index.ts` — single export file re-exporting the public API
- `README.md` — minimal: name, tagline, link to website docs, key features, install
- `LICENSE` — `MIT` for open-source packages, or `UNLICENSED` for Nebula code (`packages/nebula-auth`, `apps/nebula`) until the platform ships externally as `BUSL-1.1`. Use the **exact SPDX identifier** in `package.json` `license` (`BUSL-1.1`, not `BSL-1.1`/`BSI-1.1`).
- `dist/` — generated at publish only (gitignored)

**Cloudflare Worker packages** additionally:
- `tsconfig.json` extends root, includes `"types": ["vitest/globals"]`
- `vitest.config.js` (Workers project config — see [testing.md](testing.md))
- `wrangler.jsonc` (DO bindings + class-registration `migrations`; `compatibility_date: "2026-03-12"` or later)
- `worker-configuration.d.ts` — **auto-generated only** via `npm run types`

## Use the global `Env` type
`wrangler types` generates a global `Env` in `worker-configuration.d.ts`. Always use it directly — never `interface Env`, `MyEnv`, or `AuthEnv`.
```typescript
export default { async fetch(request: Request, env: Env) { /* ... */ } }
export function createRoutes(env: Env, options: Config) { /* ... */ }
```
**Use `object` instead of `Env`** only for code in shared packages (`@lumenize/rpc`, `@lumenize/testing`) called by *multiple* packages with different generated `Env`s. If the function lives in the same package as the `wrangler.jsonc` defining the bindings it accesses, use `Env`.

**Widen with an intersection** for the in-between case: source that lives in the same package as its `wrangler.jsonc` but is *also compiled under consumer packages' programs* (a workspace dep points at `src/`, so TS type-checks your source against the consumer's generated `Env`). If the consumer's `Env` lacks a binding you access, don't reintroduce a local `interface Env` (and don't add the var to the consumer's `wrangler.jsonc`) — keep the generated global as the base and widen only at the signature: `env: Env & { DEBUG?: string }` (alias it with a comment if used more than once). Canonical: `tooling/test-endpoints/src/EnvTestDO.ts`, compiled by `packages/fetch` tests whose `Env` has no `DEBUG`.

## Environment variables & secrets
| Location | Committed? | Scope | Best for |
|---|---|---|---|
| `wrangler.jsonc` `[vars]` | Yes | dev + prod | non-secret config |
| `.dev.vars` | No (gitignored) | local dev | secrets, local overrides |
| vitest `miniflare.bindings` | Yes | tests only | test-mode flags |
| `wrangler secret put` | N/A | prod only | production secrets |
| Cloudflare dashboard | N/A | prod only | secrets + non-secret config |

There is no `wrangler` CLI command for non-secret *production* vars — use one of the others. Precedence in local dev/test: vitest miniflare bindings > `.dev.vars` > `wrangler.jsonc`.

- **Secrets must never be committable** (see [critical.md](critical.md)). Centralized in the gitignored root `/lumenize/.dev.vars`; `.dev.vars.example` is the committed template with placeholders instead of actual secrets; `scripts/setup-symlinks.sh` (postinstall) symlinks `.dev.vars` into each package/test dir. **`.dev.vars` resolves relative to the `wrangler.jsonc` location**, so sub-directory wrangler configs (e.g. `test/e2e-email/wrangler.jsonc`) need their own symlink — `setup-symlinks.sh` handles any directory containing a `wrangler.jsonc`.
- **Test-mode flags** (bypass auth, disable rate limits) are security-sensitive: set them in vitest `miniflare.bindings` so they can't leak to production. `LUMENIZE_AUTH_TEST_MODE` is auth-internal only — mesh projects use `createTestRefreshFunction` from `@lumenize/mesh` instead.
- **Privilege-granting bootstrap knobs** (`LUMENIZE_AUTH_BOOTSTRAP_EMAIL` / `NEBULA_AUTH_BOOTSTRAP_EMAIL` — auto-admin for the first subject registering that email) follow the test-mode-flag rule: vitest `miniflare.bindings`, not `wrangler.jsonc` `vars`. Sole exception: a **deployed test harness** (e.g. `packages/mesh/test/browser/worker/`) has no bindings channel, so it carries the var in its `wrangler.jsonc` with a comment marking the exception. Never in a production worker's config — committed vars are world-readable and deploy with the worker, so a bootstrap email there is a standing admin backdoor.

## Self-referencing service bindings
A Worker can bind to its own `WorkerEntrypoint` classes via a self-referencing service binding — the `"service"` field matches the Worker's own `"name"`:
```jsonc
{ "name": "my-worker",
  "services": [{ "binding": "AUTH_EMAIL_SENDER", "service": "my-worker", "entrypoint": "AuthEmailSender" }] }
```
The entrypoint extends `WorkerEntrypoint` and is exported from the entry file; the DO talks to it via RPC through the binding. Works in production and vitest-pool-workers. Prior art: `packages/mesh/test/for-docs/calls/test/wrangler.jsonc`, `packages/fetch/src/fetch-executor-entrypoint.ts`, `packages/auth/test/e2e-email/wrangler.jsonc`.

## Cross-platform `cloudflare:workers` detection
Library code needing `env` from `cloudflare:workers` but also running in Node/Bun/Deno/browser has two approaches — **the choice depends on whether the module must be browser-bundled.**

**Not browser-bundled** (Workers/Node/Bun/Deno only — servers, DOs, CLIs): top-level `await import()` in try/catch.
```typescript
let cfEnv: { MY_VAR?: string } | null = null;
try {
  const mod = await import('cloudflare:workers');
  cfEnv = (mod as { env?: { MY_VAR?: string } }).env ?? null;
} catch { /* Not in Workers — expected in Node/Bun/browser */ }
```
This is a *runtime* guard only.

**Must be browser-bundleable**: ⚠️ the try/catch above does NOT help bundlers — esbuild/Vite/Rollup/webpack statically see the `'cloudflare:workers'` literal even inside `await import(...)` and fail to resolve it. **Any module that transitively reaches a browser bundle must contain zero references to `cloudflare:workers`** (see the invariant comment in `packages/mesh/src/gateway-messages.ts`). Split env-specific code into separate entry files and select via `exports` *conditions*, isolating `cloudflare:workers` to the `workerd` entry:
```jsonc
"exports": { ".": {
  "types": "./src/index.ts",
  "workerd": "./src/index.workerd.ts",   // static cloudflare:workers import lives ONLY here
  "worker": "./src/index.workerd.ts",
  "node": "./src/index.node.ts",          // process.env — also matched by Bun/Deno
  "browser": "./src/index.browser.ts"     // localStorage; no cloudflare:workers
}}
```
Condition keys are runtime-matched tokens, not labels: Cloudflare presents `workerd`/`worker` (not `cloudflare`); Bun/Deno fall through to `node`. Omit `default` so an unmatched toolchain fails loudly rather than shipping a silently-wrong build. Canonical: `@lumenize/debug` (imported by browser-bundled client code, so it can't use the try/catch).
