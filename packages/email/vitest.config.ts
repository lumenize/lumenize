import { defineConfig } from 'vitest/config';

// Plain Node vitest — the transports take `env` as a param, so there is no
// workerd/pool-workers dependency (testing.md pure-function carve-out).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['src/**'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  },
});
