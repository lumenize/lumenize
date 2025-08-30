import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    poolOptions: {
      workers: {
        isolatedStorage: false,  // Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.
        wrangler: { configPath: "./test/wrangler.jsonc" },
      },
    },
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'json', 'html'],
      include: ['**/src/**'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.config.ts'],
    },
  },
});
