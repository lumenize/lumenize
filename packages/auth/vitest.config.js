import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { generateKeyPairSync } from "node:crypto";

// Ephemeral Ed25519 JWT keypairs, generated fresh each run and injected as
// miniflare bindings (which take precedence over .dev.vars). The auth suites
// otherwise read these keys only from the gitignored .dev.vars, so they
// couldn't run in a secret-less environment (CI, cloud agents). Two independent
// keypairs (BLUE/GREEN) so key-rotation paths work; PRIMARY_JWT_KEY (in
// wrangler.jsonc) selects the signer and both public keys are tried on verify.
function ed25519TestKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    public: publicKey.export({ type: "spki", format: "pem" }),
    private: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}
const blueKey = ed25519TestKeyPair();
const greenKey = ed25519TestKeyPair();
const JWT_TEST_KEYS = {
  JWT_PUBLIC_KEY_BLUE: blueKey.public,
  JWT_PRIVATE_KEY_BLUE: blueKey.private,
  JWT_PUBLIC_KEY_GREEN: greenKey.public,
  JWT_PRIVATE_KEY_GREEN: greenKey.private,
};

// --- Opt-out gating for the secret-less lane (tasks/lumenize-email.md Phase 1) ---
// e2e-email + hono declare a `send_email` binding with `remote: true`, which
// vitest-pool-workers establishes at POOL LOAD — with no Cloudflare creds the
// whole project fails to load (0 tests run), so path-level it.skipIf can't help.
// Omit them at the PROJECT level when the lane has no CF creds. Signal = the
// OPT-OUT flag LUMENIZE_NO_CF_REMOTE, set ONLY by the secret-less Claude-hosted
// lane; local (`wrangler login` OAuth) and CI (CLOUDFLARE_API_TOKEN job env) leave
// it unset, so the CF canary runs there. e2e-email-resend has no remote binding and
// its secrets live in .dev.vars (not process.env), so it stays unconditional.
const includeCfRemote = !process.env.LUMENIZE_NO_CF_REMOTE;

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
              ...JWT_TEST_KEYS,
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
      ...(includeCfRemote ? [{
        // E2E email test via Cloudflare Email Sending — the default path.
        // Real sends + real Email Routing — no test mode.
        // groupOrder 1: runs after main tests, serialized with resend/hono to
        // avoid race on shared EmailTestDO (all listen for test@lumenize.io).
        // Omitted when LUMENIZE_NO_CF_REMOTE is set (no Cloudflare remote-proxy creds).
        extends: true,
        plugins: [cloudflareTest({
          isolatedStorage: false,
          wrangler: { configPath: './test/e2e-email/wrangler.jsonc' },
          miniflare: {
            bindings: {
              ...JWT_TEST_KEYS,
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
      }] : []),
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
              ...JWT_TEST_KEYS,
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
      ...(includeCfRemote ? [{
        // Hono integration test (real Cloudflare Email Sending — no test mode)
        // groupOrder 3: runs last to avoid shared EmailTestDO race.
        // Omitted when LUMENIZE_NO_CF_REMOTE is set (no Cloudflare remote-proxy creds).
        extends: true,
        plugins: [cloudflareTest({
          isolatedStorage: false,
          wrangler: { configPath: './test/hono/wrangler.jsonc' },
          miniflare: {
            bindings: {
              ...JWT_TEST_KEYS,
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
      }] : []),
    ],
  },
});
