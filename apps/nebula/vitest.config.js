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
    ],
  },
});
