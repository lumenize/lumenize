import { defineConfig } from 'vitest/config';
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    projects: [
      // Unit tests - Node environment
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      // Integration tests - Workers environment
      {
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/integration/wrangler.jsonc' },
        })],
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 2000,
          globals: true,
        },
      },
    ],
    coverage: {
      provider: 'istanbul',
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
  },
});
