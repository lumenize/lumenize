import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import swc from 'unplugin-swc';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// The factory under test lives in apps/nebula/src and would resolve `@vue/*` from the repo
// root (3.5.x). Alias every Vue entry to THIS experiment's 3.6 rc ESM bundler build, and
// inline them so vite (not Node) resolves their own imports — otherwise the factory and the
// components hold two reactivity instances and nothing tracks. @vue/runtime-vapor ships an
// ESM bundler build only, so inlining is required anyway.
const vueEsm = {
  vue: 'node_modules/vue/dist/vue.runtime.esm-bundler.js',
  '@vue/runtime-dom': 'node_modules/@vue/runtime-dom/dist/runtime-dom.esm-bundler.js',
  '@vue/runtime-core': 'node_modules/@vue/runtime-core/dist/runtime-core.esm-bundler.js',
  '@vue/runtime-vapor': 'node_modules/@vue/runtime-vapor/dist/runtime-vapor.esm-bundler.js',
  '@vue/reactivity': 'node_modules/@vue/reactivity/dist/reactivity.esm-bundler.js',
  '@vue/shared': 'node_modules/@vue/shared/dist/shared.esm-bundler.js',
};

// Same decorator transform the apps/nebula `frontend` project uses (NebulaClient carries @mesh()).
const swcPlugin = swc.vite({
  include: /\.ts$/,
  exclude: [/node_modules/],
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorVersion: '2022-03' },
    target: 'es2022',
  },
});

export default defineConfig({
  plugins: [swcPlugin, vue()],
  resolve: {
    alias: Object.entries(vueEsm).map(([find, p]) => ({
      find: new RegExp(`^${find.replace('/', '\\/')}$`),
      replacement: here(p),
    })),
  },
  test: {
    environment: 'jsdom',
    // The revisit repro FAILS by design while the bug it shows exists, so it runs on its own
    // (REVISIT=1, `npm run test:revisit`) rather than reddening the Vapor matrix.
    include: process.env.REVISIT === '1' ? ['test/computed-revisit.test.ts'] : ['test/**/*.test.ts'],
    exclude: process.env.REVISIT === '1' ? [] : ['test/computed-revisit.test.ts'],
    testTimeout: 10000,
    server: { deps: { inline: [/[\\/]node_modules[\\/](vue|@vue)[\\/]/] } },
  },
});
