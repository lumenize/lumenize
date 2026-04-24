/**
 * Smoke tests for visit-tracking modification in the vendored typia copy.
 *
 * These confirm Phase 2 of tasks/typia-visit-tracking.md: generated validators
 * accept cycles at any field position (optional, nullable, or non-nullable)
 * and skip re-walking aliased subtrees without stack-overflowing.
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
  it('accepts self-referential cycle at optional field', async () => {
    const types = `interface Node { name: string; parent?: Node; }`;
    const a: any = { name: 'a' };
    a.parent = a;
    const result = await rpcParse(types, 'Node', a, 'cycle-optional');
    expect(result.valid).toBe(true);
  });

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
  left?: Leaf;
  right?: Leaf;
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
    const types = `interface Node { name: string; parent?: Node; }`;
    const a: any = { name: 42 }; // name should be string
    a.parent = a;
    const result = await rpcParse(types, 'Node', a, 'cycle-invalid');
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.expected === 'string')).toBe(true);
  });

  it('accepts mutual recursion (A references B references A)', async () => {
    const types = `
interface A { name: string; b?: B; }
interface B { id: string; a?: A; }
`;
    const a: any = { name: 'a' };
    const b: any = { id: 'b', a };
    a.b = b;
    const result = await rpcParse(types, 'A', a, 'mutual-cycle');
    expect(result.valid).toBe(true);
  });

  it('DAG: shared node validated once (visit-tracking dedup)', async () => {
    // Getter-instrumented `shared` appears under two branches. Typia's
    // generated validator accesses `id` once per helper entry. With
    // visit-tracking, the second entry short-circuits before reading `id`.
    const types = `
interface Root { id: number; children: Node[]; }
interface Node { id: number; children: Node[]; }
`;
    let idReads = 0;
    const shared = {
      get id() {
        idReads++;
        return 99;
      },
      children: [] as unknown[],
    };
    const root = {
      id: 1,
      children: [
        { id: 2, children: [shared] },
        { id: 3, children: [shared] },
      ],
    };
    const result = await rpcParse(types, 'Root', root, 'dag-counter');
    expect(result.valid).toBe(true);
    // Measured: exactly 1. Workers RPC preserves object references without
    // re-reading properties (so the getter is not invoked in transit), and
    // typia's modified validator walks `shared` once thanks to visit-tracking.
    // Without the modification this is 2 (one walk per parent branch).
    expect(idReads).toBe(1);
  });
});
