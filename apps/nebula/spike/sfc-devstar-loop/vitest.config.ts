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
      {
        // Node project: the SFC→ESM transpile/assembly pipeline uses `typescript`,
        // which crashes the workerd isolate (see src/compile-module.ts), so it runs
        // in Node here. No cloudflare plugin → default (Node) environment.
        extends: true,
        test: {
          name: 'compile-module',
          include: ['test-node/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
