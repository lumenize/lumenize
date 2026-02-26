import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    testTimeout: 5000,
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false, // Must be false for WebSocket tests
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
    projects: [
      {
        // Main tests (test mode — no real email)
        extends: true,
        test: {
          name: 'main',
          include: ['test/**/*.test.ts'],
          exclude: ['test/e2e-email/**/*.test.ts'],
          poolOptions: {
            workers: {
              wrangler: { configPath: './test/wrangler.jsonc' },
              miniflare: {
                bindings: {
                  NEBULA_AUTH_TEST_MODE: 'true',
                  NEBULA_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
                  DEBUG: 'nebula-auth',
                },
              },
            },
          },
        },
      },
    ],
  },
});
