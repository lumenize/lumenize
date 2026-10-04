import { cloudflareTest } from "@cloudflare/vitest-plugin";

import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
  })],

  test: {
    testTimeout: 5000,
    globals: true,
    dangerouslyIgnoreUnhandledErrors: true,
  }
});
