import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    globals: true,
    dangerouslyIgnoreUnhandledErrors: true,
    projects: [
      {
        extends: true,
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'main',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
});
