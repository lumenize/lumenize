import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    testTimeout: 5000,
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: { configPath: './wrangler-map-set-test.jsonc' },
      },
    },
  },
});

