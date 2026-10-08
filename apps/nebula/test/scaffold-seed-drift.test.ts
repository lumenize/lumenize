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
  it('carries the whole 14-file scaffold, with the load-bearing members present', () => {
    const paths = Object.keys(SCAFFOLD_FILES).sort();
    expect(paths).toEqual([
      // The Galaxy layer of the guidance tree — seeded into every new Workspace.
      'AGENTS.md',
      'CLAUDE.md',
      'docs/permissions.md',
      'docs/personas.md',
      'docs/vision.md',
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

  it('the Galaxy layer seed: CLAUDE.md is exactly the one-line import, and each declared file says when to write it', () => {
    // Claude Code reads CLAUDE.md and not AGENTS.md, so a user-developer opening a clone
    // there gets the same tree through this one line (the import syntax is Claude-only,
    // which is why the platform file itself points with plain paths).
    expect(SCAFFOLD_FILES['CLAUDE.md']).toBe('@AGENTS.md\n');
    for (const p of ['AGENTS.md', 'docs/vision.md', 'docs/personas.md', 'docs/permissions.md']) {
      expect(SCAFFOLD_FILES[p]).toContain('Write this when');
    }
    // The four verbs any org-tree shape composes from ride the personas template.
    for (const verb of ['mint', 'node', 'edge', 'grant']) expect(SCAFFOLD_FILES['docs/personas.md']).toContain(`**${verb}**`);
    expect(SCAFFOLD_FILES['docs/permissions.md']).toContain('## Decisions');
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
