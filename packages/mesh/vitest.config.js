import { defineConfig } from 'vitest/config';
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import swc from 'unplugin-swc';

// SWC plugin to transform TS (including TC39 stage 3 decorators that esbuild doesn't support).
// Without this, `@mesh()` decorators survive Vite's default esbuild transform and V8 can't parse them.
// See: https://github.com/evanw/esbuild/issues/104
const swcPlugin = swc.vite({
  jsc: {
    parser: {
      syntax: 'typescript',
      decorators: true,
    },
    transform: {
      decoratorVersion: '2022-03',
    },
    target: 'es2022',
  },
});

// Bindings set on every project's miniflare instance. LUMENIZE_MESH_TEST_MODE
// enables test-only behavior in @lumenize/mesh source (currently: longer
// LumenizeClientGateway grace period to tolerate CPU contention from parallel
// miniflare workers). Never set in .dev.vars or a deployed wrangler.jsonc.
const testModeBindings = {
  LUMENIZE_MESH_TEST_MODE: 'true',
};

export default defineConfig({
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
    // Vitest 4 counts unhandled promise rejections as errors and fails the run with exit 1,
    // even when all tests pass. Our tests intentionally provoke errors in background tasks
    // (e.g., testing guard rejections, cleanup disconnects) that surface as unhandled rejections
    // after the test has already completed. Vitest 3 silently ignored these; vitest 4 doesn't.
    // Revisit later: proper fix is to await all cleanup promises in the tests.
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: [
        '**/src/**',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/*.config.*',
        '**/scratch/**',
        '**/test/**/*.test.ts'
      ],
      skipFull: false,
      all: false,
    },
    // Multi-project configuration
    projects: [
      {
        // Main tests - use root wrangler.jsonc
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'main',
          include: [
            'test/**/*.test.ts',
            'src/ocan/test/**/*.test.ts',
            'test/for-docs/lumenize-do/**/*.test.ts',
            'test/for-docs/alarms/basic-usage.test.ts'
          ],
          exclude: [
            'test/for-docs/getting-started/**/*.test.ts',
            'test/for-docs/calls/**/*.test.ts',
            'test/for-docs/alarms/index.test.ts',
            'test/for-docs/security/**/*.test.ts'
          ],
        },
      },
      {
        // Getting started e2e tests - uses its own test harness
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/for-docs/getting-started/test/wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'getting-started',
          include: ['test/for-docs/getting-started/**/*.test.ts'],
        },
      },
      {
        // Calls pattern e2e tests - uses its own test harness
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/for-docs/calls/test/wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'calls',
          include: ['test/for-docs/calls/**/*.test.ts'],
        },
      },
      {
        // Alarms e2e tests - uses its own test harness
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/for-docs/alarms/test/wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'alarms',
          include: ['test/for-docs/alarms/index.test.ts'],
        },
      },
      {
        // Security e2e tests - uses its own test harness
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/for-docs/security/test/wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'security',
          include: ['test/for-docs/security/**/*.test.ts'],
        },
      },
    ],
  },
});
