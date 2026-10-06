/**
 * `lmz.broadcast` — one continuation to many targets, one `lmz.call` each, from the node that
 * decided to push — driven from each node type that carries it: a DO, a Worker and a client.
 *
 * ⓘ **Why this needs no running system** (`testing.md` § *Philosophy*): no Nebula code broadcasts
 * from a Worker or a client, so this file is the only place those two nodes' `broadcast` runs at
 * all, and nothing about it depends on Nebula. The Nebula paths have their own witnesses: the
 * Profile's fan-out in `profile-subscribe.test.ts`, the data-plane hosts' reapers in
 * `nebula-client-disconnect-cleanup.test.ts`, and the `/live` registry.
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { LumenizeClient } from '../src/lumenize-client';
import { createTestRefreshFunction } from '../src/create-test-refresh-function';
import type { TestDO } from './test-worker-and-dos';

/** A client whose `onResult` handler records every result it receives. It comes back filled, so no `@mesh()`. */
class BroadcastClient extends LumenizeClient {
  outcomes: unknown[] = [];

  recordOutcome(result?: unknown): void {
    this.outcomes.push(result);
  }
}

/** A connected client for `sub`, through the test worker's real Gateway route. */
async function connectClient(sub: string = crypto.randomUUID()): Promise<BroadcastClient> {
  const browser = new Browser();
  const client = new BroadcastClient({
    instanceName: `${sub}.tab1`,
    baseUrl: 'https://localhost',
    refresh: createTestRefreshFunction({ sub }),
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

/** Wait for a target DO to record the context its broadcast push arrived with. */
async function observedAt(instanceName: string): Promise<any> {
  const target = env.TEST_DO.getByName(instanceName);
  return vi.waitFor(async () => {
    const observed = await target.getObservedContext();
    expect(observed).toBeDefined();
    return observed;
  }, { timeout: 10000 });
}

describe('lmz.broadcast', () => {
  it('from a DO: each never-connected Gateway target reports ClientDisconnectedError once, naming itself', async () => {
    const origin = env.TEST_DO.getByName('bcast-do-gateways');
    await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'bcast-do-gateways' });

    await origin.broadcastToGateways(['nobody.tab1', 'nobody.tab2']);

    await vi.waitFor(async () => expect(await origin.getBroadcastOutcomes()).toHaveLength(2));
    const outcomes = await origin.getBroadcastOutcomes();
    expect(outcomes.map((o) => o.name)).toEqual(['ClientDisconnectedError', 'ClientDisconnectedError']);
    expect(outcomes.map((o) => o.callee).sort()).toEqual(['nobody.tab1', 'nobody.tab2']);
  });

  it('from a Worker: the same, through the Worker factory\'s broadcast', async () => {
    const store = env.TEST_DO.getByName('bcast-worker-store');
    await store.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'bcast-worker-store' });

    await env.TEST_WORKER.broadcastToGateways(['nobody.tab3', 'nobody.tab4'], 'bcast-worker-store');

    await vi.waitFor(async () => expect(await store.getBroadcastOutcomes()).toHaveLength(2));
    const outcomes = await store.getBroadcastOutcomes();
    expect(outcomes.map((o) => o.name)).toEqual(['ClientDisconnectedError', 'ClientDisconnectedError']);
    expect(outcomes.map((o) => o.callee).sort()).toEqual(['nobody.tab3', 'nobody.tab4']);
  });

  it('from a client, to two DO targets where one throws: the handler fires once, with that Error', async () => {
    using client = await connectClient();

    client.lmz.broadcast(
      [
        { bindingName: 'TEST_DO', instanceName: 'bcast-client-ok' },
        { bindingName: 'TEST_DO', instanceName: 'bcast-client-throws' },
      ],
      client.ctn<TestDO>().throwIfNamed('bcast-client-throws'),
      { onResult: client.ctn().recordOutcome() },
    );

    await vi.waitFor(() => expect(client.outcomes).toHaveLength(1), { timeout: 10000 });
    // Barrier: a call to the target that succeeded, sent after the broadcast. By the time its
    // answer lands, a success the broadcast reported would have landed too.
    await client.lmz.callAsync('TEST_DO', 'bcast-client-ok', client.ctn<TestDO>().remoteEcho('barrier'));
    expect(client.outcomes).toHaveLength(1);
    expect(client.outcomes[0]).toBeInstanceOf(Error);
    expect((client.outcomes[0] as Error).message).toBe('refused by bcast-client-throws');
  });

  it('a DO target that succeeds: its onResult never fires', async () => {
    const origin = env.TEST_DO.getByName('bcast-success-origin');
    await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'bcast-success-origin' });

    await origin.broadcastThenBarrier('bcast-success-target');

    await vi.waitFor(async () => expect(await origin.getBroadcastBarrier()).toBe(true));
    expect(await origin.getBroadcastOutcomes()).toEqual([]);
  });

  it('a DO target that throws after acking: the handler gets the Error, and callee names that target', async () => {
    const origin = env.TEST_DO.getByName('bcast-throw-origin');
    await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'bcast-throw-origin' });

    await origin.broadcastCall(['bcast-throw-target'], 'throwError');

    await vi.waitFor(async () => expect(await origin.getBroadcastOutcomes()).toHaveLength(1));
    // The Error came back to this node's fire-back door, where `callee` is the fire-back's last
    // hop: the target that threw, not the broadcaster.
    expect((await origin.getBroadcastOutcomes())[0]).toEqual({
      name: 'Error', message: 'Remote error for testing', callee: 'bcast-throw-target',
    });
  });

  describe('the chain each target sees', () => {
    // A push speaks for the node that sends it, so the default carries nothing of the caller's. A
    // client origin makes the difference visible: an inherited chain would name its tab first and
    // carry its `originAuth`.
    it('by default, starts a one-element chain at the broadcaster, carrying no originAuth', async () => {
      using client = await connectClient();

      client.lmz.call('TEST_DO', 'bcast-chain-origin-1',
        client.ctn<TestDO>().broadcastCaptureContext(['bcast-chain-target-1'], {}),
        client.ctn<BroadcastClient>().recordOutcome(), { onErrorOnly: true });

      const observed = await observedAt('bcast-chain-target-1');
      expect(observed.callChain.map((n: { instanceName?: string }) => n.instanceName))
        .toEqual(['bcast-chain-origin-1']);
      expect(observed.originAuth).toBeUndefined();
    });

    it('with newChain: false, inherits the caller\'s chain and originAuth', async () => {
      const sub = crypto.randomUUID();
      using client = await connectClient(sub);

      client.lmz.call('TEST_DO', 'bcast-chain-origin-2',
        client.ctn<TestDO>().broadcastCaptureContext(['bcast-chain-target-2'], { newChain: false }),
        client.ctn<BroadcastClient>().recordOutcome(), { onErrorOnly: true });

      const observed = await observedAt('bcast-chain-target-2');
      expect(observed.callChain.map((n: { instanceName?: string }) => n.instanceName))
        .toEqual([`${sub}.tab1`, 'bcast-chain-origin-2']);
      expect(observed.originAuth?.sub).toBe(sub);
    });
  });
});
