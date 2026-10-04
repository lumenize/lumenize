import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({
    isolatedStorage: false,
    wrangler: { configPath: './test/wrangler.jsonc' },
  })],
  test: {
    testTimeout: 2000,
    globals: true,
  },
});
