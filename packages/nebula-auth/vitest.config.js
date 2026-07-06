import { defineConfig } from 'vitest/config';
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    testTimeout: 5000,
    globals: true,
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: [
        '**/src/**',
        '**/test/test-worker-and-dos.ts'
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
    projects: [
      {
        // Main tests (test mode — no real email)
        extends: true,
        plugins: [cloudflareTest({
          wrangler: { configPath: './test/wrangler.jsonc' },
          miniflare: {
            bindings: {
              NEBULA_AUTH_TEST_MODE: 'true',
              // Comma-separated bootstrap-admin list. The first entry keeps every existing
              // single-email test green (still a member); the second — with a LEADING SPACE and
              // MIXED CASE — exercises the getter's per-element trim+lowercase (nebula-auth-bootstrap-array
              // .test.ts). A raw `String.includes` on this joined value, or a scalar index-0 getter,
              // reds those array tests. (miniflare.bindings is the sanctioned home — never a prod config.)
              NEBULA_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com, Second-Bootstrap@Example.com',
              DEBUG: 'nebula-auth',
            },
          },
        })],
        test: {
          name: 'main',
          include: ['test/**/*.test.ts'],
          exclude: ['test/e2e-email/**/*.test.ts'],
        },
      },
    ],
  },
});
