// TEMP config for running structured-clone tests in cowork (Linux sandbox
// where the host-installed darwin-arm64 workerd binary can't run). Does
// not replace vitest.config.js — Mac users should keep using that.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/format-experiments.test.ts',
      'test/**/*-browser.test.ts',
    ],
    globals: true,
    testTimeout: 5000,
  },
});
