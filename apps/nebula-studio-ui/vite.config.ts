import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import swc from "unplugin-swc";

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

// Dev-server SPA fallback for `/studio/*` (the Studio surface post-collapse). Vite's built-in
// history fallback serves index.html only for extension-less paths, so a dotted scope
// (`/studio/u.g`) would 404. This mirrors the production Workers-Assets
// `single-page-application` fallback so the path-carried scope works in dev too
// (normal `npm run dev` + the ui-smoke harness). Dev-only; the real build uses Workers Assets.
const appSpaFallback = {
  name: "studio-spa-fallback",
  configureServer(server: import("vite").ViteDevServer) {
    return () => {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !/^\/studio(\/|$|\?)/.test(req.url)) return next();
        try {
          const { readFile } = await import("node:fs/promises");
          const { resolve } = await import("node:path");
          const html = await readFile(resolve(server.config.root, "index.html"), "utf-8");
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(req.url, html));
        } catch (e) {
          next(e);
        }
      });
    };
  },
};

// Standalone dev server for the Studio UI. Proxies the Nebula API paths to the
// `wrangler dev` Worker (default :8787) so the UI is SAME-ORIGIN with /auth, /gateway,
// /app (the Galaxy-served built app the preview iframe loads) — required for the refresh
// cookie (SameSite=Strict) and the mesh WebSocket. Run alongside `npm run dev` (the
// Worker). Override the worker URL
// with NEBULA_WORKER_URL if wrangler picked a different port. See README.md.
const WORKER = process.env.NEBULA_WORKER_URL || "http://localhost:8787";

// The auth SPA's navigations, served by vite in dev exactly as the Worker serves them in prod.
//
// ⚠️ **This MUST run BEFORE the proxy, which is why it is not written like `appSpaFallback`.**
// `/auth` is proxied to the Worker for the API, and returning a function from `configureServer`
// registers a POST middleware — after vite's internal ones, proxy included — so a post-hook would
// never see these paths. Registering directly makes it a PRE middleware, which gets first refusal;
// everything it does not match falls through to the proxy untouched.
//
// ⚠️ **Only GET navigations, and only the four screen paths.** `/auth/{scope}/home` is a screen and
// `/auth/{scope}/refresh-token` is an API call one segment away, so matching loosely here would
// swallow the API and break login in dev with a page of HTML where JSON belongs.
const AUTH_SCREEN_PATHS = /^\/auth\/(login|signup|emails)$|^\/auth\/[^/]+\/home$/;
const authAppRoutes = {
  name: "auth-app-routes",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "GET" || !AUTH_SCREEN_PATHS.test(path)) return next();
      try {
        const { readFile } = await import("node:fs/promises");
        const { resolve } = await import("node:path");
        const html = await readFile(resolve(server.config.root, "auth-app.html"), "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url!, html));
      } catch (e) {
        next(e);
      }
    });
  },
};

export default defineConfig({
  plugins: [vue(), swcPlugin, tailwindcss(), appSpaFallback, authAppRoutes],
  // TWO entries, one dist. Studio's `index.html` is served by the assets layer directly; the auth
  // app's `auth-app.html` is fetched through the ASSETS binding by nebula-auth's router, because
  // `/auth/*` is in `run_worker_first` and so never reaches the assets layer on its own.
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        "auth-app": "auth-app.html",
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
    proxy: {
      "/auth": { target: WORKER, changeOrigin: true },
      "/gateway": { target: WORKER, changeOrigin: true, ws: true },
      "/app": { target: WORKER, changeOrigin: true },
    },
  },
});
