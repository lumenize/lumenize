import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import swc from 'unplugin-swc';
import { resolve as resolvePath } from 'node:path';

// Stubs originally lived under test/browser/stubs (Alpine spike); archived
// to test/_alpine-archive/stubs while Phase 1 Vue probes are built. Once
// Phase 1 lands, move the still-used stubs into test/vue/stubs (or shared
// location) and delete the archive.
const STUBS_DIR = resolvePath(import.meta.dirname, './test/_alpine-archive/stubs');

// SWC transforms TC39 stage 3 decorators (esbuild can't). Required for
// `@mesh()` decorators on NebulaClient's handler methods.
const swcPlugin = swc.vite({
  include: [/\.tsx?$/],
  exclude: [/node_modules/],
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorVersion: '2022-03' },
    target: 'es2022',
  },
});

export default defineConfig({
  test: {
    globals: true,
    projects: [
      // Phase 0a — factory mechanics with mock client, plus the pre-v3
      // isolation-detour suites (pure helpers + cores per
      // tasks/nebula-frontend.md § Pre-v3 isolation detours). Plain Node mode.
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'phase-0a',
          include: [
            'test/factory-basics.test.ts',
            'test/text-merge.test.ts',
            'test/deep-equals.test.ts',
            'test/debounce-queue.test.ts',
            'test/collection-sync.test.ts',
            'test/conflict-outcome.test.ts',
          ],
        },
      },
      // Phase 0b — end-to-end against real Star DO via vitest-pool-workers.
      {
        extends: true,
        plugins: [
          swcPlugin,
          cloudflareTest({
            wrangler: { configPath: './test/wrangler.jsonc' },
            miniflare: {
              bindings: {
                NEBULA_AUTH_TEST_MODE: 'true',
                NEBULA_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
              },
            },
          }),
        ],
        test: {
          name: 'phase-0b',
          include: ['test/e2e/**/*.test.ts'],
          setupFiles: ['./test/setup.ts'],
          testTimeout: 30000,
        },
      },
      // Phase 1 — Vue in-DOM probes in Node + jsdom against wrangler-dev.
      // Uses `Browser` from @lumenize/testing for auth/cookie/WS (Node-side
      // shim, no real browser → no CORS, no bundler issues). jsdom gives us
      // a DOM for Vue to bind to.
      //
      // jsdom is a constraint (NebulaClient + mesh can't bundle for a real
      // browser yet — see task file vue-in-dom-spike.md "Why strict jsdom"
      // + Phase -1 § 7 + § 8), NOT a preference. Fixing is post-spike work.
      {
        extends: true,
        plugins: [swcPlugin],
        resolve: {
          alias: {
            // `@lumenize/debug` does `await import('cloudflare:workers')` in
            // a try/catch. Runtime is fine (catch swallows in Node) but
            // vite's import-analysis fails ahead of time. Stub. See task
            // file Phase -1 § 7 for the proper fix-in-debug-package.
            'cloudflare:workers': resolvePath(STUBS_DIR, 'cloudflare-workers.ts'),
          },
        },
        test: {
          name: 'phase-1',
          include: ['test/vue/**/*.test.ts'],
          globalSetup: ['./test/vue/global-setup.ts'],
          environment: 'jsdom',
          testTimeout: 30000,
          server: {
            deps: {
              // Force workspace packages through the plugin chain (incl.
              // SWC) so their `import type` statements get stripped before
              // vite's import-analysis tries to resolve them.
              inline: [/^@lumenize\//],
            },
          },
        },
      },
    ],
  },
});
