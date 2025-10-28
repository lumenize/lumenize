import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersProject({
  test: {
    globals: true,
    testTimeout: 10000,
    exclude: ['**/node_modules/**', '**/*.mjs'],
    poolOptions: {
      workers: {
        isolatedStorage: false, // Required for WebSocket support
        wrangler: { configPath: './test/do/wrangler.jsonc' },
      },
    },
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      skipFull: false,
      all: false,
    },
  },
});
