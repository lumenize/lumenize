import { cloudflareTest } from "@cloudflare/vitest-plugin";

import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    // A throwaway webhook secret, so the tests can sign deliveries; the deployed Worker's is a secret.
    miniflare: { bindings: { RESEND_WEBHOOK_SECRET: 'whsec_' + btoa('email-test webhook test secret') } },
  })],

  test: {
    testTimeout: 5000,
    globals: true,
    dangerouslyIgnoreUnhandledErrors: true,
  }
});
