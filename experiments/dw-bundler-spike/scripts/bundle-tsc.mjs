// Bundle the TypeScript compiler for use as:
//   1. DW module string (.bundle — text import)
//   2. In-process JS module (.mjs — direct import in Worker)
//
// The .mjs variant needs Node.js shims (os.platform, fs, path, etc.)
// because tsc calls os.platform() at module init time and esbuild's
// --platform=browser shims are incomplete.

import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '../dist');
mkdirSync(distDir, { recursive: true });

const tscEntry = resolve(__dirname, '../node_modules/typescript/lib/typescript.js');

// 1. Text bundle for DW (no shims needed — DW runtime handles it)
const outfile = resolve(distDir, 'typescript.min.bundle');
await build({
  entryPoints: [tscEntry],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  minify: true,
  outfile,
});

const stats = readFileSync(outfile);
const sizeMB = (stats.length / (1024 * 1024)).toFixed(1);
console.log(`Bundled typescript text module to ${outfile} (${sizeMB} MB)`);

// 2. In-process .mjs with proper Node.js shims via esbuild alias
//    tsc calls os.platform(), path.dirname, fs.existsSync etc. at init.
//    esbuild's --platform=browser creates broken stubs; alias replaces them.
const mjsFile = resolve(distDir, 'typescript.min.mjs');
await build({
  entryPoints: [tscEntry],
  bundle: true,
  platform: 'neutral',  // no built-in shims
  format: 'esm',
  minify: true,
  outfile: mjsFile,
  inject: [resolve(__dirname, 'shims/globals.mjs')],
  alias: {
    'os': resolve(__dirname, 'shims/os.mjs'),
    'path': resolve(__dirname, 'shims/path.mjs'),
    'fs': resolve(__dirname, 'shims/fs.mjs'),
    'perf_hooks': resolve(__dirname, 'shims/perf_hooks.mjs'),
    'crypto': resolve(__dirname, 'shims/crypto.mjs'),
    'inspector': resolve(__dirname, 'shims/inspector.mjs'),
    'child_process': resolve(__dirname, 'shims/empty.mjs'),
    'module': resolve(__dirname, 'shims/empty.mjs'),
  },
});

console.log(`Bundled typescript in-process module to ${mjsFile}`);
