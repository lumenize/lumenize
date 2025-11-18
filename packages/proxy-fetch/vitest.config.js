import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersProject({
  test: {
    globals: true,
    testTimeout: 2000, // 2 second timeout
    include: ['test/**/*.test.ts'],
    exclude: ['test/wip/**/*.test.ts'], // WIP tests have separate config
    poolOptions: {
      workers: {
        isolatedStorage: false, // Required for WebSocket support
        wrangler: { configPath: './test/wrangler.jsonc' },
      },
    },
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      skipFull: false,
    },
  },
});
