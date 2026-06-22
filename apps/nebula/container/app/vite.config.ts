import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// The preview is served behind the DevContainer DO's fetch() proxy at a PER-INSTANCE
// path prefix — `/dev-container/{u}.{g}.dev/` (the entrypoint's direct-serve route).
// vite's `base` MUST match that prefix, or vite's root-absolute asset URLs
// (`/src/main.ts`, `/@vite/client`, `/node_modules/.vite/deps/*`) resolve at the ORIGIN
// ROOT — outside the prefix — and 404, so Vue never mounts (blank preview). The
// DevContainer DO injects `PREVIEW_BASE` as a container env var BEFORE the container
// starts (it knows the routed instance name); the command-server's vite child inherits
// it. Falls back to `/` when unset (e.g. a bare standalone vite). See Decision 12 /
// Flow 1d + tasks/nebula-dev-flows.md.
const base = process.env.PREVIEW_BASE || "/";

export default defineConfig({
  base,
  plugins: [vue(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // The proxied request carries the edge origin's Host header; vite blocks unknown
    // hosts by default. The DevContainer DO is the only ingress (port-stripped), so
    // opening this is safe — the trust boundary is the DO fetch(), not vite's host check.
    allowedHosts: true,
    // HMR through the DO fetch() proxy is the finicky bit: the browser hits the PUBLIC
    // origin (wrangler's port, e.g. :8787), not vite's 5173, so vite's HMR client needs
    // `clientPort`/`host`/`path` tuned to the public origin + the preview prefix — and a
    // misconfigured HMR WS just spams reconnect errors. FIRST CUT: disable HMR under the
    // prefix so the preview RENDERS cleanly (the actual fix is `base`); a source push
    // (`applyChanges`) then needs a manual refresh to show. Re-enable + tune as the
    // immediate follow-up once render is confirmed. Standalone (`base === '/'`) keeps
    // default HMR. See Decision 12 / Flow 1d.
    hmr: base === "/" ? {} : false,
  },
});
