import { defineConfig } from 'vitest/config';

/**
 * Plain-Node vitest — deliberately NOT vitest-pool-workers.
 *
 * Every symbol in this package is a `crypto`-global wrapper with no Cloudflare surface, so
 * the Workers runtime would add nothing. Running under plain Node instead makes the suite
 * double as the **Node-safety proof**: if anything in the module graph ever reaches
 * `cloudflare:workers`, these tests stop loading. That is the property auth's old Node-safe
 * subpath existed to provide, and `@lumenize/mesh/client` now depends on structurally.
 *
 * Keys are generated in-test via `crypto.subtle.generateKey`, so there is no `.dev.vars`
 * dependency and no fixture key to rotate.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: true,
    testTimeout: 10000,
  },
});
