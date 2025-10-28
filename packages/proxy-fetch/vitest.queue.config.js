import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersProject({
  test: {
    globals: true,
    testTimeout: 10000,
    include: ['test/queue/**/*.test.ts'],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: { configPath: './test/queue/wrangler.jsonc' },
      },
    },
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
