import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineConfig({
  test: {
    projects: [
      // Main integration tests
      defineWorkersProject({
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          exclude: ['test/for-docs/**'],
          testTimeout: 5000,
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              wrangler: { configPath: './wrangler.jsonc' },
            },
          },
        },
      }),
      // For-docs tests (pedagogical examples)
      defineWorkersProject({
        test: {
          name: 'for-docs',
          include: ['test/for-docs/**/*.test.ts'],
          testTimeout: 5000,
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,
              wrangler: { configPath: './test/for-docs/wrangler.jsonc' },
            },
          },
        },
      }),
    ],
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'json', 'html'],
      include: ['src/**'],
      exclude: ['**/test/**', '**/node_modules/**', '**/dist/**'],
      skipFull: false,
      all: false,
    },
  },
});

