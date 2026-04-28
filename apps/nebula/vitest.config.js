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
          exclude: ['test/test-apps/**'],
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
            },
          },
        })],
        test: {
          name: 'baseline',
          include: ['test/test-apps/baseline/**/*.test.ts'],
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
      // Bench project — same harness, *.bench.ts files only. Run via
      // `npm run bench`, not part of `npm test`.
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'browser-bench',
          include: ['test/browser/**/*.bench.ts'],
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
