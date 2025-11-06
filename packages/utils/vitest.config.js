import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineConfig({
  test: {
    projects: [
      // Unit tests - Node environment
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
          setupFiles: ['./test/unit/setup.ts'],
        },
      },
      // Integration tests - Workers environment
      defineWorkersProject({
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 2000,
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,  // Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.
              wrangler: { configPath: './test/integration/wrangler.jsonc' },
            },
          },
        },
      }),
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['html', 'lcov'],
      include: [
        '**/src/**',
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
