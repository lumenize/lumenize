import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineConfig({
  test: {
    projects: [
      // DO Variant tests - Workers environment
      defineWorkersProject({
        test: {
          name: 'do',
          globals: true,
          testTimeout: 10000,
          include: ['test/do/**/*.test.ts'],
          poolOptions: {
            workers: {
              isolatedStorage: false, // Required for WebSocket support
              wrangler: { configPath: './test/do/wrangler.jsonc' },
            },
          },
        },
      }),
      // Queue Variant tests - Workers environment
      defineWorkersProject({
        test: {
          name: 'queue',
          globals: true,
          testTimeout: 10000,
          include: ['test/queue/**/*.test.ts'],
          poolOptions: {
            workers: {
              isolatedStorage: false, // Required for WebSocket support
              wrangler: { configPath: './test/queue/wrangler.jsonc' },
            },
          },
        },
      }),
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      include: ['src/**'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      skipFull: false,
      all: false,
    },
  },
});
