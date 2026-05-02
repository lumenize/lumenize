import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

type ParseResult = {
  valid: boolean;
  data?: unknown;
  errors?: Array<{ path: string; expected: string; value?: unknown }>;
};

interface PrimaryStub {
  parse: (
    typeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId?: string,
  ) => Promise<ParseResult>;
}

function parse(
  typeDefinitions: string,
  typeName: string,
  value: unknown,
  bundleId: string,
): Promise<ParseResult> {
  const ns = env.PRIMARY_DO;
  const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
  return stub.parse(typeDefinitions, typeName, value, bundleId);
}

describe('@default filling (Phase 4 specs made executable)', () => {
  it('P4.1 — flat fill: missing optional field gets the default', async () => {
    const types = `
interface Todo {
  title: string;
  /** @default 0 */
  priority?: number;
}
`;
    const result = await parse(types, 'Todo', { title: 'x' }, 'd-flat');
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ title: 'x', priority: 0 });
  });

  it('P4.1 — explicit undefined triggers the default', async () => {
    const types = `
interface Todo {
  title: string;
  /** @default 0 */
  priority?: number;
}
`;
    const result = await parse(
      types,
      'Todo',
      { title: 'x', priority: undefined },
      'd-undef',
    );
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ title: 'x', priority: 0 });
  });

  it('P4.1 — explicit null is preserved, default NOT applied', async () => {
    const types = `
interface Note {
  /** @default 0 */
  count?: number | null;
}
`;
    const result = await parse(types, 'Note', { count: null }, 'd-null');
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ count: null });
  });

  it('P4.5 — array default: missing array field gets empty array', async () => {
    const types = `
interface Tagged {
  /** @default [] */
  tags?: string[];
}
`;
    const result = await parse(types, 'Tagged', {}, 'd-arr');
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ tags: [] });
  });

  it('P4.5 — object-literal default: missing field gets filled JSON object', async () => {
    const types = `
interface Settings {
  /** @default {"timeout": 30, "retries": 3} */
  config?: { timeout: number; retries: number; };
}
`;
    const result = await parse(types, 'Settings', {}, 'd-obj');
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ config: { timeout: 30, retries: 3 } });
  });

  it('supports string, boolean, and null literals', async () => {
    const types = `
interface Prefs {
  /** @default "en" */
  locale?: string;
  /** @default true */
  enabled?: boolean;
  /** @default null */
  backup?: string | null;
}
`;
    const result = await parse(types, 'Prefs', {}, 'd-multi');
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ locale: 'en', enabled: true, backup: null });
  });

  it('P4.6 — default that fails validation surfaces via typia normal error path', async () => {
    // @default "hello" on a number field — the filler puts "hello" in, then
    // typia reports the type mismatch. Consistent error pipeline.
    const types = `
interface Bad {
  /** @default "hello" */
  count?: number;
}
`;
    const result = await parse(types, 'Bad', {}, 'd-badtype');
    expect(result.valid).toBe(false);
    const paths = result.errors!.map((e) => e.path);
    expect(paths.some((p) => p.includes('count'))).toBe(true);
    const first = result.errors!.find((e) => e.path.includes('count'))!;
    // Optional field → typia reports `(number | undefined)` as the expected type.
    expect(first.expected).toContain('number');
    expect(first.value).toBe('hello');
  });

  it('does not override a caller-supplied value', async () => {
    const types = `
interface Todo {
  title: string;
  /** @default 0 */
  priority?: number;
}
`;
    const result = await parse(
      types,
      'Todo',
      { title: 'x', priority: 99 },
      'd-override',
    );
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ title: 'x', priority: 99 });
  });
});
