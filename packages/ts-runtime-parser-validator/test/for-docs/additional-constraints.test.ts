/**
 * For-docs tests backing website/docs/ts-runtime-parser-validator/additional-constraints.md.
 *
 * The doc's code blocks are `@check-example`'d into this file. Normalisation
 * strips JSDoc comments from both sides, so the substring match compares the
 * bare interfaces. Runtime still sees the full JSDoc (template literals
 * preserve them for typia's transform).
 */

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

let bundleCounter = 0;

function makeFacet(types: string) {
  const bundleId = `ac-${++bundleCounter}`;
  return {
    parse: (value: unknown, typeName: string): Promise<ParseResult> => {
      const ns = env.PRIMARY_DO;
      const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
      return stub.parse(types, typeName, value, bundleId);
    },
  };
}

describe('How to write an annotation', () => {
  it('single @minimum annotation', async () => {
    const facet = makeFacet(`
interface Person {
  /** @minimum 13 */
  age: number;
}
`);
    expect((await facet.parse({ age: 12 }, 'Person')).valid).toBe(false);
    expect((await facet.parse({ age: 13 }, 'Person')).valid).toBe(true);
  });

  it('multiple annotations in a single block', async () => {
    const facet = makeFacet(`
interface Name {
  /**
   * @minLength 3
   * @maxLength 20
   */
  value: string;
}
`);
    expect((await facet.parse({ value: 'ab' }, 'Name')).valid).toBe(false);
    expect((await facet.parse({ value: 'abc' }, 'Name')).valid).toBe(true);
    expect((await facet.parse({ value: 'x'.repeat(21) }, 'Name')).valid).toBe(false);
  });

  it('stacked blocks — only the last one counts (footgun)', async () => {
    const facet = makeFacet(`
interface StackedBad {
  // ❌ Stacked blocks — @minimum silently dropped
  /** @minimum 1 */
  /** @maximum 5 */
  stars: number;
}

interface StackedGood {
  // ✅ Single block with multiple tags — both apply
  /**
   * @minimum 1
   * @maximum 5
   */
  stars: number;
}
`);
    // StackedBad: @minimum was silently dropped, only @maximum applies.
    expect((await facet.parse({ stars: 0 }, 'StackedBad')).valid).toBe(true);  // minimum dropped
    expect((await facet.parse({ stars: 6 }, 'StackedBad')).valid).toBe(false); // maximum still applies

    // StackedGood: both apply.
    expect((await facet.parse({ stars: 0 }, 'StackedGood')).valid).toBe(false);
    expect((await facet.parse({ stars: 6 }, 'StackedGood')).valid).toBe(false);
    expect((await facet.parse({ stars: 3 }, 'StackedGood')).valid).toBe(true);
  });
});

describe('Number annotations', () => {
  it('@minimum, @maximum, @type int32', async () => {
    const facet = makeFacet(`
interface Rating {
  /**
   * @minimum 1
   * @maximum 5
   * @type int32
   */
  stars: number;
}
`);
    const bad = await facet.parse({ stars: 6 }, 'Rating');
    expect(bad.valid).toBe(false);  // stars exceeds @maximum

    const ok = await facet.parse({ stars: 5 }, 'Rating');
    expect(ok).toEqual({ valid: true, data: { stars: 5 } });
  });
});

describe('String annotations', () => {
  it('@format email and @pattern', async () => {
    const facet = makeFacet(`
interface Contact {
  /** @format email */
  email: string;

  /** @pattern ^[a-z0-9-]+$ */
  slug: string;
}
`);
    const bad = await facet.parse(
      { email: 'not-an-email', slug: 'Has Spaces' },
      'Contact',
    );
    expect(bad.valid).toBe(false);  // both fields fail

    const ok = await facet.parse(
      { email: 'alice@example.com', slug: 'hello-world' },
      'Contact',
    );
    expect(ok).toEqual({
      valid: true,
      data: { email: 'alice@example.com', slug: 'hello-world' },
    });
  });
});

describe('Array annotations', () => {
  it('@minItems, @maxItems, @uniqueItems', async () => {
    const facet = makeFacet(`
interface Bag {
  /**
   * @minItems 1
   * @maxItems 10
   * @uniqueItems
   */
  tags: string[];
}
`);
    const empty = await facet.parse({ tags: [] }, 'Bag');
    expect(empty.valid).toBe(false);  // @minItems violated

    const dup = await facet.parse({ tags: ['a', 'a'] }, 'Bag');
    expect(dup.valid).toBe(false);  // @uniqueItems violated

    const ok = await facet.parse({ tags: ['a', 'b', 'c'] }, 'Bag');
    expect(ok).toEqual({ valid: true, data: { tags: ['a', 'b', 'c'] } });
  });
});
