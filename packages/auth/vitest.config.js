import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false,  // Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.
      },
    },
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
        test: {
          name: 'main',
          include: ['test/**/*.test.ts'],
          exclude: [
            'test/e2e-email/**/*.test.ts',
            'test/e2e-email-resend/**/*.test.ts',
            'test/hono/**/*.test.ts',
          ],
          poolOptions: {
            workers: {
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                bindings: {
                  LUMENIZE_AUTH_TEST_MODE: 'true',
                  LUMENIZE_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
                  DEBUG: 'auth',
                },
              },
            },
          },
        },
      },
      {
        // E2E email test via Cloudflare Email Sending — the default path.
        // Real sends + real Email Routing — no test mode.
        // groupOrder 1: runs after main tests, serialized with resend/hono to
        // avoid race on shared EmailTestDO (all listen for test@lumenize.io).
        extends: true,
        test: {
          name: 'e2e-email',
          testTimeout: 30000, // 30s — real email delivery can take 10-15s
          sequence: { groupOrder: 1 },
          include: ['test/e2e-email/**/*.test.ts'],
          poolOptions: {
            workers: {
              wrangler: { configPath: './test/e2e-email/wrangler.jsonc' },
              miniflare: {
                bindings: {
                  DEBUG: 'auth',
                },
              },
            },
          },
        },
      },
      {
        // E2E email test via ResendEmailSender — smoke test keeping the
        // Resend path exercised alongside the default Cloudflare path.
        // groupOrder 2: runs after e2e-email to avoid shared EmailTestDO race.
        extends: true,
        test: {
          name: 'e2e-email-resend',
          testTimeout: 30000,
          sequence: { groupOrder: 2 },
          include: ['test/e2e-email-resend/**/*.test.ts'],
          poolOptions: {
            workers: {
              wrangler: { configPath: './test/e2e-email-resend/wrangler.jsonc' },
              miniflare: {
                bindings: {
                  DEBUG: 'auth',
                },
              },
            },
          },
        },
      },
      {
        // Hono integration test (real Cloudflare Email Sending — no test mode)
        // groupOrder 3: runs last to avoid shared EmailTestDO race.
        extends: true,
        test: {
          name: 'hono',
          testTimeout: 30000,
          sequence: { groupOrder: 3 },
          include: ['test/hono/**/*.test.ts'],
          poolOptions: {
            workers: {
              wrangler: { configPath: './test/hono/wrangler.jsonc' },
              miniflare: {
                bindings: {
                  LUMENIZE_AUTH_BOOTSTRAP_EMAIL: 'test@lumenize.io',
                  DEBUG: 'auth',
                },
              },
            },
          },
        },
      },
    ],
  },
});
