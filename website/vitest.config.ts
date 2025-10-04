import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

// Simple vitest config for website-level tests
// Each extracted workspace has its own wrangler.jsonc and src/index.ts
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
        // Vitest will automatically discover wrangler.jsonc and main from each workspace
      },
    },
  },
});
