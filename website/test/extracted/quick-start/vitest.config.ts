import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersProject({
  test: {
    globals: true,
    testTimeout: 5000,
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: {
          configPath: './wrangler.jsonc',
        },
      },
    },
  },
});
