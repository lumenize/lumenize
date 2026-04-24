import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 10000,
    globals: true,
    dangerouslyIgnoreUnhandledErrors: true,

    coverage: {
      provider: "istanbul",
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: [
        '**/src/**',
        '**/test/test-worker-and-dos.ts'
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

    projects: [
      {
        // Main tests — use root wrangler.jsonc (PrimaryDO for rpcParse-style tests)
        extends: true,
        plugins: [cloudflareTest({
          wrangler: { configPath: './wrangler.jsonc' },
        })],
        test: {
          name: 'main',
          include: ['test/**/*.test.ts'],
          exclude: ['test/for-docs/getting-started/**/*.test.ts'],
        },
      },
      {
        // Getting-started for-docs tests — use their own wrangler (SupervisorDO).
        // Doc's code blocks in getting-started.md match against this project's files.
        extends: true,
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/for-docs/getting-started/wrangler.jsonc' },
        })],
        test: {
          name: 'for-docs-getting-started',
          include: ['test/for-docs/getting-started/**/*.test.ts'],
        },
      },
    ],
  },
});
