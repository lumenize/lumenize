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
});
