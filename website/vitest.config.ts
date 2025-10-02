import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

// Simple vitest config for website-level tests
// Each extracted workspace has its own wrangler.jsonc that vitest will discover
export default defineWorkersProject({
  test: {
    globals: true,
    testTimeout: 5000,
    
    // Include all test files from extracted documentation workspaces
    include: ['test/extracted/**/test/**/*.test.ts'],
    
    poolOptions: {
      workers: {
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: '2025-09-12',
          compatibilityFlags: ['nodejs_compat'],
        },
        // Point to the worker entrypoint
        // For extracted tests, this will be the src/index.ts in each workspace
        // We'll need to configure this per-workspace, but for now use a generic pattern
        wrangler: {
          configPath: './test/extracted/quick-start/wrangler.jsonc',
        },
        main: './test/extracted/quick-start/src/index.ts',
      },
    },
  },
});
