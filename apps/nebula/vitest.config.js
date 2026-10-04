import { defineConfig } from 'vitest/config';
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { playwright } from '@vitest/browser-playwright';
import swc from 'unplugin-swc';
import { installLocalhostLookup } from './harness/lib/localhost-lookup';

// Every `*.lumenize.localhost` host resolves to loopback for this Node process, as it does on macOS
// and in Chromium: global setup, the vite proxy and the chromium lane's server reach the local
// stack's hosts by name (harness/lib/localhost-lookup.ts). Test files run in worker processes this
// never reaches, so the Node projects that dial those hosts install it again from a setup file.
installLocalhostLookup();

// SWC transforms TC39 stage 3 decorators (esbuild can't). See packages/mesh/vitest.config.js.
const swcPlugin = swc.vite({
  // Coverage loads a file no test imports under an id carrying a query
  // (`?cache=…&vitest-uncovered-coverage=true`), which a bare extension filter misses: istanbul
  // then parsed raw TypeScript and failed the coverage job. The second pattern admits that pass only.
  include: [/\.tsx?$/, /\.tsx?\?.*\bvitest-uncovered-coverage\b/],
  exclude: [/node_modules/],
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorVersion: '2022-03' },
    target: 'es2022',
  },
});

export default defineConfig({
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
              // Explicitly EMPTY (wins over .dev.vars): holds Turnstile OFF for this lane on any
              // checkout — checkTurnstile no longer skips on NEBULA_AUTH_TEST_MODE.
              TURNSTILE_SECRET_KEY: '',
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
              // Explicitly EMPTY (wins over .dev.vars): holds Turnstile OFF for this lane on any
              // checkout — checkTurnstile no longer skips on NEBULA_AUTH_TEST_MODE.
              TURNSTILE_SECRET_KEY: '',
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
          setupFiles: ['./test/localhost-lookup-setup.ts'],
          // Above two email waiters back to back (`provisionStarAdmin` sends the owner's mail, then the
          // Star admin's, each waited on for 60 s), so a slow send reports as "No email received"
          // from its waiter rather than a bare test timeout. `testing.md` § E2E with external services.
          testTimeout: 150000,
          env: {
            NODE_TLS_REJECT_UNAUTHORIZED: '0',
          },
        },
      },
      // Chromium project — real-browser (vitest-browser + Playwright). The v4
      // production-shape harness: runs the @lumenize/nebula/frontend factory +
      // Vue in real chromium against a real wrangler-dev Star. The test page sits
      // on a Star's host and is signed in as that Star's admin; global-setup.ts
      // says how, and why each test's context starts from its cookies. Catches
      // browser-bundle regressions (a transitive cloudflare:workers /
      // node:async_hooks import in /frontend fails Vite resolution) and
      // real-browser divergence the jsdom `frontend` project can't see (IME
      // composition, focus/blur timing, paint scheduling, real WS reconnect).
      // global-setup spawns its OWN wrangler-dev (separate --persist-to) and
      // Studio's vite in front of it. Distinct from the Node-side `browser`
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
            // The page's host spells `PAGE_STAR` (test/chromium/page-star.ts). A named host reads
            // as network-exposed to vitest, which then turns off write and exec; `*.localhost` is
            // loopback, so they stay on.
            api: { host: 'tenant-a.crm.acme.lumenize.localhost', allowWrite: true, allowExec: true },
            // The signed-in browser's cookies, written by global-setup before any page opens.
            provider: playwright({
              // The same wildcard Node takes above, for the browser, as `launchChromium` passes it.
              launchOptions: { args: ['--host-resolver-rules=MAP *.lumenize.localhost 127.0.0.1, MAP lumenize.localhost 127.0.0.1'] },
              contextOptions: { storageState: './test/chromium/.wrangler/storage-state.json' },
            }),
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
          setupFiles: ['./test/localhost-lookup-setup.ts'],
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
          setupFiles: ['./test/localhost-lookup-setup.ts'],
          testTimeout: 60000,
          env: {
            NODE_TLS_REJECT_UNAUTHORIZED: '0',
          },
        },
      },
    ],
  },
});
