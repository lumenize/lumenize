import { describe, it, expect } from 'vitest';
import { extractTypeMetadata } from '../src/extract-type-metadata';

describe('extractTypeMetadata — @default JSDoc extraction (Phase 3 D2/D3, Phase 4 P4.2)', () => {
  it('collects JSON-number default', () => {
    const md = extractTypeMetadata(`
interface Todo {
  title: string;
  /** @default 0 */
  priority?: number;
}
`);
    expect(md.defaults).toEqual({ Todo: { priority: 0 } });
  });

  it('collects JSON-string, boolean, and null defaults', () => {
    const md = extractTypeMetadata(`
interface Prefs {
  /** @default "en" */
  locale?: string;
  /** @default true */
  enabled?: boolean;
  /** @default null */
  backup?: string | null;
}
`);
    expect(md.defaults).toEqual({
      Prefs: { locale: 'en', enabled: true, backup: null },
    });
  });

  it('collects JSON-array default', () => {
    const md = extractTypeMetadata(`
interface Tagged {
  /** @default [] */
  tags?: string[];
  /** @default [1, 2, 3] */
  counts?: number[];
}
`);
    expect(md.defaults).toEqual({
      Tagged: { tags: [], counts: [1, 2, 3] },
    });
  });

  it('collects JSON-object default (nested)', () => {
    const md = extractTypeMetadata(`
interface Settings {
  /** @default {"timeout": 30, "nested": {"a": true}} */
  config?: { timeout: number; nested: { a: boolean; }; };
}
`);
    expect(md.defaults).toEqual({
      Settings: { config: { timeout: 30, nested: { a: true } } },
    });
  });

  it('leaves types without @default out of the defaults map entirely', () => {
    const md = extractTypeMetadata(`
interface Plain {
  title: string;
  count?: number;
}
`);
    expect(md.defaults).toEqual({});
  });

  it('P4.2 — @default on required field throws with a corrective message', () => {
    expect(() =>
      extractTypeMetadata(`
interface Bad {
  /** @default 0 */
  x: number;
}
`),
    ).toThrow(/@default on required field 'Bad\.x'/);
  });

  it('D3 — invalid @default value throws with offending text', () => {
    expect(() =>
      extractTypeMetadata(`
interface Bad {
  /** @default 10n */
  x?: bigint;
}
`),
    ).toThrow(/invalid @default value on Bad\.x/);
  });

  it('D3 — single-quoted string rejected', () => {
    expect(() =>
      extractTypeMetadata(`
interface Bad {
  /** @default 'x' */
  s?: string;
}
`),
    ).toThrow(/invalid @default value/);
  });

  it('D3 — unquoted object key rejected', () => {
    expect(() =>
      extractTypeMetadata(`
interface Bad {
  /** @default {foo: 1} */
  o?: { foo: number };
}
`),
    ).toThrow(/invalid @default value/);
  });

  it('D3 — empty @default rejected', () => {
    expect(() =>
      extractTypeMetadata(`
interface Bad {
  /** @default */
  x?: number;
}
`),
    ).toThrow(/empty @default value/);
  });

  it('D5 — unknown tags are tolerated (no error)', () => {
    const md = extractTypeMetadata(`
interface Doc {
  /** @author Alice */
  title: string;
  /** @since 1.0 @default 0 */
  count?: number;
}
`);
    expect(md.defaults).toEqual({ Doc: { count: 0 } });
  });

  it('collects defaults across multiple interfaces', () => {
    const md = extractTypeMetadata(`
interface A {
  /** @default 1 */
  x?: number;
}
interface B {
  /** @default "hi" */
  y?: string;
}
`);
    expect(md.defaults).toEqual({ A: { x: 1 }, B: { y: 'hi' } });
  });
});
