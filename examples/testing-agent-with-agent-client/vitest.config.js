import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    deps: {
      optimizer: {
        ssr: {
          include: [
            // vitest can't seem to properly import
            // `require('./path/to/anything.json')` files,
            // which ajv uses (by way of @modelcontextprotocol/sdk)
            // the workaround is to add the package to the include list
            "ajv"
          ]
        }
      }
    },
    testTimeout: 2000, // 2 second global timeout
    poolOptions: {
      workers: {
        isolatedStorage: false,  // Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.
        wrangler: { configPath: "./test/wrangler.jsonc" },
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
