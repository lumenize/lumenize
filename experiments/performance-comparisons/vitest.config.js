import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000, // Longer timeout for performance measurements
    hookTimeout: 10000,
  },
});
