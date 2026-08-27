/**
 * Child 3 Phase 1 — the fixed default Session (D-session).
 *
 * `Galaxy.ensureSession` lazily + idempotently seeds ONE `Session` Resource at
 * the well-known `DEFAULT_SESSION_ID` under the single `SESSION_NODE_ID`. A fresh
 * sandbox has none; the first ensure creates it; a second ensure is a clean no-op —
 * NOT the "already exists" throw a raw create-on-existing raises (resources.ts) —
 * which matters because `ensureSession` runs at the start of EVERY `chat`. The fixed
 * id needs no discovery lookup: a client subscribes `Message where session ==
 * DEFAULT_SESSION_ID` with the constant alone.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { DEFAULT_SESSION_ID, SESSION_NODE_ID } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { universeAdminClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueChatScope = () => `c3s-${crypto.randomUUID().slice(0, 8)}.app`;

  // ⚠️ `universeAdminClient`, not `adminClientAt`: chat lives at the GALAXY tier ({u}.{g})
  // post-collapse, and `adminClientAt` is star-tier only — the covering universe admin is how
  // a galaxy is administered.
function devClient(scope: string, email = 'admin@example.com') {
  return universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, email, 'v1',
    { resourceHostBinding: 'GALAXY' },
  );
}

describe('child3 Phase 1 — fixed default Session (D-session)', () => {
  it('ensureSession idempotently seeds the fixed Session under the single node; the 2nd call does NOT throw "already exists"', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);

    // Fresh sandbox: the default Session does not exist yet.
    expect(await client.resources.read('Session', DEFAULT_SESSION_ID)).toBeNull();

    // First ensure: seeds it, completes without error.
    client.callGalaxyEnsureSession(scope);
    await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    expect(client.lastError).toBeUndefined();

    const first = await client.resources.read('Session', DEFAULT_SESSION_ID) as Snapshot;
    expect(first).not.toBeNull();
    expect(first.meta.nodeId).toBe(SESSION_NODE_ID);                       // single session node (D5)
    expect((first.value as { title?: string }).title).toBe('Studio chat');

    // Second ensure: idempotent. The create-if-absent guard turns what would be a
    // raw create-on-existing THROW ("already exists") into a clean no-op — so this
    // MUST complete without error (capable-of-failing: remove the guard → the 2nd
    // create throws → lastError set → red) and create NO new snapshot.
    client.callGalaxyEnsureSession(scope);
    await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    expect(client.lastError).toBeUndefined();
    const second = await client.resources.read('Session', DEFAULT_SESSION_ID) as Snapshot;
    expect(second.meta.eTag).toBe(first.meta.eTag);                        // not recreated
    expect(second.meta.validFrom).toBe(first.meta.validFrom);

    client[Symbol.dispose]();
  });

  it('the fixed id needs no discovery: subscribeQuery(Message where session==DEFAULT_SESSION_ID) tracks a Message on the session node', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);

    using sub = client.resources.subscribeQuery({
      queryType: 'parentChild', typeName: 'Message', field: 'session', value: DEFAULT_SESSION_ID,
    });
    await sub.ready;
    expect(sub.resourceIds).toEqual([]);

    // Create a Message FK'd to the fixed session id, under the single session node.
    // Exercises the enriched ontology too (the optional `author` field validates).
    const m1 = crypto.randomUUID();
    await client.resources.transaction({
      [m1]: {
        op: 'create', typeName: 'Message', nodeId: SESSION_NODE_ID,
        value: { session: DEFAULT_SESSION_ID, role: 'user', content: 'hello', author: 'admin@example.com' },
      },
    });
    await vi.waitFor(() => expect(sub.resourceIds).toEqual([m1]));

    const snap = await client.resources.read('Message', m1) as Snapshot;
    expect(snap.meta.nodeId).toBe(SESSION_NODE_ID);                        // shares the single session node
    expect((snap.value as { author?: string }).author).toBe('admin@example.com');

    client[Symbol.dispose]();
  });
});
