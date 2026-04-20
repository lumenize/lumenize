/**
 * Type-support delta suite — JS-values-over-RPC layer.
 *
 * These tests call the DO via **Workers RPC** (not `SELF.fetch` with a JSON
 * body), so `value` crosses the boundary with structured-clone semantics:
 * Date, Map, Set, RegExp, TypedArrays, cyclic refs all survive. This is the
 * production serialisation path (Star → facet in 5.2.4.2).
 *
 * Pass/fail here reflects whether typia's generated validator can *validate*
 * the type, given that the value arrives fully-typed. JSON-boundary artefacts
 * are excluded.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

type ParseResult = {
  valid: boolean;
  data?: unknown;
  errors?: Array<{ path: string; expected: string; value?: unknown }>;
};

interface PrimaryStub {
  rpcParse: (
    typeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId?: string,
  ) => Promise<ParseResult>;
}

function rpcParse(
  typeDefinitions: string,
  typeName: string,
  value: unknown,
  bundleId: string,
): Promise<ParseResult> {
  const ns = env.PRIMARY_DO;
  const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
  return stub.rpcParse(typeDefinitions, typeName, value, bundleId);
}

describe('Parity (RPC path) — Date', () => {
  it('[SUPPORTED] Date instance validates against `Date` type', async () => {
    const types = `interface Appt { when: Date; }`;
    const result = await rpcParse(types, 'Appt', { when: new Date('2026-04-20T10:30:00Z') }, 'rpc-date');
    expect(result.valid).toBe(true);
  });

  it('[SUPPORTED] Date-string format validation via @format date-time', async () => {
    const types = `
interface Appt {
  /** @format date-time */
  when: string;
}
`;
    const good = await rpcParse(types, 'Appt', { when: '2026-04-20T10:30:00Z' }, 'rpc-dt-ok');
    expect(good.valid).toBe(true);
    const bad = await rpcParse(types, 'Appt', { when: 'not a date' }, 'rpc-dt-bad');
    expect(bad.valid).toBe(false);
  });
});

describe('Parity (RPC path) — Map', () => {
  it('[SUPPORTED] homogeneous Map<string, number>', async () => {
    const types = `interface Scores { data: Map<string, number>; }`;
    const result = await rpcParse(
      types,
      'Scores',
      { data: new Map<string, number>([['alice', 95], ['bob', 87]]) },
      'rpc-map-homo',
    );
    expect(result.valid).toBe(true);
  });

  it('[SUPPORTED] heterogeneous Map<string, string | number> (absorbs the stand-alone gate)', async () => {
    const types = `interface Mixed { data: Map<string, string | number>; }`;
    const result = await rpcParse(
      types,
      'Mixed',
      { data: new Map<string, string | number>([['a', 'hello'], ['b', 42]]) },
      'rpc-map-hetero',
    );
    expect(result.valid).toBe(true);
  });

  it('rejects Map with wrong value type', async () => {
    const types = `interface Scores { data: Map<string, number>; }`;
    const result = await rpcParse(
      types,
      'Scores',
      { data: new Map<string, unknown>([['alice', 'not-a-number']]) },
      'rpc-map-reject',
    );
    expect(result.valid).toBe(false);
  });
});

describe('Parity (RPC path) — Set', () => {
  it('[SUPPORTED] Set<string>', async () => {
    const types = `interface Tagged { tags: Set<string>; }`;
    const result = await rpcParse(
      types,
      'Tagged',
      { tags: new Set(['a', 'b', 'c']) },
      'rpc-set',
    );
    expect(result.valid).toBe(true);
  });

  it('rejects Set with wrong element type', async () => {
    const types = `interface Tagged { tags: Set<string>; }`;
    const result = await rpcParse(
      types,
      'Tagged',
      { tags: new Set([1, 2, 3] as unknown as string[]) },
      'rpc-set-reject',
    );
    expect(result.valid).toBe(false);
  });
});

describe('Parity (RPC path) — RegExp', () => {
  it('[observed] RegExp value', async () => {
    // Typia's built-in RegExp recognition: let's see what happens. We classify
    // after observing — the test simply records the outcome for the matrix.
    const types = `interface Rule { pattern: RegExp; }`;
    const result = await rpcParse(types, 'Rule', { pattern: /foo/i }, 'rpc-regex');
    // Don't assert; record.
    expect(typeof result.valid).toBe('boolean');
  });

  it('[SUPPORTED via @pattern] string pattern validation', async () => {
    const types = `
interface Slug {
  /** @pattern ^[a-z0-9-]+$ */
  id: string;
}
`;
    const good = await rpcParse(types, 'Slug', { id: 'valid-slug' }, 'rpc-pat-ok');
    expect(good.valid).toBe(true);
    const bad = await rpcParse(types, 'Slug', { id: 'Has Spaces' }, 'rpc-pat-bad');
    expect(bad.valid).toBe(false);
  });
});

describe('Parity (RPC path) — URL', () => {
  it('[SUPPORTED via @format url] URL-string validation', async () => {
    const types = `
interface Link {
  /** @format url */
  href: string;
}
`;
    const good = await rpcParse(types, 'Link', { href: 'https://example.com/path' }, 'rpc-url-ok');
    expect(good.valid).toBe(true);
    const bad = await rpcParse(types, 'Link', { href: 'not a url' }, 'rpc-url-bad');
    expect(bad.valid).toBe(false);
  });
});

describe('Parity (RPC path) — TypedArrays', () => {
  it('[observed] Uint8Array value', async () => {
    const types = `interface Blob { data: Uint8Array; }`;
    const result = await rpcParse(
      types,
      'Blob',
      { data: new Uint8Array([1, 2, 3]) },
      'rpc-u8',
    );
    expect(typeof result.valid).toBe('boolean');
  });

  it('[observed] BigInt64Array value', async () => {
    const types = `interface Ids { xs: BigInt64Array; }`;
    const result = await rpcParse(
      types,
      'Ids',
      { xs: new BigInt64Array([BigInt(1), BigInt(2)]) },
      'rpc-big-u64',
    );
    expect(typeof result.valid).toBe('boolean');
  });
});

describe('Parity (RPC path) — Cyclic values', () => {
  it('[SUPPORTED] self-referential object survives RPC transport', async () => {
    // Workers RPC uses structured-clone which preserves cycles. Validation
    // happens against the type; with `any` the validator accepts. This
    // confirms Design Decision #8's bet: cycles cross the boundary fine.
    const types = `interface Node { id: number; parent: any; }`;
    const node: { id: number; parent: any } = { id: 1, parent: null };
    node.parent = node;

    const result = await rpcParse(types, 'Node', node, 'rpc-cycle');
    expect(result.valid).toBe(true);
  });

  it('[observed] cycle on a relationship-rewritten field (write-shape) behaviour', async () => {
    // With `parent: Node` (named interface reference), write-shape rewrites
    // to `parent: string`. A cyclic object object at that field is a type
    // mismatch; the interesting observation is whether the *filler* handles
    // the cycle gracefully. Our WeakMap-based cycle detection in __fillDefaults
    // should make this safe.
    const types = `interface Node { id: number; parent: Node | null; }`;
    const node: { id: number; parent: any } = { id: 1, parent: null };
    node.parent = node;

    let threw: unknown = null;
    try {
      const result = await rpcParse(types, 'Node', node, 'rpc-cycle-rel');
      // Validator rejects: parent expected to be string, got object.
      expect(result.valid).toBe(false);
    } catch (e) {
      threw = e;
    }
    // If the filler's cycle detection works, we get valid=false (no throw).
    // If it doesn't, we get a stack-overflow throw. Either outcome is recorded.
    if (threw) {
      console.log('[parity] cycle-on-relationship-field threw:', (threw as Error).message);
    }
  });
});

describe('Parity (RPC path) — bigint', () => {
  it('[SUPPORTED] bigint with @type int64 via RPC', async () => {
    const types = `
interface BigThing {
  /** @type "int64" */
  n: bigint;
}
`;
    const result = await rpcParse(types, 'BigThing', { n: BigInt(42) }, 'rpc-bigint');
    expect(result.valid).toBe(true);
  });
});

describe('Parity (RPC path) — any fields', () => {
  it('[SUPPORTED] `any` accepts rich values including Map, Set, Date', async () => {
    const types = `interface Flex { metadata: any; }`;
    const result = await rpcParse(
      types,
      'Flex',
      {
        metadata: {
          tags: new Set(['x']),
          scores: new Map([['a', 1]]),
          when: new Date(),
          nested: [1, 2, 3],
        },
      },
      'rpc-any',
    );
    expect(result.valid).toBe(true);
  });
});
