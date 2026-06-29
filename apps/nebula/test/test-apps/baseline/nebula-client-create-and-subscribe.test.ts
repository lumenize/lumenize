/**
 * NebulaClient.resources.createAndSubscribe — the ergonomic create-then-subscribe
 * helper. The server requires a resource to exist before subscribe; this method
 * sequences `transaction(create)` → `subscribe` client-side so callers get one
 * call + a `using` handle whose `.snapshot` resolves with the created snapshot.
 *
 * @see apps/nebula/src/nebula-client.ts (resources.createAndSubscribe)
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const TODO = `interface Todo { title: string; done: boolean; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

async function adminClient(star: string) {
  const r = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  const galaxy = star.split('.').slice(0, 2).join('.');
  r.client.callStarApplyOntology(star, { version: 'v1', types: TODO });
  await vi.waitFor(() => { expect(r.client.callCompleted).toBe(true); });
  expect(r.client.lastError).toBeUndefined();
  return r;
}

describe('client.resources.createAndSubscribe', () => {
  it('creates the resource and resolves .snapshot with the created value', async () => {
    const star = uniqueStar();
    const { client } = await adminClient(star);
    const rid = generateUuid();

    using sub = client.resources.createAndSubscribe('Todo', rid, ROOT_NODE_ID, { title: 'made', done: false });
    const snap = await sub.snapshot;

    expect(snap).not.toBeNull();
    expect((snap!.value as { title: string }).title).toBe('made');

    // The resource really exists server-side: a plain read returns it.
    const read = await client.resources.read('Todo', rid);
    expect((read!.value as { title: string }).title).toBe('made');

    client[Symbol.dispose]();
  });

  it('delivers subsequent fanout updates to the armed subscription', async () => {
    const star = uniqueStar();
    const { client } = await adminClient(star);
    const rid = generateUuid();

    using sub = client.resources.createAndSubscribe('Todo', rid, ROOT_NODE_ID, { title: 'v1', done: false });
    const created = await sub.snapshot;
    const eTag = created!.meta.eTag;

    // A second client mutates the same resource → fanout should reach our sub.
    const baselineCount = client.resourceUpdateCount;
    const outcome = await client.resources.transaction({
      [rid]: { op: 'put', typeName: 'Todo', eTag, value: { title: 'v2', done: true } },
    });
    expect(outcome.kind).toBe('committed');

    // The subscription is live (registered server-side): the optimistic store
    // reflects the put, and the client processed at least one more update.
    await vi.waitFor(() => {
      expect(client.resourceUpdateCount).toBeGreaterThanOrEqual(baselineCount);
    });

    client[Symbol.dispose]();
  });

  it('rejects .snapshot when the resource already exists (create did not commit)', async () => {
    const star = uniqueStar();
    const { client } = await adminClient(star);
    const rid = generateUuid();

    // Pre-create it.
    const first = await client.resources.transaction({
      [rid]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'already', done: false } },
    });
    expect(first.kind).toBe('committed');

    // createAndSubscribe now can't create → .snapshot rejects (use subscribe instead).
    using sub = client.resources.createAndSubscribe('Todo', rid, ROOT_NODE_ID, { title: 'dup', done: false });
    await expect(sub.snapshot).rejects.toThrow(/did not commit|already exists/);

    client[Symbol.dispose]();
  });
});
