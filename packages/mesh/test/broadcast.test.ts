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
import { MeshClient } from '../src/mesh-client';
import type { TestDO } from './test-worker-and-dos';
import { connectClient, loginOf, uniqueScope } from './support/login';

/** A client whose `onResult` handler records every result it receives. It comes back filled, so no `@mesh()`. */
class BroadcastClient extends MeshClient {
  outcomes: unknown[] = [];

  recordOutcome(result?: unknown): void {
    this.outcomes.push(result);
  }
}

/** A real Client on a fresh universe's page. */
const connect = () => connectClient(BroadcastClient);

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
  it('from a DO: each never-connected Client target reports ClientDisconnectedError once, naming itself', async () => {
    const origin = env.TEST_DO.getByName('bcast_do_gateways');
    await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'bcast_do_gateways' });
    const h = uniqueScope('h');

    await origin.broadcastToClients([`${h}/nobody.tab1`, `${h}/nobody.tab2`]);

    await vi.waitFor(async () => expect(await origin.getBroadcastOutcomes()).toHaveLength(2));
    const outcomes = await origin.getBroadcastOutcomes();
    expect(outcomes.map((o) => o.name)).toEqual(['ClientDisconnectedError', 'ClientDisconnectedError']);
    expect(outcomes.map((o) => o.callee).sort()).toEqual([`${h}/nobody.tab1`, `${h}/nobody.tab2`]);
  });

  it('from a Worker: the same, through the Worker factory\'s broadcast', async () => {
    const store = env.TEST_DO.getByName('bcast_worker_store');
    await store.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'bcast_worker_store' });
    const h = uniqueScope('h');

    await env.TEST_WORKER.broadcastToClients([`${h}/nobody.tab3`, `${h}/nobody.tab4`], 'bcast_worker_store');

    await vi.waitFor(async () => expect(await store.getBroadcastOutcomes()).toHaveLength(2));
    const outcomes = await store.getBroadcastOutcomes();
    expect(outcomes.map((o) => o.name)).toEqual(['ClientDisconnectedError', 'ClientDisconnectedError']);
    expect(outcomes.map((o) => o.callee).sort()).toEqual([`${h}/nobody.tab3`, `${h}/nobody.tab4`]);
  });

  it('from a client, to two DO targets where one throws: the handler fires once, with that Error', async () => {
    using client = await connect();

    client.lmz.broadcast(
      [
        { bindingName: 'TEST_DO', instanceName: 'bcast_client_ok' },
        { bindingName: 'TEST_DO', instanceName: 'bcast_client_throws' },
      ],
      client.ctn<TestDO>().throwIfNamed('bcast_client_throws'),
      { onResult: client.ctn().recordOutcome() },
    );

    await vi.waitFor(() => expect(client.outcomes).toHaveLength(1), { timeout: 10000 });
    // Barrier: a call to the target that succeeded, sent after the broadcast. By the time its
    // answer lands, a success the broadcast reported would have landed too.
    await client.lmz.callAsync('TEST_DO', 'bcast_client_ok', client.ctn<TestDO>().remoteEcho('barrier'));
    expect(client.outcomes).toHaveLength(1);
    expect(client.outcomes[0]).toBeInstanceOf(Error);
    expect((client.outcomes[0] as Error).message).toBe('refused by bcast_client_throws');
  });

  it('a DO target that succeeds: its onResult never fires', async () => {
    const origin = env.TEST_DO.getByName('bcast_success_origin');
    await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'bcast_success_origin' });

    await origin.broadcastThenBarrier('bcast_success_target');

    await vi.waitFor(async () => expect(await origin.getBroadcastBarrier()).toBe(true));
    expect(await origin.getBroadcastOutcomes()).toEqual([]);
  });

  it('a DO target that throws after acking: the handler gets the Error, and callee names that target', async () => {
    const origin = env.TEST_DO.getByName('bcast_throw_origin');
    await origin.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'bcast_throw_origin' });

    await origin.broadcastCall(['bcast_throw_target'], 'throwError');

    await vi.waitFor(async () => expect(await origin.getBroadcastOutcomes()).toHaveLength(1));
    // The Error came back to this node's fire-back door, where `callee` is the fire-back's last
    // hop: the target that threw, not the broadcaster.
    expect((await origin.getBroadcastOutcomes())[0]).toEqual({
      name: 'Error', message: 'Remote error for testing', callee: 'bcast_throw_target',
    });
  });

  describe('the chain each target sees', () => {
    // A push speaks for the node that sends it, so the default carries nothing of the caller's. A
    // client origin makes the difference visible: an inherited chain would name its tab first and
    // carry its `originAuth`.
    it('by default, starts a one-element chain at the broadcaster, carrying no originAuth', async () => {
      using client = await connect();

      client.lmz.call('TEST_DO', 'bcast_chain_origin_1',
        client.ctn<TestDO>().broadcastCaptureContext(['bcast_chain_target_1'], {}),
        client.ctn<BroadcastClient>().recordOutcome(), { onErrorOnly: true });

      const observed = await observedAt('bcast_chain_target_1');
      expect(observed.callChain.map((n: { instanceName?: string }) => n.instanceName))
        .toEqual(['bcast_chain_origin_1']);
      expect(observed.originAuth).toBeUndefined();
    });

    it('with newChain: false, inherits the caller\'s chain and originAuth', async () => {
      using client = await connect();
      const { sub, scope } = loginOf(client);

      client.lmz.call('TEST_DO', 'bcast_chain_origin_2',
        client.ctn<TestDO>().broadcastCaptureContext(['bcast_chain_target_2'], { newChain: false }),
        client.ctn<BroadcastClient>().recordOutcome(), { onErrorOnly: true });

      const observed = await observedAt('bcast_chain_target_2');
      expect(observed.callChain.map((n: { instanceName?: string }) => n.instanceName))
        .toEqual([`${scope}/${sub}.tab1`, 'bcast_chain_origin_2']);
      expect(observed.originAuth?.sub).toBe(sub);
    });
  });
});
