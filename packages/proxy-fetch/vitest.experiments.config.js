import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersProject({
  test: {
    testTimeout: 10000, // Longer timeout for experiments
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: { configPath: './test/experiments/wrangler.jsonc' },
      },
    },
  },
});
