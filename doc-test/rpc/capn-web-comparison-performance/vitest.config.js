import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    testTimeout: 2000, // 2 second global timeout
    poolOptions: {
      workers: {
        // Must be false to use websockets. Have each test
        // reference a different DO instance to avoid state sharing.
        isolatedStorage: false,
        // Important! use the wrangler.jsonc in ./test
        wrangler: { configPath: "./wrangler.jsonc" },  
      },
    },
    // Use `vitest --run --coverage` to get test coverage report(s)
    coverage: {
      provider: "istanbul",  // Cannot use V8
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
