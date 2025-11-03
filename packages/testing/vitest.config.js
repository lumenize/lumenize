import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false,  // Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.
        wrangler: { configPath: './test/wrangler.jsonc' },
      },
    },
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'json', 'html'],
      include: [
        '**/src/**',
        '**/test/test-harness.ts'
      ],
      exclude: [
        '**/node_modules/**', 
        '**/dist/**', 
        '**/build/**', 
        '**/*.config.*',
        '**/scratch/**',
        '**/test/**/*.test.ts'
      ],
      skipFull: false,
      all: false,
    },
  },
});
