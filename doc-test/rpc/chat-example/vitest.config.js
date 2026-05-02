import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
  })],

  test: {
    // 2 second global timeout
    testTimeout: 2000,

    // Use `vitest --run --coverage` to get test coverage report(s)
    coverage: {
      provider: "istanbul",  // Cannot use V8
      reporter: ['text', 'json', 'html'],
      include: ['**/src/**'],
      exclude: [
        '**/node_modules/**', 
        '**/dist/**', 
        '**/build/**', 
        '**/*.config.ts',
        '**/scratch/**'
      ],
    }
  }
});

