import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineConfig({
  test: {
    projects: [
      // Worker Variant tests - DO-Worker Hybrid
      defineWorkersProject({
        test: {
          name: 'worker',
          globals: true,
          testTimeout: 15000, // Longer for latency measurements
          include: ['test/worker/**/*.test.ts'],
          fileParallelism: false, // Required: tests share orchestrator singleton
          poolOptions: {
            workers: {
              isolatedStorage: false, // Required for WebSocket support
              wrangler: { configPath: './test/worker/wrangler.jsonc' },
            },
          },
        },
      }),
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      skipFull: false,
      all: false,
    },
  },
});
