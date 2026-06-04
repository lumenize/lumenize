import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'html', 'lcov'],
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
        // Existing unit/integration tests (test mode — no real email)
        extends: true,
        plugins: [cloudflareTest({
          isolatedStorage: false, // websocket tests need shared DO state across tests
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: {
              LUMENIZE_AUTH_TEST_MODE: 'true',
              LUMENIZE_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
              DEBUG: 'auth',
            },
          },
        })],
        test: {
          name: 'main',
          include: ['test/**/*.test.ts'],
          exclude: [
            'test/e2e-email/**/*.test.ts',
            'test/e2e-email-resend/**/*.test.ts',
            'test/hono/**/*.test.ts',
          ],
        },
      },
      {
        // E2E email test via Cloudflare Email Sending — the default path.
        // Real sends + real Email Routing — no test mode.
        // groupOrder 1: runs after main tests, serialized with resend/hono to
        // avoid race on shared EmailTestDO (all listen for test@lumenize.io).
        extends: true,
        plugins: [cloudflareTest({
          isolatedStorage: false,
          wrangler: { configPath: './test/e2e-email/wrangler.jsonc' },
          miniflare: {
            bindings: {
              DEBUG: 'auth',
            },
          },
        })],
        test: {
          name: 'e2e-email',
          testTimeout: 30000, // 30s — real email delivery can take 10-15s
          sequence: { groupOrder: 1 },
          include: ['test/e2e-email/**/*.test.ts'],
        },
      },
      {
        // E2E email test via ResendEmailSender — smoke test keeping the
        // Resend path exercised alongside the default Cloudflare path.
        // groupOrder 2: runs after e2e-email to avoid shared EmailTestDO race.
        extends: true,
        plugins: [cloudflareTest({
          isolatedStorage: false,
          wrangler: { configPath: './test/e2e-email-resend/wrangler.jsonc' },
          miniflare: {
            bindings: {
              DEBUG: 'auth',
            },
          },
        })],
        test: {
          name: 'e2e-email-resend',
          // 60s, double e2e-email — Resend's HTTPS hop adds delivery jitter on
          // top of the in-process Cloudflare Email Sending path. Not a code
          // race: the magic-link write is synchronous + DO output-gated before
          // the 200 OK, so a real-user click can't race the commit. The bump
          // is cushion for Resend variability on cold-start sequential runs.
          testTimeout: 60000,
          sequence: { groupOrder: 2 },
          include: ['test/e2e-email-resend/**/*.test.ts'],
        },
      },
      {
        // Hono integration test (real Cloudflare Email Sending — no test mode)
        // groupOrder 3: runs last to avoid shared EmailTestDO race.
        extends: true,
        plugins: [cloudflareTest({
          isolatedStorage: false,
          wrangler: { configPath: './test/hono/wrangler.jsonc' },
          miniflare: {
            bindings: {
              LUMENIZE_AUTH_BOOTSTRAP_EMAIL: 'test@lumenize.io',
              DEBUG: 'auth',
            },
          },
        })],
        test: {
          name: 'hono',
          testTimeout: 30000,
          sequence: { groupOrder: 3 },
          include: ['test/hono/**/*.test.ts'],
        },
      },
    ],
  },
});
