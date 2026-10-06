/**
 * `NebulaClient` re-subscribes on the two signals that something was lost, and on nothing else.
 *
 * In-lane rather than `/live` for the reasons each limb gives: no product path demotes an admin
 * yet, and the rotation half needs a token to lapse, which `vi.setSystemTime` does for the Worker
 * and every Durable Object at once. The live limbs that need no such step are in
 * `resubscribe-when-lost`.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { REGISTRY_INSTANCE_NAME } from '@lumenize/nebula-auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionResult } from '@lumenize/nebula';
import { adminClientAt, pageOf } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
}

/** Close a client's socket from inside its Gateway, as the network would. */
async function closeFromGateway(client: NebulaClientTest, code: number): Promise<void> {
  const gateway = (env as any).NEBULA_CLIENT_GATEWAY.get((env as any).NEBULA_CLIENT_GATEWAY.idFromName(client.lmz.instanceName));
  await (runInDurableObject as any)(gateway, (_instance: unknown, ctx: DurableObjectState) => {
    for (const ws of ctx.getWebSockets()) ws.close(code, 'closed by the test');
  });
}

/** The Star's resource subscriber rows: the server-internal state a re-subscribe rewrites. */
async function resourceRows(star: string): Promise<Array<{ clientAddress: string; dominion: number; subscribedAt: string }>> {
  return (runInDurableObject as any)((env as any).STAR.getByName(star), (_i: unknown, ctx: DurableObjectState) =>
    ctx.storage.sql.exec(`SELECT clientAddress, dominionOverHostAtSubscribe AS dominion, subscribedAt
      FROM Subscriptions WHERE kind = 'resource'`).toArray());
}

describe('NebulaClient re-subscribes when something was lost', () => {
  // In-lane because no product path demotes an admin yet.
  it('a new token whose scopeAdmin drops under the same sub re-subscribes, on the socket that token opens', async () => {
    const star = uniqueStar();
    const { client: a } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    a.callStarInstallOntology(star, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
    await vi.waitFor(() => expect(a.callCompleted).toBe(true));
    const resourceId = crypto.randomUUID();
    a.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'x' } },
    });
    await vi.waitFor(() => expect(a.callCompleted).toBe(true));
    expect((a.lastResult as TransactionResult).ok).toBe(true);
    await a.resources.subscribe('TestResource', resourceId).snapshot;
    expect((await resourceRows(star)).map((r) => r.dominion)).toEqual([1]);

    const claims = a.claims!;
    await (env as any).NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME).setIdentityAdmin(claims.sub, false, claims);

    // The token lapses, so the next call rotates the socket on a freshly minted one.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 20 * 60_000);
      // The org tree, which every member may read (ADR-008): a read of the resource now needs a grant.
      await a.lmz.callAsync('STAR', star, (a.ctn() as any).resources.orgTree.getState());
      // MUTATION: skip the scopeAdmin comparison, and the row keeps the admin verdict.
      await vi.waitFor(async () => expect((await resourceRows(star)).map((r) => r.dominion)).toEqual([0]), { timeout: 10_000 });
    } finally {
      vi.useRealTimers();
    }
    a[Symbol.dispose]();
  }, 60_000);

  // The re-send matters on a reconnect told nothing was lost, which in this project's 100 ms grace
  // period only a supersede gets: a token rotation's new socket replaces the old one.
  it('a subscribe whose frame was lost is sent again on a reconnect told nothing was lost', async () => {
    const star = uniqueStar();
    const { client: a } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    a.callStarInstallOntology(star, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
    await vi.waitFor(() => expect(a.callCompleted).toBe(true));
    const resourceId = crypto.randomUUID();
    a.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'kept' } },
    });
    await vi.waitFor(() => expect(a.callCompleted).toBe(true));

    // A tab whose socket can lose the next call frame it sends.
    const browser = new Browser();
    const Base = browser.context(pageOf(star)).WebSocket;
    let dropNextCall = false;
    class Dropping extends Base {
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (dropNextCall && typeof data === 'string' && JSON.parse(data).type === 'call') { dropNextCall = false; return; }
        super.send(data);
      }
    }
    const { client: b } = await adminClientAt(NebulaClientTest, browser, star, star, 'admin@example.com', ONTOLOGY_VERSION,
      { WebSocket: Dropping as unknown as typeof WebSocket });
    dropNextCall = true;
    const subscription = b.resources.subscribe('TestResource', resourceId);
    await vi.waitFor(() => expect(dropNextCall).toBe(false)); // the subscribe's frame was lost

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 20 * 60_000);
      await b.lmz.callAsync('STAR', star, (b.ctn() as any).resources.orgTree.getState());
      // MUTATION: drop the pending re-send, and the snapshot never arrives.
      const snapshot = await Promise.race([
        subscription.snapshot,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
      expect(snapshot?.value).toEqual({ title: 'kept' });
    } finally {
      vi.useRealTimers();
    }
    a[Symbol.dispose]();
    b[Symbol.dispose]();
  }, 60_000);

  // An explicit `disconnect()` and `connect()` is not a `reconnecting → connected` transition, and
  // a connect this quick lands inside the grace period, so the Gateway reports nothing lost.
  it('a subscribe whose frame was lost is sent again when a disconnected client connects again', async () => {
    const star = uniqueStar();
    const { client: a } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    a.callStarInstallOntology(star, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
    await vi.waitFor(() => expect(a.callCompleted).toBe(true));
    const resourceId = crypto.randomUUID();
    a.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'again' } },
    });
    await vi.waitFor(() => expect(a.callCompleted).toBe(true));

    const browser = new Browser();
    const Base = browser.context(pageOf(star)).WebSocket;
    let dropNextCall = false;
    const told: boolean[] = [];
    class Dropping extends Base {
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (dropNextCall && typeof data === 'string' && JSON.parse(data).type === 'call') { dropNextCall = false; return; }
        super.send(data);
      }
      override dispatchEvent(event: Event): boolean {
        if (event.type === 'message') {
          try {
            const frame = JSON.parse(String((event as MessageEvent).data));
            if (frame.type === 'connection_status') told.push(frame.subscriptionRequired);
          } catch { /* a heartbeat pong is not JSON */ }
        }
        return super.dispatchEvent(event);
      }
    }
    const { client: b } = await adminClientAt(NebulaClientTest, browser, star, star, 'admin@example.com', ONTOLOGY_VERSION,
      { WebSocket: Dropping as unknown as typeof WebSocket });
    dropNextCall = true;
    const subscription = b.resources.subscribe('TestResource', resourceId);
    await vi.waitFor(() => expect(dropNextCall).toBe(false)); // the subscribe's frame was lost

    b.disconnect();
    b.connect();
    // MUTATION: run the restore only on `reconnecting → connected`, and the snapshot never arrives.
    const snapshot = await Promise.race([
      subscription.snapshot,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    expect(snapshot?.value).toEqual({ title: 'again' });
    // Fixture guard: the Gateway reported nothing lost, so no full restore sent the snapshot.
    expect(told.at(-1)).toBe(false);
    a[Symbol.dispose]();
    b[Symbol.dispose]();
  }, 60_000);

  it('the org tree is re-subscribed when the Gateway reports a loss, and not on a token rotation', async () => {
    const star = uniqueStar();
    const { client } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    let trees = 0;
    client.onOrgTreeUpdate(() => { trees += 1; });

    // This project's grace period is 100 ms, so a reconnect after the 1 s backoff is told
    // `subscriptionRequired: true`. MUTATION: leave the tree out of the walk, and none arrives.
    await closeFromGateway(client, 4000);
    await vi.waitFor(() => expect(client.connectionState).toBe('reconnecting'));
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10_000 });
    await vi.waitFor(() => expect(trees).toBe(1));

    // A rotation opens a new socket that supersedes the old one, and is told `false`.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 20 * 60_000);
      await client.lmz.callAsync('STAR', star, (client.ctn() as any).resources.orgTree.getState());
      // A second round trip on the new socket, so a tree subscribe the rotation sent has answered.
      await client.lmz.callAsync('STAR', star, (client.ctn() as any).resources.orgTree.getState());
    } finally {
      vi.useRealTimers();
    }
    // MUTATION: restore the blanket re-subscribe on reconnect, and the rotation brings a second tree.
    expect(trees).toBe(1);
    client[Symbol.dispose]();
  }, 60_000);
});
