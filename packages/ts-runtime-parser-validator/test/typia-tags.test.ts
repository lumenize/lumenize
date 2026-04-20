import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

async function parse(
  typeDefinitions: string,
  typeName: string,
  value: unknown,
  bundleId: string,
): Promise<{
  result: { valid: boolean; errors?: Array<{ path: string; expected: string }> };
}> {
  const response = await SELF.fetch('http://example.com/parse', {
    method: 'POST',
    body: JSON.stringify({ typeDefinitions, typeName, value, bundleId }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

// Phase 3 D1: typia's JSDoc vocabulary passes through to the transformer.
// Spot-check the main categories — numeric, string, array, format.
describe('Typia tag vocabulary (Phase 3 D1 — JSDoc tags flow through)', () => {
  it('@minimum enforces number lower bound', async () => {
    const types = `
interface Person {
  /** @minimum 13 */
  age: number;
}
`;
    const { result: tooYoung } = await parse(types, 'Person', { age: 12 }, 'min-fail');
    expect(tooYoung.valid).toBe(false);
    expect(tooYoung.errors!.some((e) => e.path.includes('age'))).toBe(true);

    const { result: ok } = await parse(types, 'Person', { age: 13 }, 'min-ok');
    expect(ok.valid).toBe(true);
  });

  it('@maximum enforces number upper bound', async () => {
    const types = `
interface Rating {
  /** @maximum 5 */
  score: number;
}
`;
    const { result: over } = await parse(types, 'Rating', { score: 6 }, 'max-fail');
    expect(over.valid).toBe(false);
    const { result: ok } = await parse(types, 'Rating', { score: 5 }, 'max-ok');
    expect(ok.valid).toBe(true);
  });

  it('@exclusiveMinimum rejects the boundary', async () => {
    const types = `
interface Positive {
  /** @exclusiveMinimum 0 */
  n: number;
}
`;
    const { result: zero } = await parse(types, 'Positive', { n: 0 }, 'excl-min-fail');
    expect(zero.valid).toBe(false);
    const { result: one } = await parse(types, 'Positive', { n: 0.001 }, 'excl-min-ok');
    expect(one.valid).toBe(true);
  });

  it('@multipleOf enforces divisibility', async () => {
    const types = `
interface Step {
  /** @multipleOf 5 */
  value: number;
}
`;
    const { result: bad } = await parse(types, 'Step', { value: 7 }, 'mul-fail');
    expect(bad.valid).toBe(false);
    const { result: ok } = await parse(types, 'Step', { value: 10 }, 'mul-ok');
    expect(ok.valid).toBe(true);
  });

  it('@minLength and @maxLength enforce string length bounds', async () => {
    // Multiple tags must share one JSDoc comment block
    const types = `
interface Name {
  /**
   * @minLength 3
   * @maxLength 20
   */
  value: string;
}
`;
    const { result: tooShort } = await parse(types, 'Name', { value: 'ab' }, 'len-short');
    expect(tooShort.valid).toBe(false);
    const { result: tooLong } = await parse(types, 'Name', { value: 'x'.repeat(21) }, 'len-long');
    expect(tooLong.valid).toBe(false);
    const { result: ok } = await parse(types, 'Name', { value: 'Alice' }, 'len-ok');
    expect(ok.valid).toBe(true);
  });

  it('@pattern enforces regex', async () => {
    const types = `
interface Slug {
  /** @pattern ^[a-z0-9-]+$ */
  id: string;
}
`;
    const { result: bad } = await parse(types, 'Slug', { id: 'Has Spaces' }, 'pat-fail');
    expect(bad.valid).toBe(false);
    const { result: ok } = await parse(types, 'Slug', { id: 'hello-world' }, 'pat-ok');
    expect(ok.valid).toBe(true);
  });

  it('@format email validates the format', async () => {
    const types = `
interface Contact {
  /** @format email */
  email: string;
}
`;
    const { result: bad } = await parse(types, 'Contact', { email: 'not-an-email' }, 'fmt-fail');
    expect(bad.valid).toBe(false);
    const { result: ok } = await parse(types, 'Contact', { email: 'alice@example.com' }, 'fmt-ok');
    expect(ok.valid).toBe(true);
  });

  it('@format uuid validates UUID shape', async () => {
    const types = `
interface Ref {
  /** @format uuid */
  id: string;
}
`;
    const { result: bad } = await parse(types, 'Ref', { id: 'not-uuid' }, 'uuid-fail');
    expect(bad.valid).toBe(false);
    const { result: ok } = await parse(
      types,
      'Ref',
      { id: '550e8400-e29b-41d4-a716-446655440000' },
      'uuid-ok',
    );
    expect(ok.valid).toBe(true);
  });

  it('@minItems enforces array length lower bound', async () => {
    const types = `
interface Bag {
  /** @minItems 2 */
  items: string[];
}
`;
    const { result: bad } = await parse(types, 'Bag', { items: ['x'] }, 'min-items-fail');
    expect(bad.valid).toBe(false);
    const { result: ok } = await parse(types, 'Bag', { items: ['x', 'y'] }, 'min-items-ok');
    expect(ok.valid).toBe(true);
  });

  it('@uniqueItems rejects duplicates', async () => {
    const types = `
interface Uniq {
  /** @uniqueItems */
  items: string[];
}
`;
    const { result: bad } = await parse(types, 'Uniq', { items: ['a', 'a'] }, 'uniq-fail');
    expect(bad.valid).toBe(false);
    const { result: ok } = await parse(types, 'Uniq', { items: ['a', 'b'] }, 'uniq-ok');
    expect(ok.valid).toBe(true);
  });
});
