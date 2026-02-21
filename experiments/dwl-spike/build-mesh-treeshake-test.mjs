// Compare bundle sizes: full @lumenize/mesh vs LumenizeWorker-only entrypoint
// Run: node build-mesh-treeshake-test.mjs

import { build } from 'esbuild';

const COMMON_OPTIONS = {
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'esnext',
  write: false,
  external: [
    'cloudflare:workers',
    'cloudflare:test',
    'node:async_hooks',
  ],
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  alias: {
    '@lumenize/mesh': '../../packages/mesh/src/index.ts',
    '@lumenize/routing': '../../packages/routing/src/index.ts',
    '@lumenize/structured-clone': '../../packages/structured-clone/src/index.ts',
    '@lumenize/debug': '../../packages/debug/src/index.ts',
    '@lumenize/auth': '../../packages/auth/src/index.ts',
  },
  treeShaking: true,
};

// Build 1: Full @lumenize/mesh (current approach)
const fullBuild = await build({
  ...COMMON_OPTIONS,
  entryPoints: ['../../packages/mesh/src/index.ts'],
});

// Build 2: LumenizeWorker-only entrypoint
const workerOnlyBuild = await build({
  ...COMMON_OPTIONS,
  stdin: {
    contents: `
      export { LumenizeWorker } from '@lumenize/mesh';
      export { mesh, meshFn, isMeshCallable, getMeshGuard, MESH_CALLABLE, MESH_GUARD } from '@lumenize/mesh';
    `,
    resolveDir: '../../packages/mesh/src',
    loader: 'ts',
  },
});

// Build 3: Minified version of worker-only (realistic production size)
const workerOnlyMinified = await build({
  ...COMMON_OPTIONS,
  stdin: {
    contents: `
      export { LumenizeWorker } from '@lumenize/mesh';
      export { mesh, meshFn, isMeshCallable, getMeshGuard, MESH_CALLABLE, MESH_GUARD } from '@lumenize/mesh';
    `,
    resolveDir: '../../packages/mesh/src',
    loader: 'ts',
  },
  minify: true,
});

// Build 4: Minified full build for comparison
const fullMinified = await build({
  ...COMMON_OPTIONS,
  entryPoints: ['../../packages/mesh/src/index.ts'],
  minify: true,
});

const fullSize = fullBuild.outputFiles[0].text.length;
const workerSize = workerOnlyBuild.outputFiles[0].text.length;
const workerMinSize = workerOnlyMinified.outputFiles[0].text.length;
const fullMinSize = fullMinified.outputFiles[0].text.length;

console.log('=== DWL Mesh Bundle Size Comparison ===\n');
console.log(`Full @lumenize/mesh:       ${(fullSize / 1024).toFixed(1)}KB`);
console.log(`LumenizeWorker-only:       ${(workerSize / 1024).toFixed(1)}KB  (${((1 - workerSize/fullSize) * 100).toFixed(0)}% smaller)`);
console.log(`Full (minified):           ${(fullMinSize / 1024).toFixed(1)}KB`);
console.log(`Worker-only (minified):    ${(workerMinSize / 1024).toFixed(1)}KB  (${((1 - workerMinSize/fullMinSize) * 100).toFixed(0)}% smaller)`);
console.log(`\nReduction: ${(fullSize / 1024).toFixed(1)}KB → ${(workerSize / 1024).toFixed(1)}KB (saved ${((fullSize - workerSize) / 1024).toFixed(1)}KB)`);
console.log(`Minified:  ${(fullMinSize / 1024).toFixed(1)}KB → ${(workerMinSize / 1024).toFixed(1)}KB (saved ${((fullMinSize - workerMinSize) / 1024).toFixed(1)}KB)`);
