/**
 * Invariants of the committed scaffold embed (src/scaffold-seed.ts, GENERATED from
 * container/app/ by scripts/gen-scaffold.mjs — a one-shot generator, not a dev-loop
 * build step). BYTE-level drift is gated by `node scripts/gen-scaffold.mjs --check`
 * in the package `test` script (a workerd isolate has no fs, so a vitest test cannot
 * diff against the disk); what THIS file pins is the contract the build box and the
 * serve depend on — the file set, the vite base, the injection anchor — so a
 * regenerated embed that silently loses one of them reds here.
 */
import { describe, it, expect } from 'vitest';
import { SCAFFOLD_FILES } from '../src/scaffold-seed';

describe('scaffold-seed embed invariants', () => {
  it('carries the whole 9-file scaffold, with the load-bearing members present', () => {
    const paths = Object.keys(SCAFFOLD_FILES).sort();
    expect(paths).toEqual([
      'index.html',
      'package.json',
      'src/App.vue',
      'src/main.ts',
      'src/nebula.ts',
      'src/ontology.d.ts',
      'src/style.css',
      'tsconfig.json',
      'vite.config.ts',
    ]);
  });

  it("vite config builds with base './' and NO dev-server block (build-box only)", () => {
    const cfg = SCAFFOLD_FILES['vite.config.ts']!;
    expect(cfg).toContain(`base: "./"`);
    expect(cfg).not.toContain('server:');
    expect(cfg).not.toContain('PREVIEW_BASE');
  });

  it('index.html keeps the nebula-scope injection anchor (a <head> for HTMLRewriter to prepend into)', () => {
    const html = SCAFFOLD_FILES['index.html']!;
    expect(html).toContain('<head>');
    expect(html).toContain('nebula-scope');
  });
});
