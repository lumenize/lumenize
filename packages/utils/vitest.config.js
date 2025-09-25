import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'json', 'html'],
      include: ['**/src/**'],
      exclude: [
        '**/node_modules/**', 
        '**/dist/**', 
        '**/build/**', 
        '**/*.config.ts',
        '**/scratch/**'
      ],
    },
  },
  coverage: {
    provider: "istanbul",
    reporter: ['text', 'json', 'html'],
    include: [
      '**/src/**',
      '**/test/example-do.ts'
    ],
    exclude: [
      '**/node_modules/**', 
      '**/dist/**', 
      '**/build/**', 
      '**/*.config.*',
      '**/scratch/**',
      '**/test/**/*.test.ts'
    ],
    skipFull: false,
    all: false,
  },
});
