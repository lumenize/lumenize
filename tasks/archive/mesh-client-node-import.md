# `@lumenize/mesh` — Make LumenizeClient Importable from Node / Browser

## Status: Done (2026-04-22)

Phases 1-3 complete. Phase 4 (docs + changelog) deferred until release.

- [`packages/mesh/src/gateway-messages.ts`](../packages/mesh/src/gateway-messages.ts) created — Workers-free home for `GatewayMessageType`, `ClientDisconnectedError`, wire-message interfaces, `GatewayConnectionInfo`, `WS_CLOSE_SUPERSEDED`.
- [`packages/mesh/src/client-index.ts`](../packages/mesh/src/client-index.ts) created — client-only surface (no `LumenizeDO` / `LumenizeWorker` / `LumenizeClientGateway`).
- [`packages/mesh/package.json`](../packages/mesh/package.json) exports now has `"./client": "./src/client-index.ts"`.
- [`packages/mesh/test/node-import.test.mjs`](../packages/mesh/test/node-import.test.mjs) is the regression test, runs under `node --test` via `tsx --test`, wired into `npm test` for `@lumenize/mesh`.
- The alarm-accuracy experiment's Node runner ([`experiments/alarm-accuracy/test/runner.mjs`](../experiments/alarm-accuracy/test/runner.mjs)) now uses the real `LumenizeClient` from `@lumenize/mesh/client` — dogfood validation that the subpath works end-to-end against a real WebSocket against `wrangler dev`.

Vitest suite still green (359 passed). Node smoke + 30-trial sweep green against `wrangler dev`.

**Phase 4 deferred**: package README, website docs, and changelog entry. Pick up at release time (the release workflow will need to handle the new subpath's dist path rewrite too).

---

## Objective

Make `import { LumenizeClient } from '@lumenize/mesh/...'` load cleanly under Node.js and unbundled browsers (and bundler pipelines without Workers shims). Today it throws at module-load time with `Cannot find module 'cloudflare:workers'` — the client is unusable outside the Workers runtime, despite being designed for browsers and Node.

## Motivation

`LumenizeClient` is advertised as a browser/Node mesh peer. In practice no one has ever successfully imported it in those environments because:

- [`packages/mesh/src/lumenize-client.ts`](../packages/mesh/src/lumenize-client.ts) imports the runtime value `GatewayMessageType` from [`./lumenize-client-gateway.js`](../packages/mesh/src/lumenize-client-gateway.js), which top-level imports `DurableObject` from `cloudflare:workers`.
- The barrel [`packages/mesh/src/index.ts`](../packages/mesh/src/index.ts) re-exports `LumenizeClientGateway`, which also eagerly loads the gateway file in ESM link time.
- The entire mesh test suite runs under `vitest-pool-workers`, so every code path has always had `cloudflare:workers` available — the bug was never surfaced by tests.

**Discovered while building the [alarm-accuracy experiment](alarm-accuracy-experiment.md)**, where a Node runner needs to import `LumenizeClient` to speak to a deployed worker. The experiment worked around the bug with a raw-WebSocket client speaking the gateway wire protocol directly, but the underlying bug affects every real end-user of the client library.

`@lumenize/mesh` is published (latest on npm: 0.24.0 as of 2026-04-22). Fix is non-breaking.

## Scope

Only `LumenizeClient` and adjacent exports must be Node/browser-safe. `LumenizeClientGateway`, `LumenizeDO`, `LumenizeWorker`, and `NadisPlugin` are Workers-only by design — they import `cloudflare:workers` directly, and it's fine for them to stay Workers-only.

## Approach

Two coordinated changes:

1. **Extract wire-protocol primitives into a Workers-free module** so `lumenize-client.ts` can import them without pulling in anything Workers-specific.
2. **Add a `./client` subpath export** so Node/browser consumers can opt into a client-only barrel that doesn't transitively re-export Workers code.

The main barrel stays as-is for Workers consumers. Non-breaking.

## Phase 1: Extract the wire-protocol primitives

**Goal**: `lumenize-client.ts` no longer imports anything that transitively loads `cloudflare:workers`.

**Success Criteria**:
- [ ] New file `packages/mesh/src/gateway-messages.ts` contains:
  - `GatewayMessageType` const object (runtime value)
  - `ClientDisconnectedError` class and its `(globalThis as any).ClientDisconnectedError = …` registration side effect
  - Wire-protocol interfaces: `CallMessage`, `CallResponseMessage`, `IncomingCallMessage`, `IncomingCallResponseMessage`, `ConnectionStatusMessage`, `GatewayMessage`, `GatewayConnectionInfo`
- [ ] `gateway-messages.ts` has **zero** imports from `cloudflare:workers`, `node:*`, or any `@lumenize/*` module that does
- [ ] `lumenize-client.ts` imports these from `./gateway-messages.js` instead of `./lumenize-client-gateway.js`
- [ ] `lumenize-client-gateway.ts` imports these from `./gateway-messages.js` too (deduplicated source of truth, no circular dependency)
- [ ] Existing barrel `index.ts` re-exports `GatewayMessageType` and `ClientDisconnectedError` from `./gateway-messages` so existing Workers consumers importing them from `@lumenize/mesh` keep working
- [ ] All existing mesh tests still pass unchanged

## Phase 2: Add the `./client` subpath export

**Goal**: Node/browser consumers have a supported import path that doesn't transitively load Workers code.

**Success Criteria**:
- [ ] New file `packages/mesh/src/client-index.ts` exports **only** Node/browser-safe surface:
  - `LumenizeClient`, `LoginRequiredError`
  - Types: `LumenizeClientConfig`, `ConnectionState`, `LmzApiClient`, `Continuation`, `AnyContinuation`
  - `mesh`, `meshFn`, `isMeshCallable`, `getMeshGuard`, `MESH_CALLABLE`, `MESH_GUARD`, and `MeshGuard` type
  - `GatewayMessageType`, `ClientDisconnectedError`
  - Wire-protocol interfaces (the same ones re-exported from the main barrel)
  - `getOrCreateTabId` and `TabIdDeps` (for browser tab-id management)
  - Must NOT export `LumenizeDO`, `LumenizeWorker`, `NadisPlugin`, `LumenizeClientGateway`, `sql`, `alarms` — those pull in Workers
- [ ] [`packages/mesh/package.json`](../packages/mesh/package.json) gets a subpath export:
  ```jsonc
  "exports": {
    ".":        { "import": "./src/index.ts",        "types": "./src/index.ts" },
    "./client": { "import": "./src/client-index.ts", "types": "./src/client-index.ts" }
  }
  ```
- [ ] Publishing scripts know to point `./client` at the compiled `dist/client-index.js` at release time (if the release workflow rewrites the main export, it must rewrite both)
- [ ] TypeScript consumers importing from `@lumenize/mesh/client` get proper type resolution

## Phase 3: Node-runtime regression test

**Goal**: The bug never regresses. Test runs outside vitest-pool-workers so it catches `cloudflare:workers` leakage.

**Success Criteria**:
- [ ] New file `packages/mesh/test/node-import.test.mjs` runnable with `node --test` (built-in test runner — no extra deps):
  ```javascript
  import assert from 'node:assert';
  import { test } from 'node:test';

  test('LumenizeClient imports cleanly from @lumenize/mesh/client', async () => {
    const mod = await import('@lumenize/mesh/client');
    assert.ok(mod.LumenizeClient, 'LumenizeClient exported');
    assert.equal(typeof mod.mesh, 'function', 'mesh decorator exported');
    assert.ok(mod.GatewayMessageType, 'GatewayMessageType exported');
    assert.ok(mod.ClientDisconnectedError, 'ClientDisconnectedError exported');
  });

  test('main @lumenize/mesh barrel still fails in Node (by design)', async () => {
    // Workers-only surface; Node should still see cloudflare:workers resolution fail.
    // This test documents the boundary — if this starts passing, someone broke the
    // separation and should either update the test or redraw the line.
    await assert.rejects(() => import('@lumenize/mesh'), /cloudflare:workers/);
  });
  ```
- [ ] Add an npm script `test:node-import` in `packages/mesh/package.json` that runs `node --test test/node-import.test.mjs`
- [ ] Wire the script into the monorepo's `npm run test:code` (or equivalent CI entry) so it runs on every PR
- [ ] Script passes locally and in CI

## Phase 4: Documentation updates

**Goal**: Consumers know which path to use from which environment.

**Success Criteria**:
- [ ] Package README ([`packages/mesh/README.md`](../packages/mesh/README.md)) documents the two entry points:
  - `import … from '@lumenize/mesh'` — Workers (DOs, Workers, Gateway)
  - `import … from '@lumenize/mesh/client'` — Node.js, browser, any non-Workers runtime
- [ ] Website docs at `/website/docs/mesh/` that show `LumenizeClient` usage update their import paths to `@lumenize/mesh/client` (the `getting-started` narrative and any `@check-example`-linked code)
- [ ] JSDoc examples on `LumenizeClient` use the `/client` subpath
- [ ] Changelog entry for the fix version: "**Fixed:** `LumenizeClient` now imports cleanly from Node.js and browsers via `@lumenize/mesh/client`. Previously `@lumenize/mesh` transitively loaded `cloudflare:workers` and failed at module load outside the Workers runtime."

## Open Questions

- **Should the main barrel also expose `./client` functionality?** Right now Workers consumers can `import { LumenizeClient } from '@lumenize/mesh'` because the Gateway is in the same process anyway. After the split, both paths continue to work for Workers consumers (the main barrel still re-exports `LumenizeClient`). Decision: keep both working — no deprecation needed.
- **Worker-side `LumenizeClient` use cases?** `@lumenize/mesh/client` would also work from inside a Worker, since it's a strict subset. If we ever want to *require* Workers consumers to use the main barrel, we'd need a conditional or deprecation — not in scope.

## Non-Issues

- **Tree shaking.** Subpath exports are stronger than relying on bundler tree-shaking because unbundled Node has no tree-shaking at all. The subpath fix handles all three environments (Workers, Node, browser-bundled, browser-unbundled).
- **Breaking Workers consumers.** None of the Workers-side re-exports change shape or location. The main barrel still exports everything it did.

## Notes

- Estimated effort: ~1 hour. Mostly mechanical move of code between files, plus the package.json update and new test.
- Bump minor on release (`0.x.y` → `0.(x+1).0`) since it adds a new public subpath.
- This is surfaced by the [alarm-accuracy experiment](alarm-accuracy-experiment.md), but fixing it is not a prerequisite for running that experiment — the experiment's runner uses a raw-wire-protocol client that sidesteps the import entirely.
