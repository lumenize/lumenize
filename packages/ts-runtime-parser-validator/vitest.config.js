import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
  })],

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
    }
  }
});
