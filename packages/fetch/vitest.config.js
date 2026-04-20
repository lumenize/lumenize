import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    // SWC transforms TC39 stage 3 decorators (esbuild can't). See packages/mesh/vitest.config.js.
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorVersion: '2022-03' },
        target: 'es2022',
      },
    }),
    cloudflareTest({
      wrangler: { configPath: './test/wrangler.jsonc' },
    }),
  ],

  test: {
    globals: true,

    // 10 second timeout for external network calls
    testTimeout: 10000,

    include: ['test/**/*.test.ts'],

    // WIP tests have separate config
    exclude: ['test/wip/**/*.test.ts'],

    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['src/**'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      skipFull: false,
    }
  }
});
