import { defineConfig } from 'vitest/config';
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { playwright } from '@vitest/browser-playwright';
import swc from 'unplugin-swc';

// SWC transforms TC39 stage 3 decorators (esbuild can't). See packages/mesh/vitest.config.js.
const swcPlugin = swc.vite({
  include: [/\.tsx?$/],
  exclude: [/node_modules/],
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorVersion: '2022-03' },
    target: 'es2022',
  },
});

/**
 * Vite plugin that proxies `${prefix}/*` requests (HTTP + WebSocket) to an
 * upstream resolved per-request from `process.env[envVar]`. Copied verbatim
 * from `packages/mesh/vitest.config.js` — see that file's doc-comment and
 * `packages/mesh/test/browser/README.md` for the full rationale.
 *
 * Used by the real-chromium `chromium` project so the test page (served by
 * vite-browser) and the wrangler-dev worker share an origin: NebulaAuth's
 * `Secure; SameSite=Strict` refresh-token cookie then flows untouched, with no
 * CORS plumbing and no cert handling in chromium (the proxy terminates TLS
 * server-side with `secure: false`). The wrangler-dev URL is injected by
 * `test/chromium/global-setup.ts` after spawn and read here on every request.
 */
function dynamicEnvProxyPlugin({
  prefix = '/worker',
  envVar = 'WRANGLER_PROXY_TARGET',
  approvedOrigin,
  // When false, forward the path verbatim instead of stripping `prefix`. Used by
  // the self-hosted-assets Phase-1 preview proxy: `Star.onRequest` injects an
  // absolute `<base href="/dev-star/{instance}/">` (it can't know a proxy
  // prefix), so the iframe must reach the worker at that exact path — a
  // path-preserving `/dev-star` proxy, not the `/worker`-stripping one. The
  // static preview GET is ungated, so it needs none of the cookie/origin plumbing.
  strip = true,
} = {}) {
  const stripPrefix = (path) => (strip ? path.replace(new RegExp(`^${prefix}`), '') || '/' : path);
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
        // NebulaAuth enforces an `LUMENIZE_APPROVED_ORIGINS` allow-list. The
        // browser stamps the test page's (dynamic-port) Origin on every POST,
        // even same-origin, and the proxy forwards it — so present an approved
        // Origin instead. CORS is meaningless in this proxied same-origin
        // setup; this just satisfies the server-side allow-list. Test-only.
        if (approvedOrigin) proxyReq.setHeader('origin', approvedOrigin);
      });
      // NebulaAuth sets a PATH-SCOPED refresh cookie (`Path=/auth/{scope}`,
      // unlike @lumenize/auth's `Path=/`). The worker sees the prefix-stripped
      // path, so it sets `Path=/auth/{scope}` — which no longer matches the
      // browser's proxied `${prefix}/auth/{scope}/...` request, so the cookie
      // would never be sent back and refresh-token 401s. Re-prepend the prefix
      // to the cookie Path (preserving the scope) so it rides the proxied
      // requests. Test-only; mesh's harness needs none of this (Path=/).
      proxy.on('proxyRes', (proxyRes) => {
        const setCookie = proxyRes.headers['set-cookie'];
        if (setCookie) {
          proxyRes.headers['set-cookie'] = setCookie.map((c) =>
            c.replace(/(;\s*Path=)\//i, `$1${prefix}/`),
          );
        }
      });
      proxy.on('error', (err, _req, res) => {
        if (res && 'writeHead' in res && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Proxy error: ${err.message}`);
        }
      });
      // http-proxy doesn't attach error handlers to upstream sockets; raw
      // socket errors (peer reset, etc.) become unhandled 'error' events that
      // crash Node. Swallow them here.
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
        // proxyReq doesn't fire for WS — strip the prefix + rewrite Origin here.
        req.url = stripPrefix(req.url);
        if (approvedOrigin) req.headers.origin = approvedOrigin;
        socket.on('error', () => { /* ignore — peer closed or reset */ });
        proxy.ws(req, socket, head, { target });
      });
    },
  };
}

export default defineConfig({
  // Same-origin proxy for the real-chromium `chromium` project (inert for the
  // pool-workers/jsdom projects — it only adds a vite dev-server middleware).
  // `approvedOrigin` rewrites the forwarded Origin to a value in the test
  // worker's LUMENIZE_APPROVED_ORIGINS (http://localhost:5173) so NebulaAuth's
  // origin allow-list passes regardless of vitest-browser's dynamic port.
  plugins: [
    dynamicEnvProxyPlugin({
      prefix: '/worker',
      envVar: 'WRANGLER_PROXY_TARGET',
      approvedOrigin: 'http://localhost:5173',
    }),
    // Path-preserving proxy so the self-hosted-assets Phase-1 chromium test can
    // load a DevStar-served preview same-origin at the exact path its injected
    // `<base href="/dev-star/{instance}/">` expects (see `strip` above).
    // `approvedOrigin` rewrites the forwarded Origin to one in the worker's
    // LUMENIZE_APPROVED_ORIGINS — module-script / dynamic-import requests carry an
    // Origin header (the dynamic vitest-browser port, NOT same as the proxied
    // worker host), which the entrypoint's CORS allowlist would otherwise 403.
    dynamicEnvProxyPlugin({
      prefix: '/dev-star',
      envVar: 'WRANGLER_PROXY_TARGET',
      strip: false,
      approvedOrigin: 'http://localhost:5173',
    }),
  ],
  test: {
    testTimeout: 10000,
    globals: true,
    dangerouslyIgnoreUnhandledErrors: true,
    // CPU-constrained-lane serialization. The `browser` project's real-WS e2e (an external
    // `wrangler dev` + WebSocket round-trips — magic-link auth, multi-client Gateway fan-out,
    // round-trip latency) is broadly wall-clock-sensitive: run concurrently with the CPU-bound
    // pool-workers projects on the hosted sandbox's shared 4 vCPUs, *some* of them get starved
    // past their timeout every run (which one varies — the "isolation flips the result"
    // signature in testing.md). Empirically this is NOT localized to one test, so run files
    // serially when the hosted plaintext lane flag (LUMENIZE_NO_CF_REMOTE) is set, so no two
    // compete for cores. Gate on the explicit lane flag, NOT CPU count — the sandbox is also
    // 4 cores, indistinguishable from a GHA runner by count. UNSET in GHA (4-vCPU runner +
    // `--retry 2` already passes) and local (fast), so their timing is untouched: the spread is
    // empty there. (A process env var the lane sets, not a `.dev.vars` secret — see testing.md.)
    // `retry: 2` mirrors CI's `test-code.sh --retry 2`: even SERIAL, an occasional real-WS e2e
    // (e.g. multi-client's 8 concurrent Gateway handshakes) exceeds its timeout on pure sandbox
    // variance, so retry catches the residual flake that serialization can't. The `npm test`
    // default carries no retry (local/GHA are fast); this adds it only for the constrained lane.
    ...(process.env.LUMENIZE_NO_CF_REMOTE ? { fileParallelism: false, retry: 2 } : {}),
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['**/src/**'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.config.*',
        '**/test/**/*.test.ts',
        // The baked DevContainer image source (vite app skeleton — .vue/.ts) runs
        // INSIDE the container, not under vitest; the istanbul instrumenter can't parse
        // its SFCs. It's deploy-gated, not Worker `src`. Exclude it from coverage.
        '**/container/**',
      ],
      skipFull: false,
      all: false,
    },
    projects: [
      {
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/wrangler.jsonc' },
          miniflare: {
            bindings: {
              NEBULA_AUTH_TEST_MODE: 'true',
              NEBULA_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
              DEBUG: 'nebula',
            },
          },
        })],
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/test-apps/**', 'test/browser/**', 'test/chromium/**', 'test/frontend/**', 'test/ui-smoke/**'],
        },
      },
      // Frontend project — the @lumenize/nebula/frontend layer (factory + the
      // ported pure-helper/engine suites: text-merge, deep-equals, debounce,
      // conflict-outcome). jsdom env (NOT vitest-pool-workers) so Vue can mount
      // components for the v3/v4 component probes; pure-logic tests run fine in
      // jsdom too. swc for the @mesh() decorators NebulaClient carries.
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['test/frontend/**/*.test.ts'],
          testTimeout: 10000,
        },
      },
      {
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/test-apps/baseline/test/wrangler.jsonc' },
          miniflare: {
            bindings: {
              NEBULA_AUTH_TEST_MODE: 'true',
              NEBULA_AUTH_BOOTSTRAP_EMAIL: 'bootstrap-admin@example.com',
              DEBUG: 'nebula',
              // Phase 5.3.5: shorten the Gateway grace period so
              // drop-on-failed-fanout tests can observe ClientDisconnectedError
              // settle in well under a second. Production-safe (binding only
              // set here in test config).
              LUMENIZE_MESH_GRACE_PERIOD_MS: '100',
            },
          },
        })],
        test: {
          name: 'baseline',
          include: ['test/test-apps/baseline/**/*.test.ts'],
          setupFiles: ['./test/test-apps/baseline/test/setup.ts'],
          // Real-Star WS-connect e2e (esp. the createNebulaClient factory tests:
          // ready / logout / set-union) establish live WebSocket connections that
          // are CPU-contention-sensitive under the full `npm test` run (unit +
          // frontend + baseline + browser projects in parallel). 10s (vitest's
          // default) is tight under that combined load; 30s matches the spike's
          // phase-0b real-Star precedent. Fast tests are unaffected (a timeout
          // only bites when exceeded). vi.waitFor stays at the setup.ts 5s default.
          testTimeout: 30000,
        },
      },
      // Secrets-facet spike project (tasks/spike-outside-world-secrets.md Stage 2):
      // a minimal capability-broker DO that loads a throwaway facet via the
      // Worker Loader and injects a resolved secret through its custom env. Own
      // wrangler (LOADER binding + the SecretBrokerDO) so it doesn't touch the
      // baseline app. NEBULA_SECRETS_KEY is a test-only 32-byte AES key (bytes
      // 0..31, base64) in miniflare.bindings — never in wrangler vars (it's a
      // secret). Not in the `npm test` project list; run explicitly with
      // `npx vitest run --project secrets-facet`.
      {
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/test-apps/secrets-facet/test/wrangler.jsonc' },
          miniflare: {
            bindings: {
              NEBULA_SECRETS_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
            },
          },
        })],
        test: {
          name: 'secrets-facet',
          include: ['test/test-apps/secrets-facet/**/*.test.ts'],
        },
      },
      // Egress-choke spike project (tasks/spike-outside-world-outbound.md): a
      // facet loaded with an EgressBroker WorkerEntrypoint wired as its
      // globalOutbound, proving a bare fetch() is routed through the Nebula
      // choke point (allow-list + SSRF deny) with no bypass. Own wrangler
      // (LOADER + EgressProbeDO + the self-ref EGRESS service binding). Not in
      // `npm test`; run with `npx vitest run --project egress-choke`.
      {
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/test-apps/egress-choke/test/wrangler.jsonc' },
        })],
        test: {
          name: 'egress-choke',
          include: ['test/test-apps/egress-choke/**/*.test.ts'],
        },
      },
      // NebulaContainer (4th node type, Phase 3) — structural scope-isolation
      // guard verified against a harness that borrows NebulaContainer's real
      // prototype methods (NebulaContainer itself can't construct under
      // pool-workers; see tasks/nebula-devcontainer-node-type.md Phase 2/3).
      // Not in `npm test`; run with `npx vitest run --project container`.
      {
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/test-apps/container-node/test/wrangler.jsonc' },
        })],
        test: {
          name: 'container',
          include: ['test/test-apps/container-node/**/*.test.ts'],
        },
      },
      // DevStudio node (Phase 3.5b) — shell Workspace + isomorphic-git source-of-truth
      // + the cross-DO compile-and-apply to the .dev Star. DevStudio extends NebulaDO
      // (constructable under pool-workers, unlike DevContainer). Own wrangler
      // (DEV_STUDIO + STAR probe + LOADER). nodejs_compat for shell/isomorphic-git.
      {
        extends: true,
        plugins: [swcPlugin, cloudflareTest({
          wrangler: { configPath: './test/test-apps/dev-studio/test/wrangler.jsonc' },
        })],
        test: {
          name: 'dev-studio',
          include: ['test/test-apps/dev-studio/**/*.test.ts'],
        },
      },
      // Browser project — Node-side vitest tests using @lumenize/testing's
      // Browser class (cookie-aware fetch + CORS validation + WebSocket +
      // multi-tab Context with sessionStorage). Talks over the network to an
      // auto-spawned `wrangler dev` (real Worker isolate) for end-to-end tests
      // that need honest wall-clock timing.
      //
      // Why not vitest-browser/Playwright: vitest-browser runs tests inside an
      // iframe served from vitest's origin. Cross-origin cookies and CORS
      // pre-flight against wrangler-dev are awkward to thread through the
      // iframe. Browser solves both natively in Node and matches the
      // pattern already used in packages/auth/test/e2e-email/.
      //
      // NODE_TLS_REJECT_UNAUTHORIZED=0 accepts wrangler-dev's auto-generated
      // self-signed cert. Required because cookies marked `Secure` (which
      // NebulaAuth sets) won't be accepted over plain http even on localhost.
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'browser',
          include: ['test/browser/**/*.test.ts'],
          globalSetup: ['./test/browser/global-setup.ts'],
          testTimeout: 30000,
          env: {
            NODE_TLS_REJECT_UNAUTHORIZED: '0',
          },
        },
      },
      // Chromium project — real-browser (vitest-browser + Playwright). The v4
      // production-shape harness: runs the @lumenize/nebula/frontend factory +
      // Vue in real chromium against a real wrangler-dev Star, reached
      // same-origin via dynamicEnvProxyPlugin (so NebulaAuth's
      // Secure;SameSite=Strict cookie flows with no CORS/cert dance). Catches
      // browser-bundle regressions (a transitive cloudflare:workers /
      // node:async_hooks import in /frontend fails Vite resolution) and
      // real-browser divergence the jsdom `frontend` project can't see (IME
      // composition, focus/blur timing, paint scheduling, real WS reconnect).
      // global-setup spawns its OWN wrangler-dev (separate --persist-to) and
      // sets WRANGLER_PROXY_TARGET. Distinct from the Node-side `browser`
      // project above (which lives under test/browser/**). swc for the @mesh()
      // decorators NebulaClient carries.
      {
        extends: true,
        plugins: [swcPlugin],
        // Single Vue reactivity graph: the factory imports @vue/reactivity +
        // @vue/runtime-core directly while the Q1–Q5 harness loads the
        // compiler-included vue.esm-bundler build. Dedupe defends against Vite's
        // dep-optimizer forking the graph onto two copies (which would silently
        // no-op the Q3/Q4 effectScope auto-subscribe bridge). Not strictly
        // required under the current flat npm hoist (one copy of each @vue/*
        // already), but install-state-independent insurance.
        resolve: {
          dedupe: ['vue', '@vue/runtime-dom', '@vue/runtime-core', '@vue/reactivity'],
        },
        // Vue's esm-bundler build expects these compile-time feature flags to be
        // bundler-injected; define them to silence the runtime warning + get
        // correct tree-shaking. (The Q1–Q5 harness loads vue.esm-bundler.js.)
        define: {
          __VUE_OPTIONS_API__: 'true',
          __VUE_PROD_DEVTOOLS__: 'false',
          __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
        },
        test: {
          name: 'chromium',
          include: [
            'test/chromium/**/*.test.ts',
            // The 5 Vue spike probes (Q1–Q5) also run here, in REAL chromium —
            // same MockClient-backed probes the jsdom `frontend` project runs,
            // now exercising real DOM / events / effectScope disposal / paint.
            // The "port the 5 spike probes to the browser project" deliverable,
            // with zero duplication (jsdom remains their canonical home).
            'test/frontend/q[1-5]-*.test.ts',
          ],
          globalSetup: ['./test/chromium/global-setup.ts'],
          testTimeout: 30000,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      // UI-smoke project — raw Playwright (NOT @vitest/browser) drives the real
      // vite-served Studio under the model-A dev stack: a globalSetup boots
      // `wrangler dev` on the apps/nebula config (DEV_STUDIO/DEV_CONTAINER/AI +
      // Docker DevContainer) AND vite serving apps/nebula-studio-ui, same-origin via
      // the Studio's own vite proxy (no dynamic-env-proxy needed). describe.runIf
      // auto-skips when Docker/creds are absent. NOT in the `npm test` project
      // enumeration (real infra, slow, costs env.AI); run with
      // `npx vitest run --project ui-smoke`. Excluded from the `unit` catch-all above.
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'ui-smoke',
          include: ['test/ui-smoke/**/*.test.ts'],
          globalSetup: ['./test/ui-smoke/global-setup.ts'],
          testTimeout: 120000,
        },
      },
      // Bench project — *.benchmark.ts files using standard it()/expect()
      // (not vi.bench). Why it()-based: the latency bench needs per-call
      // hop decomposition (multiple metrics per iteration) and the
      // throughput bench needs a manual saturation ramp; vi.bench's API
      // measures one number per `bench()` block. it() also gives us
      // expect() for regression-test gating later.
      //
      // Run subset with positional filter:
      //   `npx vitest run --project browser-bench transactions`
      //   `npx vitest run --project browser-bench throughput`
      // or the full suite via `npm run bench:all`.
      //
      // Excluded from `npm test` via positive project enumeration in the
      // test script — these can take a long time and hit deployed
      // infrastructure.
      {
        extends: true,
        plugins: [swcPlugin],
        test: {
          name: 'browser-bench',
          include: ['test/browser/**/*.benchmark.ts'],
          globalSetup: ['./test/browser/global-setup.ts'],
          testTimeout: 60000,
          env: {
            NODE_TLS_REJECT_UNAUTHORIZED: '0',
          },
        },
      },
    ],
  },
});
