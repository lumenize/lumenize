import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
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
    testTimeout: 2000, // 2 second global timeout
    poolOptions: {
      workers: {
        isolatedStorage: false,  // Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.
        wrangler: { configPath: "./test/wrangler.jsonc" },  // Important! use the wrangler.jsonc in ./test
      },
    },
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
    },
  },
});
