import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// pool-workers 0.18.x API: `cloudflareTest` is a PLUGIN (the old
// `defineWorkersConfig` + `/config` subpath is gone). configPath is relative
// to cwd (run vitest from this dir). Plain DO, no decorators → no swc plugin.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
});
