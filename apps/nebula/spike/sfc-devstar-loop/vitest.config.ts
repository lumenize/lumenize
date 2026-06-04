import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'kill-criterion',
          include: ['test/**/*.test.ts'],
          testTimeout: 30000,
        },
      },
    ],
  },
});
