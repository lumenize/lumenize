import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false,  // Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            LUMENIZE_AUTH_TEST_MODE: 'true',
            LUMENIZE_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
          },
        },
      },
    },
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'html', 'lcov'],
      include: [
        '**/src/**',
        '**/test/test-worker-and-dos.ts'
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

