/**
 * A host that builds its own tree in `onStart`, and a write made as the host's agent principal.
 *
 * These run here rather than against a running stack for two reasons. The rows a construction
 * writes are visible only to a counter inside the object, and a write as an agent principal has
 * no caller but a host's own code, so a fixture on the host stands for it. `galaxy-builds-its-tree`
 * reads the tree a real Galaxy builds, through real logins.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { SelfBuildingHostDO } from './test-worker';
import { BARE_NODE_ID, GRANTED_NODE_ID, HOST_PRINCIPAL } from './test-worker';

const CREATED = '{"outcome":"created"}';
const EXISTING = '{"outcome":"existing"}';

/** A host under a name of its own. Its first call constructs it, so `onStart` has run by then. */
function unstamped(): DurableObjectStub<SelfBuildingHostDO> {
  return env.SELF_BUILDING.getByName(`built-${crypto.randomUUID().slice(0, 8)}`);
}

/** The same, with its name stamped as a first mesh entry would stamp it. */
async function builtHost(): Promise<DurableObjectStub<SelfBuildingHostDO>> {
  const name = `built-${crypto.randomUUID().slice(0, 8)}`;
  const stub = env.SELF_BUILDING.getByName(name);
  await stub.initForTest(name);
  return stub;
}

describe('a host that creates its nodes in onStart, as its own system principal', () => {
  // The first call on the stub is the first thing to reach the host, so `onStart` ran at a
  // construction with no stamped name. Mutation: have the plane read the stamped name alone → the
  // host name is absent, the dominion bypass grants nothing, and each create is refused.
  it('finds them on its first call, created with dominion, with the starting grant and no other', async () => {
    const host = unstamped();
    expect(await host.startOutcome('start_granted')).toBe(CREATED);
    expect(await host.startOutcome('start_bare')).toBe(CREATED);
    expect(await host.treeRows()).toEqual({
      slugs: ['bare', 'granted', 'root'],
      grants: [{ nodeId: GRANTED_NODE_ID, sub: HOST_PRINCIPAL, permission: 'write' }],
    });
    // A query in the same block runs too, and finds nothing: it reads the host's name the same way.
    expect(await host.startOutcome('start_query')).toBe('0');
  });

  // Mutation: write a node, its edge or its grant with INSERT OR REPLACE whenever the create is
  // asked → every start rewrites that row → the count is above 0.
  it('writes no rows at a second construction, where each create finds its node there', async () => {
    const host = unstamped();
    expect(await host.startOutcome('start_granted')).toBe(CREATED);
    expect(await host.rowsWrittenBySecondConstruction()).toBe(0);
    expect(await host.startOutcome('start_granted')).toBe(EXISTING);
    expect(await host.startOutcome('start_bare')).toBe(EXISTING);
  });

  // Mutation: have a create put a node it finds back under the parent it names → the start after
  // a move adds the old edge again, and writes a row.
  it('leaves a node an admin has moved where it is, and says it differs', async () => {
    const host = unstamped();
    const moved = await host.moveGrantedUnderBare();
    expect(moved).toContain(`${BARE_NODE_ID}>${GRANTED_NODE_ID}`);
    expect(await host.rowsWrittenBySecondConstruction()).toBe(0);
    expect(await host.edges()).toEqual(moved);
    expect(await host.startOutcome('start_granted')).toBe('{"outcome":"differs"}');
  });

  // A starting grant is written once, with its node. Mutation: write a create's grants for a node
  // that exists → the revoked grant is back, and the count is 1.
  it('does not write a starting grant back once it is gone', async () => {
    const host = unstamped();
    expect((await host.treeRows()).grants).toHaveLength(1);
    await host.dropStartingGrant();
    expect(await host.rowsWrittenBySecondConstruction()).toBe(0);
    expect((await host.treeRows()).grants).toEqual([]);
  });
});

describe('a write as the host\'s agent principal', () => {
  // Mutation, the first half: build an agent principal's claims with `scopeAdmin` → the dominion
  // bypass admits the write at the bare node → `ok` is true and this reds.
  // Mutation, the second half: create `granted` with no starting grant → the write there is refused.
  it('is refused where the principal holds no grant, and lands where it holds one', async () => {
    const host = await builtHost();
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
    expect(await host.recordedSubject(landedId)).toBe(HOST_PRINCIPAL);
  });

  // Mutation: let `ensureResource` drop the transaction's answer, as it once did → a refused write
  // resolves, and the first assertion reads 'created'.
  it('through ensureResource, throws when the write is refused: nothing waits on that call\'s answer', async () => {
    const host = await builtHost();
    const refusedId = crypto.randomUUID();
    const landedId = crypto.randomUUID();
    expect(await host.ensureAsPrincipal(refusedId, BARE_NODE_ID))
      .toBe(`ensureResource refused: write permission required on node ${BARE_NODE_ID}`);
    expect(await host.recordedSubject(refusedId)).toBeUndefined();
    expect(await host.ensureAsPrincipal(landedId, GRANTED_NODE_ID)).toBe('created');
    expect(await host.recordedSubject(landedId)).toBe(HOST_PRINCIPAL);
  });
});
