import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./test/wrangler.jsonc" },
  })],

  test: {
    deps: {
      optimizer: {
        ssr: {
          include: [
            // ajv is CJS-only; @modelcontextprotocol/sdk does
            // `import { Ajv } from 'ajv'` (named ESM import).
            // Pre-bundling ajv is necessary but not sufficient — the
            // import originates from @modelcontextprotocol/sdk inside
            // workerd. export_commonjs_namespace compat flag tells
            // workerd to synthesize named exports from CJS modules.
            "ajv",
          ]
        }
      }
    },

    // 15s: the agent demos do several real WebSocket round-trips, which exceed a
    // 2s budget under CI contention on shared runners (fine locally).
    testTimeout: 15000,

    coverage: {
      provider: "istanbul",
      reporter: ['text', 'json', 'html'],
      include: ['**/src/**'],
      exclude: [
        '**/node_modules/**', 
        '**/dist/**', 
        '**/build/**', 
        '**/*.config.ts',
        '**/scratch/**'
      ],
    }
  }
});
