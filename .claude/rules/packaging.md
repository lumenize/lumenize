---
paths:
  - "**/package.json"
  - "package-lock.json"
  - ".nvmrc"
  - ".github/workflows/*.yml"
  - "**/Dockerfile"
  - "**/wrangler.jsonc"
  - "**/tsconfig*.json"
  - "**/vitest.config.*"
  - "**/.dev.vars*"
---

# Package Structure, Env & Secrets

## Development-mode `package.json`
A package MUST NOT declare build scripts and MUST point at source. (Publish scripts repoint to `dist/` then revert — see [workflow.md](workflow.md) § Releases.)
```json
{ "type": "module", "main": "src/index.ts", "types": "src/index.ts", "files": ["src/**/*"] }
```
Intra-monorepo deps MUST use `"*"` as the version.

## Standard package files
- `package.json` — no build scripts, points to `src/`
- `src/index.ts` — single export file re-exporting the public API. ⚠️ **A `@lumenize/mesh`-composing DO (`ComposedMeshDO`/`LumenizeDO` subclass) MUST NOT be re-exported from this widely-imported index** — pulling the whole mesh chain (transitive `cloudflare:workers` + client/Gateway code) through the index **breaks the transform of pure-unit test files that import the index only for light utilities**: they get a bare `SyntaxError: Invalid or unexpected token` with **no location**, and the whole file silently stops running (marked failed with 0 assertion failures). A DO test that imports `cloudflare:test` transforms the same chain fine, so it looks file-specific and is baffling. A plain `extends DurableObject` (no mesh) in the index is fine — it's the mesh dependency weight. **Fix: the mesh-composing DO MUST be exported from a dedicated subpath** (`"./profile": { "import": "./src/profile.ts" }`), consumers do `import { X } from '@lumenize/pkg/subpath'`. Bit 2026-07-14 (nebula-auth `Profile` DO → `@lumenize/nebula-auth/profile`).
- `README.md` — minimal: name, tagline, link to website docs, key features, install
- `LICENSE` — `MIT` for open-source packages, or `UNLICENSED` for Nebula code (`packages/nebula-auth`, `apps/nebula`) until the platform ships externally as `BUSL-1.1`. `package.json` `license` MUST carry the **exact SPDX identifier** (`BUSL-1.1`, not `BSL-1.1`/`BSI-1.1`).
- `dist/` — generated at publish only (gitignored)

**Cloudflare Worker packages** additionally:
- `tsconfig.json` extends root, includes `"types": ["vitest/globals"]`
- `vitest.config.js` (Workers project config — see [testing.md](testing.md))
- `wrangler.jsonc` (DO bindings + class-registration via the declarative `exports` map — **a `migrations` array MUST NOT be used**, being the retired imperative form your training will reach for first; see [durable-objects.md](durable-objects.md) § DO class registration. ⚠️ this wrangler.jsonc `exports` is the **DO class registry**, a *different thing* from the package.json `exports` field further down this file, which is the Node subpath/condition map; never conflate them; `compatibility_date: "2026-08-15"` or later). For Node builtins you MUST use `compatibility_flags: ["nodejs_compat"]` and MUST NOT use **`"nodejs_compat_v2"`**: with a current compat date `nodejs_compat` already gives v2 semantics AND resolves `node:` module imports in real `wrangler dev`, whereas the `_v2`-suffixed flag does not (a `node:os`/etc. import crashes worker startup with `No such module`). vitest-pool-workers polyfills `node:` builtins independently, so a green pool-workers run masks this — real `wrangler dev` (deployed-Worker harnesses) + prod break.
- `worker-configuration.d.ts` — MUST be **auto-generated only**, via `npm run types`

## Use the global `Env` type
`wrangler types` generates a global `Env` in `worker-configuration.d.ts`. You MUST use it directly, and MUST NOT declare `interface Env`, `MyEnv`, or `AuthEnv`.
```typescript
export default { async fetch(request: Request, env: Env) { /* ... */ } }
export function createRoutes(env: Env, options: Config) { /* ... */ }
```

**The generated `Env` comes from the committed `.dev.vars.example`**, never a developer's own `.dev.vars`: `scripts/generate-types.sh` passes `--env-file`, so every machine and CI generate the same files. A var or secret code reads off `Env` MUST therefore be named there, with an empty value if it has no safe default.
**`object` MAY be used instead of `Env`** only for code in shared packages (`@lumenize/rpc`, `@lumenize/testing`) called by *multiple* packages with different generated `Env`s. If the function lives in the same package as the `wrangler.jsonc` defining the bindings it accesses, it MUST use `Env`.

**Widen with an intersection** for the in-between case: source that lives in the same package as its `wrangler.jsonc` but is *also compiled under consumer packages' programs* (a workspace dep points at `src/`, so TS type-checks your source against the consumer's generated `Env`). If the consumer's `Env` lacks a binding you access, you MUST NOT reintroduce a local `interface Env` and MUST NOT add the var to the consumer's `wrangler.jsonc` — the generated global MUST stay the base, widened only at the signature: `env: Env & { DEBUG?: string }` (alias it with a comment if used more than once). Canonical: `tooling/test-endpoints/src/EnvTestDO.ts`, compiled by `packages/fetch` tests whose `Env` has no `DEBUG`.

## Environment variables & secrets
| Location | Committed? | Scope | Best for |
|---|---|---|---|
| `wrangler.jsonc` `[vars]` | Yes | dev + prod | non-secret config |
| `.dev.vars` | No (gitignored) | local dev | secrets, local overrides |
| vitest `miniflare.bindings` | Yes | tests only | test-mode flags |
| `wrangler secret put` | N/A | prod only | production secrets |
| Cloudflare dashboard | N/A | prod only | secrets + non-secret config |

There is no `wrangler` CLI command for non-secret *production* vars — use one of the others. Precedence in local dev/test: vitest miniflare bindings > `.dev.vars` > `wrangler.jsonc`.

- **Secrets MUST NOT be committable** (see [critical.md](critical.md)). Centralized in the gitignored root `/lumenize/.dev.vars`; `.dev.vars.example` is the committed template with placeholders instead of actual secrets; `scripts/setup-symlinks.sh` (postinstall) symlinks `.dev.vars` into each package/test dir. **`.dev.vars` resolves relative to the `wrangler.jsonc` location**, so sub-directory wrangler configs (e.g. `test/e2e-email/wrangler.jsonc`) need their own symlink — `setup-symlinks.sh` handles any directory containing a `wrangler.jsonc`.
- **Test-mode flags** (bypass auth, disable rate limits) are security-sensitive: they MUST be set in vitest `miniflare.bindings` so they can't leak to production. `LUMENIZE_AUTH_TEST_MODE` is auth-internal only — mesh projects MUST use `createTestRefreshFunction` from `@lumenize/mesh` instead.
- **Privilege-granting bootstrap knobs** (`LUMENIZE_AUTH_BOOTSTRAP_EMAIL` / `NEBULA_AUTH_BOOTSTRAP_EMAIL` — auto-admin for the first subject registering that email) follow the test-mode-flag rule: they MUST go in vitest `miniflare.bindings` and MUST NOT go in `wrangler.jsonc` `vars`. Sole exception: a **deployed test harness** (e.g. `packages/mesh/test/browser/worker/`) has no bindings channel, so it MAY carry the var in its `wrangler.jsonc` with a comment marking the exception. It MUST NOT appear in a production worker's config — committed vars are world-readable and deploy with the worker, so a bootstrap email there is a standing admin backdoor.

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

**Must be browser-bundleable**: ⚠️ the try/catch above does NOT help bundlers — esbuild/Vite/Rollup/webpack statically see the `'cloudflare:workers'` literal even inside `await import(...)` and fail to resolve it. **Any module that transitively reaches a browser bundle MUST contain zero references to `cloudflare:workers`** (see the invariant comment in `packages/mesh/src/gateway-messages.ts`). Env-specific code MUST be split into separate entry files selected via `exports` *conditions*, isolating `cloudflare:workers` to the `workerd` entry:
```jsonc
"exports": { ".": {
  "types": "./src/index.ts",
  "workerd": "./src/index.workerd.ts",   // static cloudflare:workers import lives ONLY here
  "worker": "./src/index.workerd.ts",
  "node": "./src/index.node.ts",          // process.env — also matched by Bun/Deno
  "browser": "./src/index.browser.ts"     // localStorage; no cloudflare:workers
}}
```
Condition keys are runtime-matched tokens, not labels: Cloudflare presents `workerd`/`worker` (not `cloudflare`); Bun/Deno fall through to `node`. `default` MUST be omitted so an unmatched toolchain fails loudly rather than shipping a silently-wrong build. Canonical: `@lumenize/debug` (imported by browser-bundled client code, so it can't use the try/catch).

## `package-lock.json`
`workflow.md` § *Dependencies* states the rule: commit the lock with the `package.json` that caused it, never hand-edit it, and review the `package.json` rather than the lock. This is the mechanism.

- **Churn is normal npm behaviour, not a symptom.** Adding one workspace or one dependency can re-resolve a few hundred lines of unrelated tree: on 2026-08-03, one experiment workspace and two deps produced **1054 insertions / 939 deletions**, including packages nobody asked for.
- **It is generated output.** `.gitattributes` marks it `linguist-generated=true -diff`, so GitHub collapses it in PRs and `git diff` stays readable locally.
- **`npm ci` MUST be used everywhere that isn't deliberately changing deps.** It installs *from* the lockfile and never writes it, so CI cannot drift the tree.
- **A lockfile landing apart from its `package.json` is unbisectable**, and a `package.json` landing without its lockfile breaks the next `npm ci`.
- **The one hand-edit is removing a workspace package.** Edit it surgically, JSON parse → stringify, rather than regenerating it from scratch ([[delete-workspace-package-lockfile]]).
- **Root `overrides` are not the fix for churn** — § *Toolchain bumps* says why.

## Startup cost is work at import, not bytes
**A DO is not a separate deployment** — its class is exported from the Worker bundle, so every DO instance pays for the *whole* Worker's import graph, including code it never touches. Cost is **per-Worker-project**: a dep added anywhere in `apps/nebula`'s graph taxes every DO in it, and moving the heavy import behind a subpath **does not help** while its importers still share the Worker. So "is this dep worth it?" is never a question about one package.

⚠️ **Size is a screening proxy, not the cause.** V8 pre-parses lazily and defers full compilation until a function is *called*, so a bundle that merely **defines** a lot is nearly free. What costs is code that **runs at module scope** — and it is almost always the dependency's, not ours: eager init tables (tsc's keyword/scanner/diagnostic catalogues), `new Map`/regex/`Object.freeze` of "constants", class field initializers and decorators, shim installation, wrangler's `keepNames` `__name()` wrapper per function definition, and the GC to collect it all.

Measured 2026-07-31 on the `do-cold-start-bundle-ab` arms: 2.7 MB → 9.2 MB costs **16×** startup for **3.4×** the bytes, because the two bundles do different *amounts of work*, not proportional amounts — the heavy arm spends most of a 295 ms window on GC and top-level init (tsc + typia), plus ~15 ms in 18,298 `__name()` wrappers. ⇒ That is why `workflow.md` § *Dependencies* forbids gating on byte count: it would fire on `isomorphic-git` (684 KiB, 25 ms, harmless) and stay silent on a small package that builds a big table at import.

**Measure it — two commands, no deploy** (use `--workerBundle`; the direct `check startup` path misdetects a Worker as Pages and exits 1 on 4.113):
```sh
npx wrangler deploy --dry-run --outfile /tmp/w.bundle    # prints Total Upload
npx wrangler check startup --workerBundle /tmp/w.bundle  # → .cpuprofile
```
Read the `.cpuprofile` in `speedscope.app` (Left Heavy) or Chrome DevTools. **Self-time plateaus along the top edge are the cost**; tall narrow towers are deep call chains that cost nothing. A profile with single-digit samples means there is nothing to optimize. Local CPU ≠ Cloudflare's, so it MAY be trusted for *relative* comparison and MUST NOT be cited as a predicted production number — for that, `wrangler deploy` reports a server-side `Worker Startup Time`. The summary line (bundle KiB, active/idle/GC split) needs wrangler ≥ 4.116, which the repo has been past since 2026-10-04.

⚠️ **Startup cost ≠ wake latency.** End-to-end DO `create` and `wake` also depend on eviction depth, which is **not predictable from any of this**: an identical 9.2 MB bundle measured 120 ms and 1,256 ms on repeat runs. Method and full tier data in `experiments/do-cold-start-bundle-ab/RESULTS.md` (2026-07-23, n=10).

## Toolchain bumps
`workflow.md` § *Toolchain bumps* states the rule: `wrangler` moves only together with `@cloudflare/vitest-plugin`, as one triple with `miniflare`, and the Node major moves on its own. This is the mechanism.

**`@cloudflare/vitest-plugin` depends on `wrangler` EXACTLY, 1:1, and drags `miniflare` with it** (1.3.6→4.147.0; derive any pair with `npm view @cloudflare/vitest-plugin@X dependencies`). Every workspace outside `experiments/` that declares `wrangler` also declares the plugin — never one alone — and the repo is uniform **because the plugin hard-pinned it**. It is the v1 name of `@cloudflare/vitest-pool-workers`, whose last release is 0.22.0; npm does not mark the old name deprecated, so nothing in the tree tells you. Bumping `wrangler` on its own splits the tree: our declared version resolves to the newer one while the plugin's nested dep stays pinned to the old, and the root-hoist footgun in `durable-objects.md` § DO class registration is what that feels like.

- **The declared `wrangler` and `@cloudflare/vitest-plugin` versions MUST both be EXACT pins (`"4.147.0"`, `"1.3.6"`), never a caret.** A `^` on `wrangler` re-resolves to the newest wrangler on the next full re-resolve, which is ahead of the plugin's pin whenever wrangler has released since, and npm does not reliably dedupe a caret onto a nested exact pin. Measured 2026-08-29: 25 workspaces landed on 4.127.1 against the nested 4.124.0, and re-pinning exact collapsed the tree to one copy on the spot. A `^1` on the plugin splits the tree the other way: it floats across minors, each minor pins a different wrangler, and the tests run on the plugin's runtime while `wrangler dev` runs on ours. **A published package's `peerDependencies` entry is the exception and MUST be a caret (`^1.3.6`)** — it states what a consumer may bring, not what we install.
- **Root `package.json` `overrides` MUST NOT be reached for to force uniformity, or to tame lockfile churn.** An override does pin one version everywhere, but a **changed** override is silently ignored by `npm install`, `npm update`, `npm dedupe`, `--force` and `--package-lock-only` alike; only deleting `package-lock.json` re-resolves it, so every bump becomes a full lockfile regeneration. Set-once is fine; maintaining one is worse than the problem (both behaviors verified in a scratch monorepo, 2026-07-27).
- **You MUST enumerate over the `workspaces` list, never a `packages/*` glob.** `doc-test/*/*` is a workspaces entry and is easy to miss (`npm ls @cloudflare/vitest-plugin --all`). An experiment that declares `wrangler` *without* the plugin has nothing pinning it forward, which is how stale experiments hoist an ancient wrangler to the repo root; at a bump, its pin MUST either move with the triple or the experiment MUST leave `workspaces`.
- **A bump MUST be judged by each workspace's `Test Files` count, never by the exit code.** A workerd that refuses a compatibility date or flag skips every file that runs inside it, the Node and browser projects still pass, and a config with `dangerouslyIgnoreUnhandledErrors` then exits 0. Measured 2026-10-04: `packages/structured-clone` at a date its workerd refused reported `Test Files 31 passed (31)` against 46, exit 0. `scripts/test-code.sh` now fails a workspace whose output carries Vitest's `[vitest-pool]: Failed to start`, which closes that case. It matches Vitest's message rather than Miniflare's error code because the code changed under this very bump, from `ERR_RUNTIME_FAILURE` to `ERR_FUTURE_COMPATIBILITY_DATE`, and a check keyed on it went blind. The count comparison is still owed for the drops nobody has named yet.

### The Node major
**Baseline: Node 24 LTS ("Krypton").** Six surfaces carry it and MUST move in one sweep, or the lanes silently disagree: root `engines` · `.nvmrc` · `@types/node` (root + `tooling/check-examples` + `tooling/doc-testing`) · every `node-version:` in `.github/workflows/` · `apps/nebula/container/Dockerfile` (`node:24-slim`) · `experiments/computer-vfs-build/Dockerfile` (nodesource `node_24.x`).

- **A Node bump does not imply a toolchain-triple bump, and conflating them destroys your ability to read a failure.** wrangler and miniflare declare `node >=22.0.0`, so a Node major inside that floor costs the triple nothing: on 2026-08-03 the entire suite went green on Node 24 with pool-workers, wrangler and miniflare unchanged, before a single dependency moved.
- **`@types/node` MUST track the RUNTIME major, never "latest".** Types ahead of the runtime typecheck code against APIs that don't exist at runtime — a green `type-check` that ships a `TypeError`. The root pin had drifted to `^25` while the runtime was 22; Node 24 + `@types/node@^24` closes it.
- **npm 11 (bundled with Node 24) WARNS about lifecycle scripts but still RUNS them.** `npm warn allow-scripts … not yet covered by allowScripts` fires for `workerd`/`esbuild` on every install and reads exactly like a block — it is not (verified 2026-08-03). You MUST NOT "fix" this by adding an `allowScripts` allowlist or re-running installs; the warning MUST be treated as noise **until npm actually enforces it**, at which point `npm ci` in CI is what breaks (`calibration.md` §4 — re-derive then, don't pre-build the guard now).
