import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
    include: ['test/**/*.test.ts', 'src/ocan/test/**/*.test.ts'],
    poolOptions: {
      workers: {
        isolatedStorage: false,  // Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'html', 'lcov'],
      include: [
        'src/lumenize-base.ts',
        'src/nadis-plugin.ts',
        'src/ocan/**/*.ts',
        'test/test-worker-and-dos.ts'
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

