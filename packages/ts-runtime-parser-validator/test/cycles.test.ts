/**
 * Smoke tests for visit-tracking modification in the vendored typia copy.
 *
 * These confirm Phase 2 of tasks/typia-visit-tracking.md: generated validators
 * accept cycles at any field position (nullable or non-nullable) and skip
 * re-walking aliased subtrees without stack-overflowing.
 *
 * Full cycle + alias test coverage lives in the parent task
 * (nebula-5.2.4.1-validator-engine-upgrade.md Phase 6.7). This file is the
 * narrow regression signal for the fork itself.
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

describe('Visit-tracking (cycles + aliases)', () => {
  it('accepts self-referential cycle at nullable field', async () => {
    const types = `interface Node { name: string; parent: Node | null; }`;
    const a: any = { name: 'a', parent: null };
    a.parent = a;
    const result = await rpcParse(types, 'Node', a, 'cycle-nullable');
    expect(result.valid).toBe(true);
  });

  it('accepts self-referential cycle at non-nullable field', async () => {
    const types = `interface Node { name: string; parent: Node; }`;
    const a: any = { name: 'a' };
    a.parent = a;
    const result = await rpcParse(types, 'Node', a, 'cycle-nonnullable');
    expect(result.valid).toBe(true);
  });

  it('accepts aliased subtree (DAG) without re-walking', async () => {
    const types = `
interface Tree {
  name: string;
  left: Leaf | null;
  right: Leaf | null;
}
interface Leaf {
  id: string;
}
`;
    const shared = { id: 'shared-leaf' };
    const root = { name: 'root', left: shared, right: shared };
    const result = await rpcParse(types, 'Tree', root, 'alias-dag');
    expect(result.valid).toBe(true);
  });

  it('rejects cycle where the shared node itself is invalid', async () => {
    const types = `interface Node { name: string; parent: Node | null; }`;
    const a: any = { name: 42, parent: null }; // name should be string
    a.parent = a;
    const result = await rpcParse(types, 'Node', a, 'cycle-invalid');
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.expected === 'string')).toBe(true);
  });

  it('accepts mutual recursion (A references B references A)', async () => {
    const types = `
interface A { name: string; b: B | null; }
interface B { id: string; a: A | null; }
`;
    const a: any = { name: 'a', b: null };
    const b: any = { id: 'b', a };
    a.b = b;
    const result = await rpcParse(types, 'A', a, 'mutual-cycle');
    expect(result.valid).toBe(true);
  });
});
