import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Dev server tuned to run behind the DevContainer DO's fetch() proxy.
// Tailwind v4 JIT (the @tailwindcss/vite plugin) + DaisyUI give minimal CSS +
// arbitrary utilities — the ~28× CSS win over the retired in-DO whole-DaisyUI bundle.
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // The proxied request carries the edge origin's Host header; vite blocks unknown
    // hosts by default. The DevContainer DO is the only ingress (port-stripped), so
    // opening this is safe — the trust boundary is the DO fetch(), not vite's host check.
    allowedHosts: true,
    hmr: {},
  },
});
