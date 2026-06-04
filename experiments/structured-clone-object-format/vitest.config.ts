import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    benchmark: {
      include: ['test/**/*.bench.ts'],
    },
  },
});
