/**
 * A subscribe that never gets its push must ABANDON, and the refusal that stopped it must be
 * visible on the node that refused.
 *
 * `handleResourceUpdate` is itself what settles a pending subscribe, so anything that stops that
 * handler RUNNING leaves nothing in the client able to settle the promise — no host error arrives,
 * because no host erred. The failure that produced this file was an override without `@mesh()`:
 * the decorator records itself on the function VALUE, so a subclass method shadowing a decorated
 * one carries none of it, the entry rule refuses the push, and the refusal goes onto the wire and
 * nowhere else. `await subscribe(...)` then waits forever. Both halves are asserted here — the
 * bound that turns the hang into a rejection, and the log that names the cause rather than the
 * symptom.
 *
 * ⚠️ The undecorated override below is the defect, written deliberately. `NebulaClientTest`'s own
 * `@mesh() override handleResourceUpdate` is the positive control and is what every other subscribe
 * test rides, so the two differ by the decorator and nothing else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionResult } from '@lumenize/nebula';
import { adminClientAt } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

/** Comfortably past a healthy local push, short enough to wait for in-lane. */
const SHORT_TIMEOUT_MS = 1500;

/**
 * The defect, on purpose: an override with NO `@mesh()`. Its parent's override IS decorated, so
 * the entry rule finds a `@mesh()` method one level up and refuses this one by name.
 */
class UndecoratedOverrideClient extends NebulaClientTest {
  override handleResourceUpdate(
    resourceType: string,
    resourceId: string,
    result: Snapshot | null | Error,
  ): void {
    super.handleResourceUpdate(resourceType, resourceId, result);
  }
}

function uniqueStar(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
}

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => {
    expect(client.callCompleted).toBe(true);
  });
}

/** Found a star, install the ontology, create one resource — so a healthy subscribe HAS a push to get. */
async function starWithOneResource<T extends NebulaClientTest>(
  ClientClass: new (config: any) => T,
  extraConfig?: Record<string, unknown>,
): Promise<{ client: T; star: string; resourceId: string }> {
  const star = uniqueStar();
  const { client } = await adminClientAt(
    ClientClass, new Browser(), star, star, 'admin@example.com', ONTOLOGY_VERSION, extraConfig as any,
  );

  client.callStarInstallOntology(star, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
  await waitForResult(client);

  const resourceId = crypto.randomUUID();
  client.resetResults();
  client.callStarTransaction(star, ONTOLOGY_VERSION, {
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Bounded' } },
  });
  await waitForResult(client);
  const result = client.lastResult as TransactionResult;
  if (!result?.ok) throw new Error(`setup: create failed — ${client.lastError ?? 'no error reported'}`);

  return { client, star, resourceId };
}

describe('a subscribe is bounded, and a refused push says so', () => {
  let entries: DebugLogOutput[];

  beforeEach(() => {
    entries = [];
    setDebugSink((e) => entries.push(e));
  });

  afterEach(() => {
    clearDebugSink();
  });

  it('POSITIVE CONTROL: a `@mesh()` override settles the subscribe', async () => {
    // Same drive as the test below, differing only by the decorator on the override. Without this,
    // the rejection below would pass just as well if the setup itself were broken.
    const { client, resourceId } = await starWithOneResource(NebulaClientTest);

    const snap = await client.resources.subscribe('TestResource', resourceId).snapshot;
    expect(snap).not.toBeNull();
    expect(snap!.value.title).toBe('Bounded');

    client[Symbol.dispose]();
  });

  it('an override WITHOUT `@mesh()`: the subscribe abandons, and the client logs why', async () => {
    const { client, resourceId } = await starWithOneResource(
      UndecoratedOverrideClient, { subscribeTimeoutMs: SHORT_TIMEOUT_MS },
    );

    // (a) THE BOUND. The push is refused at this client's own door, so nothing can settle this
    // promise; before the timeout existed, this line hung for the lifetime of the process.
    await expect(
      client.resources.subscribe('TestResource', resourceId).snapshot,
    ).rejects.toThrow(/never acknowledged/);

    // (b) THE LOG — the only place the CAUSE appears on this node. The rejection above names the
    // symptom (nothing arrived); this names the defect (an override that dropped its `@mesh()`).
    const refusals = entries.filter(
      (e) => e.namespace === 'lmz.mesh.LumenizeClient.#handleIncomingCall',
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].data?.member).toBe('handleResourceUpdate');
    expect(refusals[0].data?.error).toMatch(/overrides a mesh-callable member but is not itself decorated with @mesh\(\)/);

    client[Symbol.dispose]();
  }, 20_000);
});
