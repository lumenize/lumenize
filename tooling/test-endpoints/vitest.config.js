import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    testTimeout: 2000,
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: { configPath: './test/wrangler.jsonc' },
      },
    },
  },
});

