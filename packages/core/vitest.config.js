import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
    include: ['sql/test/**/*.test.ts', 'debug/test/**/*.test.ts', 'call-raw/test/**/*.test.ts'],
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
        'sql/index.ts',
        'debug/index.ts',
        'debug/logger.ts',
        'debug/pattern-matcher.ts',
        'call-raw/index.ts'
      ],
      exclude: [
        '**/test/**',
        '**/node_modules/**', 
        '**/dist/**', 
        '**/build/**', 
        '**/*.config.*',
        '**/scratch/**'
      ],
      skipFull: false,
      all: false,
    },
  },
});
