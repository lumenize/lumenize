import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['src/**'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          globals: true,
          include: ['test/**/*.test.ts'],
          exclude: ['test/workers/**/*.test.ts'],
        },
      },
      {
        plugins: [cloudflareTest({
          wrangler: { configPath: './wrangler.jsonc' },
        })],
        test: {
          name: 'workers',
          globals: true,
          include: ['test/workers/**/*.test.ts'],
        },
      },
    ],
  },
});
