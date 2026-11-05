import { describe, it, expect } from 'vitest';
import { checkTypeScript } from '../src/virtual-ts-host';
import type { DiskReader } from '../src/virtual-ts-host';

/**
 * Package-local guard for `checkTypeScript` — the TS type-check engine the build box's SFC
 * check (apps/nebula) depends on. Keeps the engine's contract from regressing without the
 * Nebula consumer noticing. Runs the bundled `typescript` + lib files under vitest-plugin
 * (same as generateParseModule); the disk cases hand it a map-backed {@link DiskReader},
 * since a Worker has no disk, and the real one is `apps/nebula`'s `codegen-gate.test.ts`.
 */

/** A disk holding exactly `files`, every directory implied by their paths. */
function diskOf(files: Record<string, string>): DiskReader {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    for (let d = path.slice(0, path.lastIndexOf('/')); d; d = d.slice(0, d.lastIndexOf('/'))) dirs.add(d);
  }
  return {
    fileExists: (p) => p in files,
    readFile: (p) => files[p],
    directoryExists: (p) => p === '/' || dirs.has(p),
    getDirectories: (p) => [...dirs].filter((d) => d.slice(0, d.lastIndexOf('/')) === p).map((d) => d.slice(d.lastIndexOf('/') + 1)),
    realpath: (p) => p,
  };
}

describe('checkTypeScript', () => {
  it('valid TypeScript → { ok: true, messages: [] }', () => {
    const r = checkTypeScript({ files: { '/a.ts': 'const x: number = 1; export {};' }, rootNames: ['/a.ts'] });
    expect(r).toEqual({ ok: true, messages: [], findings: [] });
  });

  it('a type error → { ok: false } with the flattened diagnostic', () => {
    const r = checkTypeScript({ files: { '/a.ts': "const x: number = 'nope'; export {};" }, rootNames: ['/a.ts'] });
    expect(r.ok).toBe(false);
    expect(r.messages.join('\n')).toMatch(/not assignable/);
    // `findings` is the location-bearing form a build report persists: one line per
    // diagnostic, `file(line,col): error TSxxxx: text`, path without the leading slash.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatch(/^a\.ts\(1,7\): error TS2322: /);
  });

  it('resolves a relative import against a sibling virtual file (the SFC Pass-2 shape)', () => {
    const ok = checkTypeScript({
      files: {
        '/api.d.ts': 'export const greet: (n: string) => string;',
        '/main.ts': "import { greet } from './api'; const s: string = greet('x'); export {};",
      },
      rootNames: ['/main.ts'],
    });
    expect(ok).toEqual({ ok: true, messages: [], findings: [] });

    const bad = checkTypeScript({
      files: {
        '/api.d.ts': 'export const greet: (n: string) => string;',
        '/main.ts': "import { greet } from './api'; greet(123); export {};",
      },
      rootNames: ['/main.ts'],
    });
    expect(bad.ok).toBe(false);
  });

  it('DOM + ES globals resolve by default (no spurious unresolved-global errors)', () => {
    const r = checkTypeScript({
      files: { '/a.ts': 'const id: string = crypto.randomUUID(); const n = Object.keys({}).length; export {};' },
      rootNames: ['/a.ts'],
    });
    expect(r).toEqual({ ok: true, messages: [], findings: [] });
  });

  it('reads an import the map lacks from the disk, and the map wins where both hold one', () => {
    const disk = diskOf({ '/app/api.ts': 'export const greet = (n: string): string => n;' });
    const ok = checkTypeScript({
      files: { '/app/main.ts': "import { greet } from './api'; greet('x'); export {};" },
      rootNames: ['/app/main.ts'],
      disk,
    });
    expect(ok).toEqual({ ok: true, messages: [], findings: [] });
    // Mutation: read the disk before the map → the overlay's number parameter is ignored → red.
    const overlaid = checkTypeScript({
      files: {
        '/app/api.ts': 'export const greet = (n: number): number => n;',
        '/app/main.ts': "import { greet } from './api'; greet('x'); export {};",
      },
      rootNames: ['/app/main.ts'],
      disk,
    });
    expect(overlaid.findings).toEqual([expect.stringMatching(/^app\/main\.ts\(1,38\): error TS2345: /)]);
  });

  it("takes its options from the tsconfig it is handed, its target's default lib included", () => {
    // With the defaults (ES2022 + DOM) `Symbol.dispose` is undeclared; ESNext declares it.
    const usingIt = { '/app/main.ts': 'using x = { [Symbol.dispose]() {} }; export {};' };
    expect(checkTypeScript({ files: usingIt, rootNames: ['/app/main.ts'] }).ok).toBe(false);
    const disk = diskOf({ '/app/tsconfig.json': '{ "compilerOptions": { "target": "ESNext", "strict": true } }' });
    expect(checkTypeScript({ files: usingIt, rootNames: ['/app/main.ts'], disk, tsconfigPath: '/app/tsconfig.json' }))
      .toEqual({ ok: true, messages: [], findings: [] });
  });

  it('reports only the files named in reportFor', () => {
    // Mutation: ignore `reportFor` → the dependency's own error is reported → red.
    const r = checkTypeScript({
      files: {
        '/app/lib.ts': "export const n: number = 'not a number';",
        '/app/main.ts': "import { n } from './lib'; const s: string = n; export {};",
      },
      rootNames: ['/app/main.ts'],
      reportFor: ['/app/main.ts'],
    });
    expect(r.findings).toEqual([expect.stringMatching(/^app\/main\.ts\(1,34\): error TS2322: /)]);
  });

  it('refuses a tsconfigPath with no disk to read it from', () => {
    expect(() => checkTypeScript({ files: {}, rootNames: [], tsconfigPath: '/app/tsconfig.json' }))
      .toThrow('a tsconfigPath is read through a disk');
  });
});
