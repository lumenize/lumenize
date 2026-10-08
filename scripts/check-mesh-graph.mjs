// The import-graph tripwire for Mesh's two light entries: `@lumenize/mesh` and
// `@lumenize/mesh/client` must not reach the auth layer's Registry, its router, its token
// handlers or its email sender, nor `@lumenize/email` or `@lumenize/sql-migrations`. Those live
// behind `@lumenize/mesh/auth`. A Client bundle importing `/client`, and every Worker importing
// the root, would otherwise pay for the Registry's SQL schema and the mail transports at
// startup (`.claude/rules/packaging.md` § *Startup cost is work at import, not bytes*), and a
// browser bundle would fail on what they import. Stated over the ENTRY GRAPH, never a directory:
// the scope grammar, the verdicts and the host grammar live in `src/auth/` too, and the entries
// re-export them on purpose. Modelled on apps/nebula/scripts/check-worker-graph.mjs; Mesh's
// `test` script runs it ahead of vitest.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mesh = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'mesh', 'src');

const FORBIDDEN = [
  /packages\/mesh\/src\/auth\/auth-registry\.ts$/,
  /packages\/mesh\/src\/auth\/router\.ts$/,
  /packages\/mesh\/src\/auth\/worker-token\.ts$/,
  /packages\/mesh\/src\/auth\/auth-email-sender\.ts$/,
  /packages\/email\//,
  /packages\/sql-migrations\//,
];

let failed = false;
for (const entry of ['index.ts', 'client-index.ts']) {
  const result = await build({
    entryPoints: [resolve(mesh, entry)],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    // Runtime-provided modules — not part of the graph under test.
    external: ['cloudflare:workers', 'cloudflare:email', 'cloudflare:sockets', 'cloudflare:test', 'node:*'],
    conditions: ['workerd', 'worker', 'browser'],
  });
  const inputs = Object.keys(result.metafile.inputs);
  const hits = inputs.filter((i) => FORBIDDEN.some((re) => re.test(i)));
  if (hits.length > 0) {
    failed = true;
    console.error(
      `✗ Mesh's ${entry} graph reaches the auth layer's server half, which belongs behind @lumenize/mesh/auth:\n`
      + hits.map((h) => `    ${h}`).join('\n')
      + `\n  Trace the importer chain with: npx esbuild packages/mesh/src/${entry} --bundle --metafile=meta.json`,
    );
  } else {
    console.log(`✓ mesh ${entry} graph holds no Registry, router, token or email-sender module (${inputs.length} modules checked)`);
  }
}
if (failed) process.exit(1);
