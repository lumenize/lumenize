import { defineConfig } from 'vitest/config';
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { playwright } from '@vitest/browser-playwright';
import swc from 'unplugin-swc';

/**
 * Vite plugin that proxies `${prefix}/*` requests (both HTTP and WebSocket)
 * to an upstream URL resolved per-request from `process.env[envVar]`. The
 * upstream URL doesn't have to be known at plugin-init time — the env var
 * can be set later (e.g., by a vitest globalSetup that spawns the upstream).
 *
 * **Why this and not Vite's built-in `server.proxy`**: Vite's proxy only
 * accepts a static `target`. The `router` callback that http-proxy supports
 * for dynamic targets isn't passed through. So this plugin uses http-proxy
 * directly and reads the env var on every request.
 *
 * **HTTPS upstreams**: chromium never sees the upstream cert because all
 * proxying is server-side. `secure: false` makes http-proxy accept any
 * upstream cert (self-signed wrangler-dev, etc.) without further config.
 *
 * **Cookies**: because the test page and the proxied responses share the
 * test page's origin, `SameSite=Strict; Secure` cookies set by the upstream
 * flow normally — no rewriting needed. (`Secure` is accepted over
 * `http://localhost` per the Secure Contexts spec.)
 *
 * Copy this function (and the @vitest/browser-playwright config that uses
 * it) when adding real-browser tests to another `@lumenize/*` package.
 * See `packages/mesh/test/browser/README.md` for the rest of the checklist.
 *
 * @param prefix - URL path prefix to capture (default `/upstream`). Stripped
 *   before forwarding so the upstream sees its own URL space.
 * @param envVar - Name of the env var that holds the upstream base URL
 *   (default `UPSTREAM_PROXY_TARGET`). Set by globalSetup once the upstream
 *   is ready.
 */
function dynamicEnvProxyPlugin({
  prefix = '/upstream',
  envVar = 'UPSTREAM_PROXY_TARGET',
} = {}) {
  const stripPrefix = (path) => path.replace(new RegExp(`^${prefix}`), '') || '/';
  return {
    name: `dynamic-env-proxy:${prefix}`,
    async configureServer(server) {
      const httpProxy = (await import('http-proxy')).default;
      const proxy = httpProxy.createProxyServer({
        ws: true,
        changeOrigin: true,
        secure: false,
      });
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.path = stripPrefix(proxyReq.path);
      });
      proxy.on('error', (err, _req, res) => {
        if (res && 'writeHead' in res && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Proxy error: ${err.message}`);
        }
      });
      // http-proxy doesn't attach error handlers to upstream sockets; raw
      // socket errors (peer reset, etc.) become unhandled 'error' events
      // that crash the Node process. Swallow them here.
      proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
        socket.on('error', () => { /* ignore */ });
      });
      proxy.on('open', (socket) => {
        socket.on('error', () => { /* ignore */ });
      });
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next();
        const target = process.env[envVar];
        if (!target) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end(`Upstream not ready (${envVar} unset)`);
          return;
        }
        proxy.web(req, res, { target });
      });
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith(prefix)) return;
        const target = process.env[envVar];
        if (!target) {
          socket.destroy();
          return;
        }
        // proxyReq doesn't fire for WS — strip the prefix here.
        req.url = stripPrefix(req.url);
        socket.on('error', () => { /* ignore — peer closed or reset */ });
        proxy.ws(req, socket, head, { target });
      });
    },
  };
}

// SWC plugin to transform TS (including TC39 stage 3 decorators that esbuild doesn't support).
// Without this, `@mesh()` decorators survive Vite's default esbuild transform and V8 can't parse them.
// See: https://github.com/evanw/esbuild/issues/104
const swcPlugin = swc.vite({
  jsc: {
    parser: {
      syntax: 'typescript',
      decorators: true,
    },
    transform: {
      decoratorVersion: '2022-03',
    },
    target: 'es2022',
  },
});

// Bindings set on every project's miniflare instance. LUMENIZE_MESH_TEST_MODE
// enables test-only behavior in @lumenize/mesh source (currently: longer
// LumenizeClientGateway grace period to tolerate CPU contention from parallel
// miniflare workers). Never set in .dev.vars or a deployed wrangler.jsonc.
const testModeBindings = {
  LUMENIZE_MESH_TEST_MODE: 'true',
};

export default defineConfig({
  plugins: [
    dynamicEnvProxyPlugin({ prefix: '/worker', envVar: 'WRANGLER_PROXY_TARGET' }),
  ],
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
    // Vitest 4 counts unhandled promise rejections as errors and fails the run with exit 1,
    // even when all tests pass. Our tests intentionally provoke errors in background tasks
    // (e.g., testing guard rejections, cleanup disconnects) that surface as unhandled rejections
    // after the test has already completed. Vitest 3 silently ignored these; vitest 4 doesn't.
    // Revisit later: proper fix is to await all cleanup promises in the tests.
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: [
        '**/src/**',
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
    // Multi-project configuration
    projects: [
      {
        // Main tests - use root wrangler.jsonc
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'main',
          include: [
            'test/**/*.test.ts',
            'src/ocan/test/**/*.test.ts',
            'test/for-docs/lumenize-do/**/*.test.ts',
            'test/for-docs/alarms/basic-usage.test.ts'
          ],
          exclude: [
            'test/for-docs/getting-started/**/*.test.ts',
            'test/for-docs/calls/**/*.test.ts',
            'test/for-docs/alarms/index.test.ts',
            'test/for-docs/security/**/*.test.ts',
            'test/**/*-browser.test.ts', // Browser-only — run in the `browser` project
          ],
        },
      },
      {
        // Real-browser tests: bundles @lumenize/mesh/client through Vite +
        // Playwright (chromium). Catches client-side imports that work in
        // vitest-pool-workers but fail in a real browser bundle — e.g., the
        // `@lumenize/debug` regression where `await import('cloudflare:workers')`
        // bundled fine under vitest-pool-workers but vite refused to resolve
        // it. See tasks/playwright-test-template.md.
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'browser',
          include: ['test/**/*-browser.test.ts'],
          // global-setup spawns wrangler dev against the dedicated
          // test/browser/worker config so the WS round-trip test can hit a
          // real Worker. Bundle-only tests (lumenize-client-browser.test.ts)
          // don't use the URL it provides — they just ignore the inject.
          globalSetup: ['./test/browser/global-setup.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        // Getting started e2e tests - uses its own test harness
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/for-docs/getting-started/test/wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'getting-started',
          include: ['test/for-docs/getting-started/**/*.test.ts'],
        },
      },
      {
        // Calls pattern e2e tests - uses its own test harness
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/for-docs/calls/test/wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'calls',
          include: ['test/for-docs/calls/**/*.test.ts'],
        },
      },
      {
        // Alarms e2e tests - uses its own test harness
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/for-docs/alarms/test/wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'alarms',
          include: ['test/for-docs/alarms/index.test.ts'],
        },
      },
      {
        // Security e2e tests - uses its own test harness
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/for-docs/security/test/wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'security',
          include: ['test/for-docs/security/**/*.test.ts'],
        },
      },
      {
        // LumenizeContainer (4th node type) — isolated so a `containers`-block
        // config quirk can't perturb the main suite's record. See
        // tasks/nebula-devcontainer-node-type.md Phase 2.
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/container/wrangler.jsonc' },
          miniflare: { bindings: testModeBindings },
        })],
        test: {
          name: 'container',
          include: ['test/container/**/*.test.ts'],
        },
      },
    ],
  },
});
