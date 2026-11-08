/**
 * Each committed transaction gets one moment, and every op it commits is a snapshot stamped with it.
 *
 * Real login (ADR-009 rung 1) on the run's shared app; every `validFrom` asserted is one the running
 * Galaxy stamped, so there is no fixture to build in a safe shape. Each limb runs whether or not an
 * earlier one failed, and the scenario fails at the end naming every limb that did, so a red on one
 * limb never hides another. Each limb names the change that reds it.
 */
import assert from 'node:assert/strict';
import { CHAT_NODE_ID } from '@lumenize/nebula/client';
import type { Snapshot } from '@lumenize/resources/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { sharedApp } from '../lib/shared-app';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const app = await sharedApp(stack, readDevVar('TEST_TOKEN'));
  const driver = await connectDriver(stack, { scope: app.galaxy, email: app.ownerEmail });
  const { client } = driver;

  const read = async (id: string): Promise<Snapshot> => {
    const snap = (await client.resources.read('Chat', id)) as Snapshot | null;
    assert.ok(snap, `Chat ${id} should read back`);
    return snap;
  };
  const commit = async (ops: Parameters<typeof client.resources.transaction>[0], what: string) => {
    const out = await client.resources.transaction(ops);
    assert.equal(out.kind, 'committed', `${what} should commit, got kind=${out.kind}`);
    return out;
  };
  const failures: string[] = [];
  const limb = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
      console.log(`  ✗ ${name}: ${(err as Error).message}`);
    }
  };

  try {
    const a = crypto.randomUUID();
    await commit({ [a]: { op: 'create', typeName: 'Chat', nodeId: CHAT_NODE_ID, value: { title: 'moment a0' } } }, 'create a');

    // Limb 1. Coalescing used to overwrite a same-person write within the hour in place, keeping
    // its validFrom. Mutation: restore the in-place UPDATE in `#writeSnapshot`.
    await limb('every write is a snapshot', async () => {
      const before = await read(a);
      await commit({ [a]: { op: 'put', typeName: 'Chat', eTag: before.meta.eTag, value: { title: 'moment a1' } } }, 'first put');
      const first = await read(a);
      await new Promise((r) => setTimeout(r, 1000));
      await commit({ [a]: { op: 'put', typeName: 'Chat', eTag: first.meta.eTag, value: { title: 'moment a2' } } }, 'second put');
      const second = await read(a);
      assert.ok(second.meta.validFrom > first.meta.validFrom,
        `the second put must open a later snapshot: ${first.meta.validFrom} then ${second.meta.validFrom}`);
    });

    // Limb 2. A put that would have coalesced and a create, in one transaction, share one moment.
    // Mutation: restore the in-place UPDATE (the put keeps its old validFrom).
    const b = crypto.randomUUID();
    await limb('one moment per transaction', async () => {
      const current = await read(a);
      await commit({
        [a]: { op: 'put', typeName: 'Chat', eTag: current.meta.eTag, value: { title: 'moment a3' } },
        [b]: { op: 'create', typeName: 'Chat', nodeId: CHAT_NODE_ID, value: { title: 'moment b0' } },
      }, 'put a + create b');
      const [aNow, bNow] = [await read(a), await read(b)];
      assert.equal(aNow.meta.validFrom, bNow.meta.validFrom,
        `both resources must carry the transaction's moment: a=${aNow.meta.validFrom} b=${bNow.meta.validFrom}`);
    });

    // Limb 3. A move to the node the resource is already on writes a snapshot like any op.
    // Mutation: restore Step 10's same-node skip.
    await limb('a move to the node it is on is a write', async () => {
      const before = await read(a);
      assert.equal(before.meta.nodeId, CHAT_NODE_ID, 'fixture guard: a sits on the chat node');
      await commit({ [a]: { op: 'move', typeName: 'Chat', nodeId: CHAT_NODE_ID, eTag: before.meta.eTag } }, 'same-node move');
      const after = await read(a);
      assert.ok(after.meta.validFrom > before.meta.validFrom,
        `the move must open a later snapshot: ${before.meta.validFrom} then ${after.meta.validFrom}`);
    });

    if (failures.length > 0) {
      throw new Error(`${failures.length} limb(s) failed:\n  - ${failures.join('\n  - ')}`);
    }
  } finally {
    driver.dispose();
  }
}
