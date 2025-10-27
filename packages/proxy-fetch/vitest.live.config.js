import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000, // Longer timeout for live tests with real network calls
    globals: true,
    include: ['test/live.test.ts'],
  },
});
