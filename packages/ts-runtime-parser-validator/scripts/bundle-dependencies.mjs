/**
 * Bundle `@typia/transform` + its dependencies + `typescript` into a single
 * ESM file suitable for loading inside a Cloudflare Workers isolate.
 *
 * Why one bundle?
 *   - Typia's transformer does `instanceof` checks against `ts.Node`. Two
 *     `typescript` instances means silent `false`. A single-pass bundle
 *     guarantees one `ts` instance is shared by the transformer and by our
 *     own AST code (`extract-type-metadata.ts`).
 *   - Catches all Node builtins in one sweep.
 *
 * Adapted from `packages/ts-runtime-validator/scripts/bundle-tsc.mjs`. Stubs
 * for `node:os` and `node:inspector` are copied verbatim — those are the
 * two Node builtins the TypeScript compiler imports that do not exist in
 * workerd. Other Node imports (`fs`, `path`, `crypto`, `perf_hooks`) are
 * either available in workerd or already guarded by runtime checks in tsc.
 *
 * Output: `dist/deps.bundle.mjs` (gitignored, regenerated on install/bundle).
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../dist');
const outfile = resolve(outDir, 'deps.bundle.mjs');

mkdirSync(outDir, { recursive: true });

// Capture the TypeScript lib files typia needs to classify types (isArrayType,
// isTupleType, etc.). Without these, typia emits `expected: "{}"` for builtin
// collection types. We ship them as a separate text-module bundle so the
// runtime can load them into the virtual CompilerHost. Phase 5 may trim this
// list to only the targets we actually need.
const tscLibDir = dirname(require.resolve('typescript/package.json')) + '/lib';
// Grab every lib.*.d.ts TypeScript ships. The reference-chain rooted at
// lib.es2022 pulls in dozens of siblings (decorators, intl, typedarray, etc.);
// missing any of them leaves globals unbound and `checker.isArrayType()`
// returns false. Shipping all of them is cheap (~3–4 MB as strings) and
// guarantees the chain resolves.
import { readdirSync } from 'fs';
const libFiles = readdirSync(tscLibDir).filter(
  (n) => n.startsWith('lib.') && n.endsWith('.d.ts'),
);
const libEntries = libFiles
  .map((name) => {
    try {
      return `  ${JSON.stringify(name)}: ${JSON.stringify(readFileSync(`${tscLibDir}/${name}`, 'utf8'))}`;
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const libBundlePath = resolve(outDir, 'ts-lib-files.mjs');
writeFileSync(libBundlePath, `export const TS_LIB_FILES = {\n${libEntries.join(',\n')}\n};\n`);
console.log(`Wrote ${libFiles.length} TS lib files → ${libBundlePath}`);

// Re-export the pieces we consume: typescript (as `ts`) and the typia
// transformer factory. A single barrel entry keeps downstream imports tidy
// and ensures esbuild walks both trees under one pass.
const barrelSrc = `
export { default as ts } from 'typescript';
export { default as typiaTransform } from '@typia/transform';
`;

const barrelPath = resolve(outDir, '_barrel.mjs');
writeFileSync(barrelPath, barrelSrc);

await build({
  entryPoints: [barrelPath],
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
const sizeMB = (stats.length / (1024 * 1024)).toFixed(2);
console.log(`Bundled @typia/transform + typescript → ${outfile} (${sizeMB} MB)`);
