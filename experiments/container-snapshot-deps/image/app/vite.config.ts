import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import swc from "unplugin-swc";

// Same plugin set as apps/nebula/container/app/vite.config.ts, so a build from a restored
// tree execs every native binary Nebula's does: rolldown (vite 8), @swc/core (the
// decorator transform), and @tailwindcss/oxide + lightningcss (tailwind v4). A restored
// node_modules that cannot exec one of them fails here, which is the point.
export default defineConfig({
  base: "./",
  plugins: [
    swc.vite({
      include: /\.ts$/,
      exclude: [/[/\\]node_modules[/\\]/],
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { decoratorVersion: "2022-03" },
        target: "es2022",
      },
    }),
    vue(),
    tailwindcss(),
  ],
});
