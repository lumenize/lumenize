import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import swc from 'unplugin-swc';

// SWC transforms the TC39 decorators `@mesh()` is, which Vite's default transform leaves in place.
// TypeScript only: a `.mjs` such as the validator's pre-bundled TypeScript compiler is no input for a
// TypeScript parser. The second pattern admits coverage's uncovered-file pass, whose ids carry a query.
const swcPlugin = swc.vite({
  include: [/\.tsx?$/, /\.tsx?\?.*\bvitest-uncovered-coverage\b/],
  exclude: [/node_modules/],
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorVersion: '2022-03' },
    target: 'es2022',
  },
});

export default defineConfig({
  plugins: [swcPlugin, cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      bindings: {
        // A longer grace period in Mesh's Client host, for CPU contention between test isolates.
        LUMENIZE_MESH_TEST_MODE: 'true',
        // Mesh's Registry hands each magic link back instead of mailing it, so a test's Clients log
        // in through the real routes without mail (ADR-009 rung 2).
        AUTH_TEST_MODE: 'true',
        // ⚠️ Explicitly EMPTY: bindings win over `.dev.vars`, so this holds Turnstile off on any
        // checkout, even one whose `.dev.vars` carries a real key.
        TURNSTILE_SECRET_KEY: '',
      },
    },
  })],
  test: {
    globals: true,
    testTimeout: 30000,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
    },
  },
});
