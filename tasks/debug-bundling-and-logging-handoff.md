# Handoff: logging consistency + @lumenize/debug browser bundling

**Status**: Remote work pushed to branch `claude/mesh-nebula-logging-audit-q4P5U`.
Validation + remaining implementation must continue in a **local** session where
`npm install` works. This file is the complete context transfer — read it and
the two sibling task files (`logging-nebula.md`,
`logging-parser-validator-and-facets.md`) and you have everything.

---

## TL;DR

1. Audited `@lumenize/debug` usage across MESH + NEBULA. Coverage is bimodal:
   good at the DO/auth boundary, dark in the engine layer. Details in the two
   sibling task files.
2. Fixed the two mesh stragglers (raw `console.*` in the client; lost
   fire-and-forget errors in `lmz-api.ts`).
3. Discovered that doing #2 reintroduced a `cloudflare:workers` reference into
   the **browser-safe** `@lumenize/mesh/client` bundle — the original reason
   `LumenizeClient` used `console.*`. Fixed it by converting `@lumenize/debug`
   from a runtime `try/catch` import to **package-export conditions**.
4. Updated `CLAUDE.md`'s "Cross-Platform Cloudflare Detection" section to match.

**None of the test/bundle validation has run** — the container's `npm install`
is broken by a pre-existing version skew (see "Validation gates").

---

## Commits on this branch (newest last)

- `5b4924c` — mesh: route client logging through `@lumenize/debug`; surface lost
  fire-and-forget errors in `lmz-api.ts`; rewrite 3 message-handling tests;
  add the two task stubs.
- `740274e` — debug: select env via package-export conditions; drop
  `cloudflare:workers` from the browser/node builds.
- `986e27d` — docs: correct CLAUDE.md cross-platform detection guidance.

(Plus PR #12 was opened for the mesh-only slice — note its body predates the
debug refactor.)

---

## The bundling problem and the fix (don't lose this)

### Why the client couldn't use `@lumenize/debug`
`@lumenize/mesh` has a browser-safe subpath entry `./client`
(`packages/mesh/src/client-index.ts`) that **must not transitively import
`cloudflare:workers`** — see the invariant comment at the top of
`packages/mesh/src/gateway-messages.ts`. `LumenizeClient` is exported from it.

`@lumenize/debug` used to detect its env with a top-level
`await import('cloudflare:workers')` in a try/catch. That's fine at *runtime*
(the catch handles non-Workers), but **bundlers statically see the
`'cloudflare:workers'` literal and fail to resolve it**. So importing
`@lumenize/debug` from `lumenize-client.ts` (and `lmz-api.ts`, also in the
client chain) tainted the browser bundle. That is almost certainly why the
client originally used `console.*`.

Confirmed the chain was otherwise clean: `@lumenize/routing` and
`@lumenize/structured-clone` (the client's other deps) do not import
`cloudflare:workers`.

### The fix: multiple import paths via `exports` conditions
`@lumenize/debug` now splits env detection into separate entry files chosen by
package-export conditions, keeping `cloudflare:workers` isolated to the
`workerd` entry:

- `src/create-debug.ts` — env-agnostic core (matcher cache + `debug()` factory),
  parameterized by a `getDebugFilter()`.
- `src/index.workerd.ts` (`workerd`/`worker`) — static `cloudflare:workers`
  `env.DEBUG`. Only resolved inside Workers.
- `src/index.node.ts` (`node`) — `process.env.DEBUG`. Also serves Bun/Deno,
  which fall through to `node` for npm packages.
- `src/index.browser.ts` (`browser`) — `localStorage`.
- `src/index.ts` — universal, `cloudflare:workers`-free fallback for
  `types`/`main` and the existing unit tests (env + localStorage).

`package.json` `exports`:
```jsonc
".": {
  "types": "./src/index.ts",
  "workerd": "./src/index.workerd.ts",
  "worker": "./src/index.workerd.ts",
  "node": "./src/index.node.ts",
  "browser": "./src/index.browser.ts"
}
```

Design decisions (all reversible — flag if you disagree):
- **`workerd`/`worker`, not `cloudflare`** — condition keys are runtime-matched
  tokens; Cloudflare presents `workerd`/`worker`. `cloudflare` matches nothing.
- **`node` covers Bun/Deno** — they fall through to `node`. File is named
  `index.node.ts` (matched token) but its job is "read DEBUG from an env var";
  documented in the file header and README.
- **No `default`** — an unmatched toolchain fails resolution explicitly instead
  of getting a silently-wrong build. This is the riskiest call (see gates).

Public API (`debug(namespace)` + types) is unchanged → no consumer code changes.

---

## Validation gates (DO THESE LOCALLY, in order)

### 0. Unblock `npm install` (pre-existing, blocks everything)
Fresh `npm install` fails with a version skew: packages on disk are `0.25.0`,
but some consumers still range `^0.24.0` (e.g. `apps/nebula` →
`@lumenize/ts-runtime-parser-validator@^0.24.0`, which doesn't exist on disk).
There's also a `@cloudflare/vitest-pool-workers` peer mismatch (mesh pins
`0.12.21`, nebula uses `^0.15.1`). Reconcile the internal `^0.24.0` ranges to
`0.25.0` (this looks like a mid-release-bump artifact) so the workspace resolves.
This was intentionally NOT touched remotely — it edits version numbers during a
release and belongs in human hands.

### 1. debug package unit tests
`cd packages/debug && npx vitest --run` — should pass unchanged (tests only
exercise `process.env.DEBUG` + `debug.reset()`, served by the new `index.ts`).

### 2. mesh test suite
`cd packages/mesh && npm run test:code` — confirms the 3 rewritten tests in
`test/lumenize-client.test.ts` pass and nothing else regressed. Note the test
runtime must resolve `@lumenize/debug` to one of workerd/node/browser; if it
errors with no-matching-condition, that's the no-`default` risk → add
`"default": "./src/index.ts"` to the exports map and retest.

### 3. THE proof — browser bundle of `@lumenize/mesh/client`
This is the whole point. Bundle the client entry for the browser and confirm
`cloudflare:workers` is gone:
```bash
npx esbuild packages/mesh/src/client-index.ts \
  --bundle --platform=browser --format=esm \
  --outfile=/tmp/client-bundle.js
grep -c "cloudflare:workers" /tmp/client-bundle.js   # expect 0 / build succeeds
```
- Before the debug fix this build would fail to resolve `cloudflare:workers`.
- `lmz-api.ts` also imports `node:async_hooks` and `@lumenize/routing`; the
  browser-safe invariant is specifically about `cloudflare:workers`, but if the
  browser bundle also needs `node:` handling, that's a pre-existing concern, not
  caused by these changes. Confirm whether it matters for the real consumer.

### 4. type-check
`npm run type-check` at root (per-package `tsc --noEmit -p tsconfig.json` was
clean for `packages/debug` remotely, including the workerd entry).

---

## Remaining implementation work (PENDING DISCUSSION — not yet greenlit)

These were captured as findings, not plans — decide scope/levels before writing:

- **`logging-nebula.md`** — `apps/nebula/src` is almost entirely un-instrumented
  (star/resources/dag-tree/entrypoint dark; `router.ts` top-level 500 unlogged;
  2 `console.warn` Phase-5.3 placeholders in `nebula-client.ts`). `nebula-auth`
  is already good. Adopt the `nebula.{Class}.{method}` namespace style.
- **`logging-parser-validator-and-facets.md`** — parser-validator has zero
  logging (errors-as-data by design — likely keep it that way); nebula's facet
  path (`star.ts:#ensureFacet`, `resources.ts:transaction`/`parseBatch`) logs
  nothing on validation success/failure or facet load.

### One small decision baked into the mesh commit
`setupFireAndForgetHandler` logs the no-handler failure at **`error()`** (always
outputs) so it can't vanish. If you'd rather treat it as expected/filterable,
change it to `warn()` in `packages/mesh/src/lmz-api.ts`.

---

## Open design questions for the discussion
- Confirm the no-`default` exports stance after seeing whether the local
  toolchain resolves cleanly (gate #2/#3).
- Namespace conventions + log levels for `apps/nebula/src`.
- Whether to log facet validation *successes* or only failures + facet load.
- Whether correlation IDs (trace across Star → Galaxy → facet DO hops) are in
  scope.
