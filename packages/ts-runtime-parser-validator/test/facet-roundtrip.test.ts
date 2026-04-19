import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const SIMPLE_TYPES = `
interface Todo {
  title: string;
  done: boolean;
  priority?: number;
}
`;

describe('Spike A: facet round-trip (hand-written validator stub)', () => {
  it('loads the generated module as a facet and returns valid=true for a Todo', async () => {
    const response = await SELF.fetch('http://example.com/parse', {
      method: 'POST',
      body: JSON.stringify({
        typeDefinitions: SIMPLE_TYPES,
        typeName: 'Todo',
        value: { title: 'Fix bug', done: false, priority: 1 },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { valid: boolean; data?: unknown; errors?: unknown };
      moduleSize: number;
    };
    expect(body.result.valid).toBe(true);
    expect(body.result.data).toEqual({ title: 'Fix bug', done: false, priority: 1 });
    expect(body.moduleSize).toBeGreaterThan(0);
  });

  it('returns valid=false with errors when the value does not match', async () => {
    const response = await SELF.fetch('http://example.com/parse', {
      method: 'POST',
      body: JSON.stringify({
        typeDefinitions: SIMPLE_TYPES,
        typeName: 'Todo',
        value: { notATitle: 42 },
        bundleId: 'mismatch',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { valid: boolean; errors?: Array<{ path: string }> };
    };
    expect(body.result.valid).toBe(false);
    expect(body.result.errors).toBeDefined();
    expect(Array.isArray(body.result.errors)).toBe(true);
  });
});
