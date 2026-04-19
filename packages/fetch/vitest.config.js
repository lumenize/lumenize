import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './test/wrangler.jsonc' },
  })],

  test: {
    globals: true,

    // 10 second timeout for external network calls
    testTimeout: 10000,

    include: ['test/**/*.test.ts'],

    // WIP tests have separate config
    exclude: ['test/wip/**/*.test.ts'],

    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['src/**'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      skipFull: false,
    }
  }
});
