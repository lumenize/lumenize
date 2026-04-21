/**
 * Bundle `@typia/transform` + its dependencies + `typescript` into a single
 * ESM file suitable for loading inside a Cloudflare Workers isolate —
 * including real `wrangler dev` and deployed Workers, not just
 * `vitest-pool-workers`.
 *
 * Why one bundle?
 *   - Typia's transformer does `instanceof` checks against `ts.Node`. Two
 *     `typescript` instances means silent `false`. A single-pass bundle
 *     guarantees one `ts` instance is shared by the transformer and by our
 *     own AST code (`extract-type-metadata.ts`).
 *   - Catches all Node builtins in one sweep.
 *
 * Recipe follows the proven tsc-in-Worker pattern from
 * `experiments/dw-bundler-spike/scripts/bundle-tsc.mjs`:
 *   - `platform: 'neutral'` — no built-in shims; every Node import must
 *     be resolved via explicit alias
 *   - Full shim set for the Node builtins tsc/typia probe at init time:
 *     `fs`, `path`, `os`, `crypto`, `perf_hooks`, `inspector`,
 *     `child_process`, `module`, `url`, `util`
 *   - `inject: stubs/globals.mjs` provides `__filename`, `__dirname`, and
 *     a minimal `process` object
 *
 * Earlier versions used `platform: 'node'` with only `os` + `inspector`
 * aliased. That worked under `vitest-pool-workers` because vpw injects
 * extra Node shims, but failed under real `wrangler dev` with
 * "Dynamic require of 'fs' is not supported" — esbuild converts
 * `require('fs')` into runtime `__require('fs')` which workerd rejects.
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

const stubsDir = resolve(__dirname, 'stubs');
const stub = (name) => resolve(stubsDir, `${name}.mjs`);
// Every Node builtin tsc or typia imports must be aliased when
// platform='neutral'. Missing one produces a "Could not resolve 'X'" error
// from esbuild, which is a loud, easy-to-fix failure. Catching a missing
// shim at bundle time beats discovering it at Worker-start time.
const nodeAliases = {
  'os': stub('os'),
  'path': stub('path'),
  'fs': stub('fs'),
  'crypto': stub('crypto'),
  'perf_hooks': stub('perf_hooks'),
  'inspector': stub('inspector'),
  'child_process': stub('empty'),
  'module': stub('empty'),
  'url': stub('empty'),
  'util': stub('empty'),
};
// Mirror each alias with its `node:` prefix form — some modules use either.
const allAliases = {
  ...nodeAliases,
  ...Object.fromEntries(Object.entries(nodeAliases).map(([k, v]) => [`node:${k}`, v])),
};

await build({
  entryPoints: [barrelPath],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  minify: true,
  outfile,
  // `mainFields` must be explicit under platform='neutral' (no defaults);
  // these match Node's resolution order so typescript / @typia/transform
  // resolve their CJS entrypoints.
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  inject: [stub('globals')],
  alias: allAliases,
});

const stats = readFileSync(outfile);
const sizeMB = (stats.length / (1024 * 1024)).toFixed(2);
console.log(`Bundled @typia/transform + typescript → ${outfile} (${sizeMB} MB)`);
