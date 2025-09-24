import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Use different pools based on folder structure (disabled for coverage)
    poolMatchGlobs: process.env.COVERAGE ? [] : [
      // Integration tests use workers pool
      ['**/test/integration/**/*.test.ts', '@cloudflare/vitest-pool-workers'],
      // Unit tests use default forks pool  
      ['**/test/unit/**/*.test.ts', 'forks']
    ],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
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
  },
});