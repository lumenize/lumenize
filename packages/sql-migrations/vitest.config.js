import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    projects: [
      // Cloudflare Workers environment — the runner needs a real DO ctx.storage
      {
        plugins: [cloudflareTest({
          wrangler: { configPath: './wrangler.jsonc' },
        })],
        test: {
          name: 'workers',
          include: ['test/**/*.test.ts'],
          globals: true,
          testTimeout: 5000,
        },
      },
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
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
  },
});
