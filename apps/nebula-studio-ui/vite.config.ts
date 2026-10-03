import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import swc from "unplugin-swc";
import { parseHost, type HostTarget } from "@lumenize/nebula-auth/claims";

// SWC transforms the imported @lumenize/* TS, which carries the TC39 stage-3 decorators
// `@mesh()` uses. This plugin is REQUIRED, not an optimization.
//
// ⚠️ The original reason recorded here was esbuild's lack of decorator support
// (esbuild#104). That went stale in May 2024 — esbuild shipped decorators in 0.21.0 and
// handles this fine as of 0.25.x. The plugin is still required for a DIFFERENT reason:
// vite 8 bundles with ROLLDOWN/oxc, which does NOT transform stage-3 decorators. It emits
// them verbatim AND THE BUILD EXITS 0, so the artifact only fails when a browser parses
// it — a blank screen from a SyntaxError, with a green build.
//
// ⚠️ Verify with `node --check dist/assets/*.js`, NOT by grepping for `@mesh`:
// minification renames the decorator (`@mesh()` -> `@Ka()`), so a grep finds nothing and
// reads as a pass. Measured cost of this plugin: ~16 ms/build.
//
// The @lumenize/* packages resolve through WORKSPACE SYMLINKS to apps/nebula/src/**, i.e.
// outside node_modules — which is why swc's default node_modules-exclude does not skip
// them here and no `exclude` override is needed (the container scaffold, where the
// frontend is a real vendored dependency, does need one).
const swcPlugin = swc.vite({
  jsc: {
    parser: { syntax: "typescript", decorators: true },
    transform: { decoratorVersion: "2022-03" },
    target: "es2022",
  },
});

// Standalone dev server for the Studio UI. Proxies the paths the Worker answers to `wrangler dev`
// (default :8787), so a page on any `*.lumenize.localhost` host reaches its routes on that same host
// — required for the mesh WebSocket and for the platform host's cookies. Run alongside `npm run dev`
// (the Worker). Override the worker URL with NEBULA_WORKER_URL if wrangler picked a different port.
// See README.md.
const WORKER = process.env.NEBULA_WORKER_URL || "http://localhost:8787";

// The deployment the dev server stands in for: every host is read against it, exactly as the Worker
// reads its own (`@lumenize/nebula-auth`'s `parseHost`), so vite and the Worker agree on which page a
// host is. A local stack's origin, unless the harness names another.
const DEPLOYMENT = process.env.LUMENIZE_ORIGIN || "http://lumenize.localhost";

/** What a dev request's host is — the shared parse, so vite never decides differently from the Worker. */
function hostOf(req: { headers: { host?: string } }): HostTarget | null {
  return req.headers.host ? parseHost(req.headers.host, DEPLOYMENT) : null;
}

/** Whether a host serves its galaxy's built app, which only the Worker can answer. */
const isAppHost = (t: HostTarget | null) =>
  (t?.kind === "scope" && t.scope.split(".").length === 3) || t?.kind === "persona";

/**
 * Serve one of the two HTML entries, as the Worker's page step does: transformed, and unframeable.
 * ⚠️ Every import it needs is static: the `runner` config loader closes its module runner once the
 * config has loaded, so a dynamic `import()` here fails on the first request.
 */
async function sendEntry(server: import("vite").ViteDevServer, res: import("node:http").ServerResponse, url: string, entry: string) {
  const html = await readFile(resolve(server.config.root, entry), "utf-8");
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.end(await server.transformIndexHtml(url, html));
}

// Every page carries the deployment's origin, which its client reads to spell the platform host and
// every scope's host. The Worker injects the same meta into the pages it serves; in a build, the
// Worker's injection is the only one.
const lumenizeOriginMeta = {
  name: "lumenize-origin-meta",
  apply: "serve" as const,
  transformIndexHtml() {
    return [{ tag: "meta", attrs: { name: "lumenize-origin", content: DEPLOYMENT }, injectTo: "head-prepend" as const }];
  },
};

// Studio, for a universe or galaxy host: a NAVIGATION (`Accept: text/html`) nothing else claimed
// gets `index.html`, mirroring the Worker's page step. A POST middleware, so a real asset and a
// proxied path are already served before it runs. ⚠️ It mirrors the Worker for those hosts only: a
// navigation to the platform host outside the auth screens, or to a host the parse refuses, falls
// through to vite's own HTML fallback, which serves Studio's `index.html` where the Worker answers 404.
const appSpaFallback = {
  name: "studio-spa-fallback",
  configureServer(server: import("vite").ViteDevServer) {
    return () => {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== "GET" || !req.headers.accept?.includes("text/html")) return next();
        const host = hostOf(req);
        // A Star's or persona's host never arrives here: the catch-all proxy below sends it to the
        // Worker first. That proxy's `bypass` is the parse that decides which host gets which page.
        if (host?.kind !== "scope") return next();
        try { await sendEntry(server, res, req.url ?? "/", "index.html"); } catch (e) { next(e); }
      });
    };
  },
};

// The auth app's pages on the platform host — Home at `/`, and the screens under `/auth/` — served by
// vite in dev as the Worker serves them in prod, the link page among them, so a link a local stack
// mails is served by vite as sent.
//
// ⚠️ **A PRE middleware, which is why it is not written like `appSpaFallback`.** `/auth` is proxied
// to the Worker for the API, so a post-hook would never see these paths. Only GET, and only these
// paths: `/auth/magic-link` is a page on GET and the consume on POST.
const AUTH_SCREEN_PATHS = /^\/$|^\/auth\/(login|signup|emails|magic-link|logout)$/;
const authAppRoutes = {
  name: "auth-app-routes",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "GET" || hostOf(req)?.kind !== "platform" || !AUTH_SCREEN_PATHS.test(path)) return next();
      try { await sendEntry(server, res, req.url!, "auth-app.html"); } catch (e) { next(e); }
    });
  },
};

export default defineConfig({
  plugins: [vue(), swcPlugin, tailwindcss(), lumenizeOriginMeta, appSpaFallback, authAppRoutes],
  // TWO entries, one dist. The Worker's page step serves Studio's `index.html` on a universe or
  // galaxy host, and nebula-auth's router serves `auth-app.html` on the platform host, each fetched
  // through the ASSETS binding, since the Worker runs first on every path.
  build: {
    rollupOptions: {
      input: {
        // ⚠️ Absolute, resolved from THIS file. Relative entry names resolve against the process
        // cwd, and the harness boots vite from the repo root — where the dep scanner then fails to
        // resolve them and skips pre-bundling with a warning that reads like a broken config.
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        "auth-app": fileURLToPath(new URL("./auth-app.html", import.meta.url)),
      },
    },
  },
  // Keep the DECORATED @lumenize source out of vite's dep-prebundle so the SWC plugin
  // above transforms it as source. The prebundler is rolldown/oxc under vite 8 (it was
  // esbuild under vite 6) — the package changed, the hazard did not: neither transforms
  // stage-3 decorators, so without this the prebundle wins the race and SWC never sees
  // them. Dev-server-only knob; the production build is covered by the plugin itself.
  optimizeDeps: { exclude: ["@lumenize/nebula", "@lumenize/mesh"] },
  server: {
    port: 5174,
    strictPort: true,
    // ⚠️ `changeOrigin: false` is load-bearing. The Worker reads the browser's REAL `Host` to decide
    // which page a host is and which scope a refresh is for, and builds every emailed link's port
    // from it; `changeOrigin: true` would rewrite it to the proxy target. wrangler dev passes `Host`
    // through. (Its sibling fix: `apps/nebula/scripts/local-config.mjs` strips `routes`, which would
    // otherwise make wrangler present the PRODUCTION host.)
    // ⚠️ ORDER IS LOAD-BEARING: vite tries the rows in order, and a `bypass` that returns a URL ends
    // the proxy step altogether rather than falling to the next row — so the catch-all goes last.
    proxy: {
      "/auth": { target: WORKER, changeOrigin: false },
      "/gateway": { target: WORKER, changeOrigin: false, ws: true },
      "/pictures": { target: WORKER, changeOrigin: false },
      "/_version": { target: WORKER, changeOrigin: false },
      // A Star's or persona's host is the built app, which only the Worker serves — every method,
      // so a limb probing a Durable Object's surface reaches the Worker — and the apex is the
      // Worker's redirect to the platform host. Every other host skips the proxy to vite's own pages.
      "^/.*": {
        target: WORKER, changeOrigin: false, ws: true,
        bypass: (req) => {
          const host = hostOf(req);
          return isAppHost(host) || host?.kind === "apex" ? undefined : req.url;
        },
      },
    },
  },
});
