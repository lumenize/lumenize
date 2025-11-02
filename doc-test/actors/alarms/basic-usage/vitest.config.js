import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    testTimeout: 5000, // 5 second global timeout (longer for alarm delays)
    poolOptions: {
      workers: {
        // Must be false to use websockets
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },  
      },
    },
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'json', 'html'],
      include: ['**/src/**'],
      exclude: [
        '**/node_modules/**', 
        '**/dist/**', 
        '**/build/**', 
        '**/*.config.ts',
        '**/scratch/**'
      ],
    },
  },
});

