import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineConfig({
  test: {
    projects: [
      // Node.js environment - standard npm usage
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/format-experiments.test.ts'], // Run only when explicitly requested
          globals: true,
          testTimeout: 2000,
        },
      },
      // Cloudflare Workers environment - our primary use case
      defineWorkersProject({
        test: {
          name: 'workers',
          include: ['test/**/*.test.ts'],
          exclude: ['test/format-experiments.test.ts'], // Performance tests need accurate Node.js timing
          globals: true,
          testTimeout: 2000,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              wrangler: { configPath: './wrangler.jsonc' },
            },
          },
        },
      }),
      // Browser environment - headless browser testing
      {
        test: {
          name: 'browser',
          include: ['test/**/*.test.ts'],
          exclude: ['test/format-experiments.test.ts'], // Performance tests need accurate Node.js timing
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [
              { browser: 'chromium' },
            ],
          },
          globals: true,
          testTimeout: 5000,
        },
      },
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      include: ['**/src/**'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.config.*',
        '**/test/**/*.test.ts'
      ],
      skipFull: false,
      all: false,
    },
  },
});

