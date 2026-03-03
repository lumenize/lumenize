# Phase 2.1: Nebula Test Structure Refactor

**Status**: Pending
**Depends on**: Phase 2 (Baseline Access Control) — Complete
**Package**: `apps/nebula/`

---

## Goal

Refactor the Phase 2 test suite from a flat `test/` directory into a clean split that matches the `@lumenize/mesh` test pattern. This sets up the project for phases 3–9, which will each add test-apps on top of NebulaDO, NebulaClient, etc.

**Current structure** (flat — everything in `test/`):
```
apps/nebula/test/
├── gateway-abuse.test.ts       # e2e integration (uses Browser, SELF)
├── guards.test.ts              # e2e integration (uses Browser)
├── scope-binding.test.ts       # e2e integration (uses Browser)
├── scope-verification.test.ts  # e2e + unit (uses Browser, SELF, env, craftJwt)
├── test-helpers.ts             # shared auth helpers
├── test-worker-and-dos.ts      # test harness: re-exports + test subclasses
└── wrangler.jsonc              # single wrangler config
```

**Target structure** (split — test-apps in subfolders):
```
apps/nebula/test/
├── scope-verification.test.ts  # unit-style tests (craftJwt, verifyNebulaAccessToken)
├── test-helpers.ts             # shared auth helpers (used by all test-apps)
├── test-apps/
│   ├── baseline/               # mini-app: Phase 2 e2e integration tests
│   │   ├── index.ts             # worker entrypoint + DO exports + test subclasses
│   │   ├── index.test.ts        # e2e test file (all Browser-based tests)
│   │   └── test/
│   │       ├── test-harness.ts  # instrumentDOProject (new simplified API)
│   │       └── wrangler.jsonc   # bindings for this test-app
│   └── e2e-email/              # mini-app: real email delivery e2e test
│       ├── index.ts             # worker entrypoint + DO exports + NebulaEmailSender
│       ├── index.test.ts        # real Resend → Email Routing → WebSocket flow
│       └── test/
│           ├── test-harness.ts  # instrumentDOProject
│           └── wrangler.jsonc   # bindings (needs .dev.vars for RESEND_API_KEY, TEST_TOKEN)
└── wrangler.jsonc               # minimal config for root-level tests
```

---

## Principles

1. **Root `test/` = lower-level tests** that import directly from `../src/` and test individual modules. These don't need Browser or the full DO mesh — they use `env` and `SELF` from `cloudflare:test` directly.

2. **`test/test-apps/{name}/` = mini-app integration tests** that compose multiple DOs, NebulaClient, NebulaClientGateway, and auth into realistic e2e scenarios. Each test-app has its own `index.ts` (worker + exports), `test/test-harness.ts` (instrumentDOProject), and `test/wrangler.jsonc`.

3. **No `.js` extensions in imports** — all local imports use extensionless paths (e.g., `'./test-helpers'` not `'./test-helpers.js'`, `'../src/star'` not `'../src/star.js'`).

4. **New `instrumentDOProject` API** — the test harness uses the simplified form that auto-detects DOs via prototype chain walking:
   ```typescript
   import * as sourceModule from '../index';
   import { instrumentDOProject } from '@lumenize/testing';
   const instrumented = instrumentDOProject(sourceModule);
   export const { NebulaClientGateway, Universe, Galaxy, StarTest, ResourceHistory } = instrumented.dos;
   export default instrumented;
   ```

5. **Import from package index, not individual files** — test-app `index.ts` files import from `'../../../src'` (the package's `src/index.ts`) rather than individual source files like `'../../../src/star'`. This ensures tests consume the same public API surface that real consumers see. Only exception: if a test subclass needs access to something not exported from the package index, that's a signal to either export it or rethink the test approach.

---

## Steps

### Step 1: Create the baseline test-app directory structure

Create `test/test-apps/baseline/` with its subdirectories.

### Step 2: Move test-worker-and-dos.ts → test-apps/baseline/index.ts

The current `test-worker-and-dos.ts` becomes the test-app's `index.ts`. Changes:
- Remove all `.js` extensions from imports
- Change imports from individual source files (`'../src/star.js'`, `'../src/universe.js'`, etc.) to the package index (`'../../../src'`)
- Keep all re-exports (production DOs, auth classes, entrypoint)
- Keep test subclasses (`StarTest`, `NebulaClientTest`) in the same file
- The `export default` for the entrypoint stays here

### Step 3: Create test/test-apps/baseline/test/test-harness.ts

New file using the simplified `instrumentDOProject` API:
```typescript
import * as sourceModule from '../index';
import { instrumentDOProject } from '@lumenize/testing';

const instrumented = instrumentDOProject(sourceModule);

// Wrangler requires DO classes as named exports.
export const {
  NebulaClientGateway,
  Universe,
  Galaxy,
  StarTest,
  ResourceHistory,
  NebulaAuth,
  NebulaAuthRegistry,
} = instrumented.dos;

// Non-DO classes are passed through unwrapped
export const { NebulaEmailSender } = instrumented;

export default instrumented;
```

Note: `NebulaEmailSender` is a `WorkerEntrypoint`, not a DO — `instrumentDOProject` auto-classifies it and passes it through unwrapped on the result object.

### Step 4: Move test/wrangler.jsonc → test/test-apps/baseline/test/wrangler.jsonc

Move the existing wrangler config. Changes:
- `"main"` changes from `"test-worker-and-dos.ts"` to `"./test-harness.ts"`
- All bindings, migrations, services, ratelimits, and vars stay the same

### Step 5: Refactor test-helpers.ts in place at test/test-helpers.ts

Keep `test-helpers.ts` at the root `test/` level — it's shared by all test-apps (baseline, dag-tree, resources, etc.). Changes:
- Remove `.js` extension from the `NebulaClientTest` import
- `NebulaClientTest` import path changes from `'./test-worker-and-dos'` to a parameter or re-export pattern — since each test-app may define its own client subclass, `test-helpers.ts` should accept the client class as a generic or import from a shared location
- **Simplest approach**: `createAuthenticatedClient` accepts a factory/class parameter so test-apps can pass their own `NebulaClientTest` subclass. Or: move `NebulaClientTest` to `test-helpers.ts` since it's the shared test client used by all test-apps (the test-app's `index.ts` only needs `StarTest` and other DO subclasses specific to that scenario)
- All package imports stay the same

### Step 6: Merge e2e test files → test-apps/baseline/index.test.ts

Merge the three e2e test files (`gateway-abuse.test.ts`, `guards.test.ts`, `scope-binding.test.ts`) plus the e2e portions of `scope-verification.test.ts` into a single `index.test.ts`. Changes:
- Remove all `.js` extensions from imports
- Import helpers from `'../../test-helpers'` (shared at test/ root)
- Import test subclasses from `'./index'`
- Keep all describe/it blocks as-is (just concatenate with appropriate imports at top)
- The `craftJwt` helper and `matchAccess`/`verifyNebulaAccessToken` unit tests stay in root `test/`

### Step 7: Refactor scope-verification.test.ts for root test/

Keep only the unit-style tests in `test/scope-verification.test.ts`:
- The `matchAccess(authScopePattern, aud)` at entrypoint tests (craftJwt + verifyNebulaAccessToken)
- Remove `.js` extensions from imports
- These tests use `env` from `cloudflare:test` directly — they don't need Browser or the test-app harness
- Move the `admin active-scope switching` describe block to the test-app (it uses Browser)

### Step 8: Create root test/wrangler.jsonc for unit tests

The root-level tests still need a wrangler config for `env` access (JWT private keys, etc.), but it's minimal — no DO bindings needed, just vars and `.dev.vars` secrets:
```jsonc
{
  "name": "nebula-unit-test",
  "compatibility_date": "2025-09-12",
  "vars": {
    "PRIMARY_JWT_KEY": "BLUE",
    "NEBULA_AUTH_REDIRECT": "/app"
  }
}
```

Note: The root `scope-verification.test.ts` uses `env.JWT_PRIVATE_KEY_BLUE` (from `.dev.vars`) and `env.JWT_PUBLIC_KEY_BLUE`/`GREEN` for `verifyNebulaAccessToken`. If these come from `.dev.vars`, the minimal wrangler config above is sufficient. If any tests need DO bindings, they belong in the test-app instead.

### Step 9: Update vitest.config.js for multi-project

Change from single project to three projects (unit, baseline, e2e-email):
```javascript
projects: [
  {
    extends: true,
    test: {
      name: 'unit',
      include: ['test/**/*.test.ts'],
      exclude: ['test/test-apps/**'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './test/wrangler.jsonc' },
          miniflare: {
            bindings: {
              NEBULA_AUTH_TEST_MODE: 'true',
              NEBULA_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
              DEBUG: 'nebula',
            },
          },
        },
      },
    },
  },
  {
    extends: true,
    test: {
      name: 'baseline',
      include: ['test/test-apps/baseline/**/*.test.ts'],
      poolOptions: {
        workers: {
          isolatedStorage: false,
          wrangler: { configPath: './test/test-apps/baseline/test/wrangler.jsonc' },
          miniflare: {
            bindings: {
              NEBULA_AUTH_TEST_MODE: 'true',
              NEBULA_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
              DEBUG: 'nebula',
            },
          },
        },
      },
    },
  },
  {
    extends: true,
    test: {
      name: 'e2e-email',
      include: ['test/test-apps/e2e-email/**/*.test.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './test/test-apps/e2e-email/test/wrangler.jsonc' },
          miniflare: {
            bindings: {
              DEBUG: 'nebula',
            },
            // No NEBULA_AUTH_TEST_MODE — this uses real email delivery
          },
        },
      },
    },
  },
],
```

Note: The `e2e-email` project does NOT set `NEBULA_AUTH_TEST_MODE` — the whole point is to test the real (non-test-mode) magic link flow with actual email delivery via Resend.

### Step 10: Remove `.js` extensions from src/index.ts

The source exports also use `.js` extensions. Remove them:
```typescript
export { NebulaDO, requireAdmin } from './nebula-do';
export { Universe } from './universe';
// etc.
```

### Step 11: Verify

- Run `npm test` from `apps/nebula/` — all 22 tests pass
- Run `npm run type-check` from root — no type errors
- Verify no `.js` extensions remain in any `apps/nebula/` `.ts` file

### Step 12: Delete old files

Remove the files that were moved:
- `test/gateway-abuse.test.ts`
- `test/guards.test.ts`
- `test/scope-binding.test.ts`
- `test/test-worker-and-dos.ts`

(Do NOT delete `test/test-helpers.ts` — it stays at root, shared by all test-apps.)
(Do NOT delete `test/wrangler.jsonc` — it's been replaced with the minimal version for root tests.)

### Step 13: Create test/test-apps/e2e-email/ test-app

New test-app that validates the full real email auth flow through Nebula's entrypoint. Follows the pattern established in `packages/auth/test/e2e-email/`.

**`test/test-apps/e2e-email/index.ts`** — Worker entrypoint + DO exports. Imports from `'../../../src'`. Defines `NebulaEmailSender` subclass (or re-exports from `@lumenize/nebula-auth` if it already has one configured for Resend). Must export the entrypoint default and all DO classes needed for full auth + gateway flow.

**`test/test-apps/e2e-email/index.test.ts`** — Tests the real email cycle:
1. Set up WebSocket listener to deployed `email-test` Worker via `waitForEmail()` (from `packages/auth/test/e2e-email/email-test-helpers.ts` or a shared copy)
2. POST to `/auth/{scope}/email-magic-link` (no `?_test=true`)
3. Wait for real email via WebSocket push
4. Extract magic link from email HTML
5. Click magic link → verify 302 redirect
6. Refresh to get access token
7. Optionally: connect NebulaClient and verify the full WebSocket + mesh flow works with a real-email-bootstrapped session

**`test/test-apps/e2e-email/test/test-harness.ts`** — Standard `instrumentDOProject(sourceModule)` pattern.

**`test/test-apps/e2e-email/test/wrangler.jsonc`** — Full DO bindings (same as baseline), but NO `NEBULA_AUTH_TEST_MODE` in vars. Needs `.dev.vars` symlink for `RESEND_API_KEY` and `TEST_TOKEN`. Add the symlink target to `scripts/setup-symlinks.sh`.

### Step 14: Verify e2e-email

- Ensure `email-test` Worker is deployed (`tooling/email-test/`)
- Run `npm test` — unit + baseline pass (22 tests), e2e-email passes (2–3 tests)
- Verify the e2e-email project can be excluded from CI via `vitest --project unit --project baseline` if needed

---

## Decisions & Rationale

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **`test-apps/` not `for-docs/`** | `test/test-apps/baseline/` | Nebula test-apps aren't documentation examples — they're integration test scenarios. Future phases add more test-apps (e.g., `dag-tree`, `resources`). |
| **Single `index.test.ts` per test-app** | Merge 3 e2e files into one | Each test-app is a self-contained scenario. One file is easier to reason about. Can split later if it grows too large. |
| **`index.ts` not `test-worker-and-dos.ts`** | Follows mesh pattern | The test-app's `index.ts` is its "source code" — the worker + DO exports. Matches `packages/mesh/test/for-docs/getting-started/index.ts`. |
| **Remove `.js` extensions** | Extensionless imports everywhere | Project convention per user request. TypeScript resolution handles it. |
| **Root wrangler minimal** | No DO bindings in root config | Root tests don't instantiate DOs — they call `verifyNebulaAccessToken` directly with `env` secrets. If a test needs DOs, it belongs in a test-app. |
| **`test-helpers.ts` at root `test/`** | Shared by all test-apps | Auth helpers (bootstrapAdmin, browserLogin, createAuthenticatedClient) are needed by every test-app. Avoids duplication across baseline, dag-tree, resources, etc. |
| **Import from `'../../../src'`** | Package index, not individual files | Test-apps consume the same public API surface as real consumers. If a test needs something unexported, that's a design signal. |
| **Separate `e2e-email` test-app** | Own directory + vitest project | Real email tests are slow (network round-trips), require deployed infrastructure (`email-test` Worker), and need different env vars (no `NEBULA_AUTH_TEST_MODE`). Keeping them separate lets `baseline` stay fast and self-contained. |

---

## Verification Checklist

- [ ] `npm test` in `apps/nebula/` — 22+ tests pass (original 22 + e2e-email tests)
- [ ] `npm run type-check` from monorepo root — clean
- [ ] No `.js` extensions in any `apps/nebula/**/*.ts` file
- [ ] Test-app `index.ts` files import from `'../../../src'`, not individual source files
- [ ] `test/test-apps/baseline/test/test-harness.ts` uses simplified `instrumentDOProject(sourceModule)` — no `doClassNames` list
- [ ] Root `test/scope-verification.test.ts` works without Browser/DO bindings
- [ ] `e2e-email` test-app runs without `NEBULA_AUTH_TEST_MODE` and validates real Resend → Email Routing → WebSocket flow
- [ ] `vitest --project unit --project baseline` can run without e2e-email infrastructure
- [ ] Future test-apps can be added to `test/test-apps/{name}/` by adding a vitest project entry
