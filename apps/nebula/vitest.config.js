import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    testTimeout: 10000,
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false,
      },
    },
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'html', 'lcov'],
      include: ['**/src/**'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.config.*',
        '**/test/**/*.test.ts',
      ],
      skipFull: false,
      all: false,
    },
    projects: [
      {
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
                  DEBUG: 'nebula',
                },
              },
            },
          },
        },
      },
    ],
  },
});
