/**
 * A host's tree seed, and a write made as the host's local principal.
 *
 * These run here rather than against a running stack for two reasons. The rows a construction
 * writes are visible only to a counter inside the object, and no product path writes as a local
 * principal until a Galaxy's agent posts as itself, so a fixture on the host is the only caller.
 * `galaxy-seeds-its-chat` reads the same seed through real logins, and the refusals a protected
 * grant gives a person.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { SeededHostDO } from './test-worker';
import { BARE_NODE_ID, GRANTED_NODE_ID, SEEDED_PRINCIPAL } from './test-worker';

/** A seeded host under a name of its own, stamped as a first mesh entry would stamp it. */
async function seededHost(): Promise<DurableObjectStub<SeededHostDO>> {
  const name = `seeded-${crypto.randomUUID().slice(0, 8)}`;
  const stub = env.SEEDED.getByName(name);
  await stub.initForTest(name);
  return stub;
}

describe('a host\'s tree seed', () => {
  // Mutation: write any of the seed's three inserts (node, edge, grant) with INSERT OR REPLACE →
  // every wake rewrites that row → the count is above 0 and this reds.
  it('is created with the tree, and a second construction writes no rows', async () => {
    const host = await seededHost();

    // First that the seed is there, so "no rows" below cannot mean a seed that never ran.
    expect(await host.seededRows()).toEqual({
      slugs: ['bare', 'granted', 'root'],
      grants: [{ nodeId: GRANTED_NODE_ID, sub: SEEDED_PRINCIPAL, permission: 'write' }],
    });
    expect(await host.rowsWrittenBySecondConstruction()).toBe(0);
  });
});

describe('a write as the host\'s local principal', () => {
  // Mutation, the first half: build a local principal's claims with `scopeAdmin` → the dominion
  // bypass admits the write at the bare node → `ok` is true and this reds.
  // Mutation, the second half: skip the seed's grants → the write at the granted node is refused.
  it('is refused where the principal holds no grant, and lands where it holds one', async () => {
    const host = await seededHost();
    const refusedId = crypto.randomUUID();
    const landedId = crypto.randomUUID();

    const refused = await host.createAsPrincipal(refusedId, BARE_NODE_ID);
    expect(refused).toEqual({
      ok: false,
      errors: { [refusedId]: { type: 'permission', requiredTier: 'write', nodeId: BARE_NODE_ID } },
    });

    const landed = await host.createAsPrincipal(landedId, GRANTED_NODE_ID);
    expect(landed.ok).toBe(true);
    // The principal is the write's subject, with nobody acting for it.
    expect(await host.recordedSubject(landedId)).toBe(SEEDED_PRINCIPAL);
  });

  // Mutation: let `ensureResource` drop the transaction's answer, as it once did → a refused write
  // resolves, and the first assertion reads 'created'.
  it('through ensureResource, throws when the write is refused: nothing waits on that call\'s answer', async () => {
    const host = await seededHost();
    const refusedId = crypto.randomUUID();
    const landedId = crypto.randomUUID();
    expect(await host.ensureAsPrincipal(refusedId, BARE_NODE_ID))
      .toBe(`ensureResource refused: write permission required on node ${BARE_NODE_ID}`);
    expect(await host.recordedSubject(refusedId)).toBeUndefined();
    expect(await host.ensureAsPrincipal(landedId, GRANTED_NODE_ID)).toBe('created');
    expect(await host.recordedSubject(landedId)).toBe(SEEDED_PRINCIPAL);
  });
});
