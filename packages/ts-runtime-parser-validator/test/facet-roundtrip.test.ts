import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const SIMPLE_TYPES = `
interface Todo {
  title: string;
  done: boolean;
  priority?: number;
}
`;

async function parse(
  typeName: string,
  value: unknown,
  bundleId = 'default',
  typeDefinitions = SIMPLE_TYPES,
): Promise<{
  result: { valid: boolean; data?: unknown; errors?: Array<{ path: string; expected: string }> };
  moduleSize: number;
}> {
  const response = await SELF.fetch('http://example.com/parse', {
    method: 'POST',
    body: JSON.stringify({ typeDefinitions, typeName, value, bundleId }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe('Spike A: real typia transform via facet', () => {
  it('emits a facet module that validates a correct Todo', async () => {
    const { result, moduleSize } = await parse('Todo', {
      title: 'Fix bug',
      done: false,
      priority: 1,
    });
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ title: 'Fix bug', done: false, priority: 1 });
    expect(moduleSize).toBeGreaterThan(500); // real emit is larger than the stub
  });

  it('rejects a Todo with wrong field types and returns typia errors', async () => {
    const { result } = await parse(
      'Todo',
      { title: 42, done: 'yes' },
      'mismatch',
    );
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors!.length).toBeGreaterThan(0);
    // typia errors carry path + expected + value
    const first = result.errors![0];
    expect(typeof first.path).toBe('string');
    expect(typeof first.expected).toBe('string');
  });

  it('rejects a Todo with missing required field', async () => {
    const { result } = await parse(
      'Todo',
      { title: 'only title' },
      'missing-required',
    );
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('returns valid=false with an explicit unknown-type error for a bogus typeName', async () => {
    const { result } = await parse('NotATypeName', { anything: 1 }, 'unknown-type');
    expect(result.valid).toBe(false);
    expect(result.errors![0].expected).toBe('NotATypeName');
  });

  it('validates a richer nested interface (inline nested object, union, array, optional)', async () => {
    const RICH = `
interface User {
  id: string;
  name: string;
  role: "admin" | "editor" | "viewer";
  address: { street: string; city: string; zip: string; };
  tags: string[];
  active: boolean;
  nickname?: string;
}
`;
    const validUser = {
      id: 'u-1',
      name: 'Alice',
      role: 'admin',
      address: { street: '1 Main', city: 'Springfield', zip: '62701' },
      tags: ['team-lead'],
      active: true,
    };
    const { result: good, moduleSize } = await parse(
      'User',
      validUser,
      'rich-valid',
      RICH,
    );
    expect(good.valid).toBe(true);
    expect(good.data).toEqual(validUser);
    expect(moduleSize).toBeGreaterThan(500);

    const { result: bad } = await parse(
      'User',
      { ...validUser, role: 'superadmin', tags: 'not-array' },
      'rich-invalid',
      RICH,
    );
    expect(bad.valid).toBe(false);
    const paths = bad.errors!.map((e) => e.path);
    expect(paths.some((p) => p.includes('role'))).toBe(true);
    expect(paths.some((p) => p.includes('tags'))).toBe(true);
  });
});
