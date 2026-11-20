// The import-graph tripwire (tasks/archive/nebula-move-compilers-out-of-the-worker.md
// § Success): asserts that NO module reachable from src/worker.ts — the deployed
// Worker's entry — imports the parser-validator's COMPILE entry or
// `@vue/compiler-sfc`. Stated over the ENTRY GRAPH, never a directory and never a
// byte count: `compileSource` and `ontology-compile.ts` deliberately survive in
// `src/` for the test lanes and the Node-side generators, and a directory rule would
// red on that intended end state while missing `@vue/compiler-sfc` entirely. One
// stray import re-blocks the deploy (startup CPU limit) while greening the whole
// suite — which is how the blocker stayed invisible for eight weeks — so this runs
// in the package `test` script ahead of vitest (a `--check`-style step cannot be
// silently dropped the way a vitest project can; see scripts/test-code.sh's header).
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '..', 'src', 'worker.ts');

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  metafile: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  // Runtime-provided modules — not part of the graph under test.
  external: ['cloudflare:workers', 'cloudflare:email', 'cloudflare:sockets', 'cloudflare:test'],
});

const inputs = Object.keys(result.metafile.inputs);

// The forbidden surfaces, as INPUT paths (esbuild records what it actually read):
//  - the compile entry's tsc-bearing modules (reached only via the /compile subpath
//    or a relative import into them);
//  - @vue/compiler-sfc, whatever entry file its package resolves to.
const FORBIDDEN = [
  /packages\/ts-runtime-parser-validator\/src\/index\.ts$/,
  /packages\/ts-runtime-parser-validator\/src\/generate-parse-module\.ts$/,
  /packages\/ts-runtime-parser-validator\/src\/extract-type-metadata\.ts$/,
  /packages\/ts-runtime-parser-validator\/src\/virtual-ts-host\.ts$/,
  /packages\/ts-runtime-parser-validator\/dist\/deps\.bundle\.mjs$/,
  /node_modules\/@vue\/compiler-sfc\//,
];

// ⓘ An import whose bindings are all UNUSED is elided by TypeScript semantics before
// bundling (esbuild replicates tsc's import elision), so it neither appears here nor
// costs the deploy anything — the tripwire fires exactly on REACHABLE compiler code,
// which is the property that blocks the deploy. Verified 2026-08-29: an unused value
// import of compileOntologyVersion stayed green; a referenced one reds.
const hits = inputs.filter((i) => FORBIDDEN.some((re) => re.test(i)));
if (hits.length > 0) {
  console.error(
    '✗ the deployed Worker\'s entry graph reaches a COMPILER — this re-blocks the deploy\n' +
    '  (Script startup exceeded CPU time limit) while every suite stays green:\n' +
    hits.map((h) => `    ${h}`).join('\n') +
    '\n  Trace the importer chain with: npx esbuild src/worker.ts --bundle --metafile=meta.json' +
    '\n  (tasks/archive/nebula-move-compilers-out-of-the-worker.md § Success — the tripwire)',
  );
  process.exit(1);
}
console.log(`✓ worker entry graph is compiler-free (${inputs.length} modules checked)`);
