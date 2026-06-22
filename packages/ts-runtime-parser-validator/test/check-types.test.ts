import { describe, it, expect } from 'vitest';
import { checkTypeScript } from '../src/virtual-ts-host';

/**
 * Package-local guard for `checkTypeScript` — the in-Worker TS type-check engine
 * the SFC semantic gate (apps/nebula codegen loop) depends on. Keeps the engine's
 * contract from regressing without the Nebula consumer noticing. Runs the bundled
 * `typescript` + lib files under vitest-pool-workers (same as generateParseModule).
 */
describe('checkTypeScript', () => {
  it('valid TypeScript → { ok: true, messages: [] }', () => {
    const r = checkTypeScript({ files: { '/a.ts': 'const x: number = 1; export {};' }, rootNames: ['/a.ts'] });
    expect(r).toEqual({ ok: true, messages: [] });
  });

  it('a type error → { ok: false } with the flattened diagnostic', () => {
    const r = checkTypeScript({ files: { '/a.ts': "const x: number = 'nope'; export {};" }, rootNames: ['/a.ts'] });
    expect(r.ok).toBe(false);
    expect(r.messages.join('\n')).toMatch(/not assignable/);
  });

  it('resolves a relative import against a sibling virtual file (the SFC Pass-2 shape)', () => {
    const ok = checkTypeScript({
      files: {
        '/api.d.ts': 'export const greet: (n: string) => string;',
        '/main.ts': "import { greet } from './api'; const s: string = greet('x'); export {};",
      },
      rootNames: ['/main.ts'],
    });
    expect(ok).toEqual({ ok: true, messages: [] });

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
    expect(r).toEqual({ ok: true, messages: [] });
  });
});
