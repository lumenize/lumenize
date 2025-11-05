import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // Unit tests - Node environment
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/pattern-matcher.test.ts', 'test/logger.test.ts'],
          globals: true,
        },
      },
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      include: ['**/src/**'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/*.config.*',
        '**/test/**/*.test.ts',
      ],
      skipFull: false,
      all: false,
    },
  },
});

