/**
 * Bundle `typescript`'s `transpileModule` into a single ESM file that loads
 * inside a Cloudflare Workers isolate (vitest-pool-workers, real `wrangler dev`,
 * and deployed Workers).
 *
 * ## Why this exists (build-seq #1a finding)
 *
 * A bare `import { transpileModule } from 'typescript'` **crashes the workerd
 * isolate at module-load** ("Worker exited unexpectedly") — verified in
 * `tasks/nebula-studio-compile-pipeline.md` § Phase-1 spike: `typescript` probes
 * Node builtins (`fs`/`os`/`process.argv`/…) at init, which workerd rejects.
 * `@vue/compiler-sfc` runs fine unbundled; only `typescript` needs this.
 *
 * Recipe mirrors the **proven** validator pattern
 * (`packages/ts-runtime-parser-validator/scripts/bundle-tsc.mjs`):
 *   - `platform: 'neutral'` — no implicit Node shims; every Node import is
 *     resolved via an explicit alias to a stub in `scripts/stubs/`.
 *   - `inject: stubs/globals.mjs` supplies `__filename`/`__dirname`/`process`.
 *
 * Unlike the validator we bundle ONLY `typescript` (no `@typia/transform`, no
 * `lib.*.d.ts` text bundle): `transpileModule` is syntactic-only (no type-check,
 * no `Program`/`CompilerHost`/lib resolution), so the light path needs neither.
 *
 * ## Obtaining it without a dev-loop build
 *
 * Output `vendor/tsc-transpile.bundle.mjs` is **committed** (gitignore-exempt),
 * so a fresh clone — dev, vitest-pool-workers, OR a deployed Worker — has it
 * with no prior `npm run bundle:tsc`. Re-run this script only on a `typescript`
 * version bump (then commit the regenerated bundle). This is the deliberate
 * choice over the validator's gitignored+build-on-publish bundle, which a
 * fresh-clone CI test would lack.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../vendor');
const outfile = resolve(outDir, 'tsc-transpile.bundle.mjs');
mkdirSync(outDir, { recursive: true });

// Barrel: re-export typescript's default (the `ts` namespace). We consume
// `ts.transpileModule` / `ts.ScriptTarget` / `ts.ModuleKind` downstream.
const barrelPath = resolve(outDir, '_tsc-barrel.mjs');
writeFileSync(barrelPath, `export { default as ts } from 'typescript';\n`);

const stub = (name) => resolve(__dirname, 'stubs', `${name}.mjs`);
const nodeAliases = {
  os: stub('os'),
  path: stub('path'),
  fs: stub('fs'),
  crypto: stub('crypto'),
  perf_hooks: stub('perf_hooks'),
  inspector: stub('inspector'),
  child_process: stub('empty'),
  module: stub('empty'),
  url: stub('empty'),
  util: stub('empty'),
};
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
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  inject: [stub('globals')],
  alias: allAliases,
});

const sizeMB = (readFileSync(outfile).length / (1024 * 1024)).toFixed(2);
console.log(`Bundled typescript (transpileModule) → ${outfile} (${sizeMB} MB)`);
