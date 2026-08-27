import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import swc from "unplugin-swc";

// vite 8 bundles with ROLLDOWN (Rust), not rollup+esbuild — which is why the build is
// 4-5.8x faster once a user-developer adds real libraries (measured: `echarts` 11.5-15.5s
// -> 2.8s; four heavy libs 18.5s -> 3.4s. experiments/computer-vfs-build/RESULTS.md).
//
// ⚠️ BUT rolldown/oxc does NOT transform TC39 stage-3 decorators. It emits them VERBATIM
// and THE BUILD STILL EXITS 0 — the artifact only fails when a browser parses it. The
// generated app reaches decorators through `./nebula` -> `@lumenize/nebula/frontend` ->
// NebulaClient, whose mesh-callable methods carry `@mesh()`. So this plugin is REQUIRED,
// not an optimization; without it the preview silently ships a SyntaxError.
//
// ⚠️⚠️ `exclude` defaults to /node_modules/, and the vendored frontend IS a dependency —
// so the default would skip exactly the code that needs transforming, silently, at exit 0.
// That is why the default is overridden below. Do not "simplify" this away.
const swcDecorators = swc.vite({
  include: /\.ts$/,
  // Transform our own source AND the vendored @lumenize frontend; leave every other
  // dependency on the fast path (they carry no decorators).
  exclude: [/[/\\]node_modules[/\\](?!@lumenize[/\\])/],
  jsc: {
    parser: { syntax: "typescript", decorators: true },
    transform: { decoratorVersion: "2022-03" },
    target: "es2022",
  },
});

// NO baked path prefix — `base: './'` emits RELATIVE asset URLs, and the Galaxy's
// serve injects `<base href="/app/{u}.{g}.{s}/">` into index.html as it serves it, so
// relative URLs resolve against the prefix the document was ACTUALLY served from. One
// build is valid at any mount prefix (the published one-copy serve, a future custom
// domain's `/`) — a baked prefix and the injection would fight. Neither half works
// alone: vite's default `/` emits root-absolute URLs that fall to Studio's Assets
// bucket and SPA-fallback into a silent white screen, and a bare `'./'` breaks on
// deep links without the injected <base> (a shared `/invoices/42` resolves assets
// against the document path). There is deliberately NO server block: this scaffold is
// only ever `vite build` in the ephemeral build box — no dev server, no HMR.
export default defineConfig({
  base: "./",
  plugins: [swcDecorators, vue(), tailwindcss()],
});
