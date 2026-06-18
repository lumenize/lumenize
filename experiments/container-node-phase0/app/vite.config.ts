import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Dev server tuned to run behind the lifecycle-DO proxy (Q2).
// Tailwind v4 JIT (the @tailwindcss/vite plugin) gives minimal CSS + arbitrary utilities (Q3).
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // The proxied request carries the edge origin's Host header; vite blocks unknown
    // hosts by default. Open it for the spike (a real deploy would allowlist the origin).
    allowedHosts: true,
    hmr: {},
  },
});
