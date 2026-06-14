import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { playwright } from '@vitest/browser-playwright';
import swc from 'unplugin-swc';

// SWC transforms TC39 stage-3 decorators (esbuild can't). Required for the
// `@mesh()` decorators on NebulaClient's handler methods (moves into this
// package during the v3 port).
const swcPlugin = swc.vite({
  include: [/\.tsx?$/],
  exclude: [/node_modules/],
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorVersion: '2022-03' },
    target: 'es2022',
  },
});

// Test-mode bindings for the e2e Star/auth stack. Test-mode flags live here in
// miniflare.bindings, never in wrangler.jsonc `vars` (security.md). The
// bootstrap email makes the first magic-link login a founding admin (without it,
// the first authed route 403s — see packaging.md).
const testModeBindings = {
  NEBULA_AUTH_TEST_MODE: 'true',
  NEBULA_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
};

export default defineConfig({
  test: {
    globals: true,
    dangerouslyIgnoreUnhandledErrors: true,
    // e2e/browser projects are scaffolded but unpopulated until their port
    // phases; don't fail an empty project run.
    passWithNoTests: true,
    projects: [
      // unit — factory mechanics (mock client) + the pure-helper/engine detour
      // suites + Vue jsdom component probes. jsdom gives Vue a DOM to mount into.
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['test/unit/**/*.test.ts'],
          testTimeout: 10000,
        },
      },
      // e2e — against a real Star DO via vitest-pool-workers.
      {
        extends: true,
        plugins: [
          swcPlugin,
          cloudflareTest({
            wrangler: { configPath: './test/e2e/wrangler.jsonc' },
            miniflare: { bindings: testModeBindings },
          }),
        ],
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          setupFiles: ['./test/setup.ts'],
          testTimeout: 30000,
        },
      },
      // browser — real-browser harness (Phase 5.3.7-v4). Configured now;
      // probes ported in v4 (vitest-browser-playwright, real WebSocket).
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'browser',
          include: ['test/browser/**/*.test.ts'],
          testTimeout: 30000,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['src/**'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.config.*', 'test/**'],
    },
  },
});
