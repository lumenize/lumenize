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

// Dev-server SPA fallback for `/app/*`. Vite's built-in history fallback serves index.html only for
// extension-less paths, so a dotted scope (`/app/u.g.dev`) would 404. This mirrors the production
// Workers-Assets `single-page-application` fallback so the path-carried scope works in dev too
// (normal `npm run dev` + the ui-smoke harness). Dev-only; the real build uses Workers Assets.
const appSpaFallback = {
  name: "app-spa-fallback",
  configureServer(server: import("vite").ViteDevServer) {
    return () => {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !/^\/app(\/|$|\?)/.test(req.url)) return next();
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
// /dev-container — required for the refresh cookie (SameSite=Strict) and the mesh +
// preview WebSockets. Run alongside `npm run dev` (the Worker). Override the worker URL
// with NEBULA_WORKER_URL if wrangler picked a different port. See README.md.
const WORKER = process.env.NEBULA_WORKER_URL || "http://localhost:8787";

export default defineConfig({
  plugins: [vue(), swcPlugin, tailwindcss(), appSpaFallback],
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
      "/dev-container": { target: WORKER, changeOrigin: true, ws: true },
    },
  },
});
