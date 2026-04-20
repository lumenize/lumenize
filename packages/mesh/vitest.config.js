import { defineConfig } from 'vitest/config';
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
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
        plugins: [cloudflareTest({
          wrangler: { configPath: './wrangler.jsonc' },
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
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/for-docs/getting-started/test/wrangler.jsonc' },
        })],
        test: {
          name: 'getting-started',
          include: ['test/for-docs/getting-started/**/*.test.ts'],
        },
      },
      {
        // Calls pattern e2e tests - uses its own test harness
        extends: true,
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/for-docs/calls/test/wrangler.jsonc' },
        })],
        test: {
          name: 'calls',
          include: ['test/for-docs/calls/**/*.test.ts'],
        },
      },
      {
        // Alarms e2e tests - uses its own test harness
        extends: true,
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/for-docs/alarms/test/wrangler.jsonc' },
        })],
        test: {
          name: 'alarms',
          include: ['test/for-docs/alarms/index.test.ts'],
        },
      },
      {
        // Security e2e tests - uses its own test harness
        extends: true,
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/for-docs/security/test/wrangler.jsonc' },
        })],
        test: {
          name: 'security',
          include: ['test/for-docs/security/**/*.test.ts'],
        },
      },
    ],
  },
});
