import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Dev server tuned to run behind the lifecycle-DO proxy (Q2).
export default defineConfig({
  plugins: [vue()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // The proxied request carries the edge origin's Host header; vite blocks unknown
    // hosts by default. Open it for the spike (a real deploy would allowlist the origin).
    allowedHosts: true,
    // HMR over the DO proxy: by default the client connects a WS to the page origin,
    // which the DO forwards to this server. If that fails, Q2 will pin clientPort/path here.
    hmr: {
      // path: "/__vite_hmr",
      // clientPort: 8787,
    },
  },
});
