import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import swc from "unplugin-swc";

// SWC transforms the imported @lumenize/* TS. esbuild (vite's default) does NOT support
// the TC39 stage-3 decorators `@mesh()` uses — it silently breaks private-field refs in
// decorated classes ("Private field '#x' must be declared in an enclosing class"). Same
// config as packages/mesh/vitest.config.js. https://github.com/evanw/esbuild/issues/104
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
  // Keep the DECORATED @lumenize source out of vite's esbuild dep-prebundle so the SWC
  // plugin above transforms it as source — otherwise esbuild mangles the @mesh decorators
  // before SWC ever sees them (the blank-screen / private-field SyntaxError).
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
