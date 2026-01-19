import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false,  // Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.
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
    // Multi-project configuration
    projects: [
      {
        // Main tests - use root wrangler.jsonc
        extends: true,
        test: {
          name: 'main',
          include: [
            'test/**/*.test.ts',
            'src/ocan/test/**/*.test.ts',
            'test/for-docs/lumenize-do/**/*.test.ts'
          ],
          exclude: [
            'test/for-docs/mesh/**/*.test.ts'
          ],
          poolOptions: {
            workers: {
              wrangler: { configPath: './wrangler.jsonc' },
            },
          },
        },
      },
      {
        // Getting started / mesh e2e tests - use separate wrangler.jsonc
        extends: true,
        test: {
          name: 'mesh-e2e',
          include: ['test/for-docs/mesh/**/*.test.ts'],
          poolOptions: {
            workers: {
              wrangler: { configPath: './test/for-docs/mesh/wrangler.jsonc' },
            },
          },
        },
      },
    ],
  },
});
