import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    testTimeout: 5000, // 5 second global timeout (calls may take longer)
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false,  // Must be false for WebSocket support
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'json', 'html'],
      skipFull: false,
      all: false,
    },
  },
});

