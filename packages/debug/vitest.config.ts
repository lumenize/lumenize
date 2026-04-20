import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['src/**'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  },
});
