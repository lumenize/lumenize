/**
 * Bundle the TypeScript compiler for cross-platform use.
 *
 * Uses --platform=neutral + alias stubs for node:os and node:inspector
 * (the two Node builtins typescript imports that don't exist in Workers).
 * Other node builtins (fs, path, crypto, perf_hooks) are either available
 * in workerd or guarded by runtime checks in typescript.
 *
 * Output: dist/typescript.bundled.mjs (gitignored, generated via postinstall)
 */

import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(__dirname, '../dist/typescript.bundled.mjs');

await build({
  entryPoints: [fileURLToPath(import.meta.resolve('typescript'))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  minify: true,
  outfile,
  alias: {
    'os': resolve(__dirname, 'stubs/os.mjs'),
    'node:os': resolve(__dirname, 'stubs/os.mjs'),
    'inspector': resolve(__dirname, 'stubs/inspector.mjs'),
    'node:inspector': resolve(__dirname, 'stubs/inspector.mjs'),
  },
});

const stats = readFileSync(outfile);
const sizeMB = (stats.length / (1024 * 1024)).toFixed(1);
console.log(`Bundled typescript → ${outfile} (${sizeMB} MB)`);
