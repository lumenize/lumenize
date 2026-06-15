import { defineConfig } from 'vitest/config';
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import swc from 'unplugin-swc';

// SWC transforms TC39 stage 3 decorators (esbuild can't). See packages/mesh/vitest.config.js.
const swcPlugin = swc.vite({
  include: [/\.tsx?$/],
  exclude: [/node_modules/],
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorVersion: '2022-03' },
    target: 'es2022',
  },
});

export default defineConfig({
  test: {
    testTimeout: 10000,
    globals: true,
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['**/src/**'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.config.*',
        '**/test/**/*.test.ts',
      ],
      skipFull: false,
      all: false,
    },
    projects: [
      {
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/wrangler.jsonc' },
          miniflare: {
            bindings: {
              NEBULA_AUTH_TEST_MODE: 'true',
              NEBULA_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
              DEBUG: 'nebula',
            },
          },
        })],
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/test-apps/**', 'test/browser/**', 'test/frontend/**'],
        },
      },
      // Frontend project — the @lumenize/nebula/frontend layer (factory + the
      // ported pure-helper/engine suites: text-merge, deep-equals, debounce,
      // conflict-outcome). jsdom env (NOT vitest-pool-workers) so Vue can mount
      // components for the v3/v4 component probes; pure-logic tests run fine in
      // jsdom too. swc for the @mesh() decorators NebulaClient carries.
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['test/frontend/**/*.test.ts'],
          testTimeout: 10000,
        },
      },
      {
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/test-apps/baseline/test/wrangler.jsonc' },
          miniflare: {
            bindings: {
              NEBULA_AUTH_TEST_MODE: 'true',
              NEBULA_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
              DEBUG: 'nebula',
              // Phase 5.3.5: shorten the Gateway grace period so
              // drop-on-failed-fanout tests can observe ClientDisconnectedError
              // settle in well under a second. Production-safe (binding only
              // set here in test config).
              LUMENIZE_MESH_GRACE_PERIOD_MS: '100',
            },
          },
        })],
        test: {
          name: 'baseline',
          include: ['test/test-apps/baseline/**/*.test.ts'],
          setupFiles: ['./test/test-apps/baseline/test/setup.ts'],
          // Real-Star WS-connect e2e (esp. the createNebulaClient factory tests:
          // ready / logout / set-union) establish live WebSocket connections that
          // are CPU-contention-sensitive under the full `npm test` run (unit +
          // frontend + baseline + browser projects in parallel). 10s (vitest's
          // default) is tight under that combined load; 30s matches the spike's
          // phase-0b real-Star precedent. Fast tests are unaffected (a timeout
          // only bites when exceeded). vi.waitFor stays at the setup.ts 5s default.
          testTimeout: 30000,
        },
      },
      // Browser project — Node-side vitest tests using @lumenize/testing's
      // Browser class (cookie-aware fetch + CORS validation + WebSocket +
      // multi-tab Context with sessionStorage). Talks over the network to an
      // auto-spawned `wrangler dev` (real Worker isolate) for end-to-end tests
      // that need honest wall-clock timing.
      //
      // Why not vitest-browser/Playwright: vitest-browser runs tests inside an
      // iframe served from vitest's origin. Cross-origin cookies and CORS
      // pre-flight against wrangler-dev are awkward to thread through the
      // iframe. Browser solves both natively in Node and matches the
      // pattern already used in packages/auth/test/e2e-email/.
      //
      // NODE_TLS_REJECT_UNAUTHORIZED=0 accepts wrangler-dev's auto-generated
      // self-signed cert. Required because cookies marked `Secure` (which
      // NebulaAuth sets) won't be accepted over plain http even on localhost.
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'browser',
          include: ['test/browser/**/*.test.ts'],
          globalSetup: ['./test/browser/global-setup.ts'],
          testTimeout: 30000,
          env: {
            NODE_TLS_REJECT_UNAUTHORIZED: '0',
          },
        },
      },
      // Bench project — *.benchmark.ts files using standard it()/expect()
      // (not vi.bench). Why it()-based: the latency bench needs per-call
      // hop decomposition (multiple metrics per iteration) and the
      // throughput bench needs a manual saturation ramp; vi.bench's API
      // measures one number per `bench()` block. it() also gives us
      // expect() for regression-test gating later.
      //
      // Run subset with positional filter:
      //   `npx vitest run --project browser-bench transactions`
      //   `npx vitest run --project browser-bench throughput`
      // or the full suite via `npm run bench:all`.
      //
      // Excluded from `npm test` via positive project enumeration in the
      // test script — these can take a long time and hit deployed
      // infrastructure.
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'browser-bench',
          include: ['test/browser/**/*.benchmark.ts'],
          globalSetup: ['./test/browser/global-setup.ts'],
          testTimeout: 60000,
          env: {
            NODE_TLS_REJECT_UNAUTHORIZED: '0',
          },
        },
      },
    ],
  },
});
