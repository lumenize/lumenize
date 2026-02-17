// Build a bundled version of @lumenize/mesh's LumenizeWorker for use in DWL modules dict.
// Marks cloudflare:workers as external since DWL runtime provides it.

import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';

const result = await build({
  entryPoints: ['../../packages/mesh/src/index.ts'],
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
  // Resolve node modules used by mesh dependencies
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  // Resolve monorepo package imports
  alias: {
    '@lumenize/mesh': '../../packages/mesh/src/index.ts',
    '@lumenize/routing': '../../packages/routing/src/index.ts',
    '@lumenize/structured-clone': '../../packages/structured-clone/src/index.ts',
    '@lumenize/debug': '../../packages/debug/src/index.ts',
    '@lumenize/auth': '../../packages/auth/src/index.ts',
  },
  // Tree-shake — only what LumenizeWorker needs
  treeShaking: true,
});

const bundledCode = result.outputFiles[0].text;
writeFileSync('mesh-bundle.js', bundledCode);
console.log(`Bundled mesh module: ${(bundledCode.length / 1024).toFixed(1)}KB`);
console.log(`First 200 chars:\n${bundledCode.slice(0, 200)}`);
