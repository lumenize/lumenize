/**
 * The framework tells a handler which node the call was addressed to.
 *
 * A fan-out hands every target the SAME handler chain, so the only thing that differs per target is
 * the reply — and a reply is authored by the far side. That is how a client could answer a push with
 * an error naming somebody else and have that subscriber's row deleted. `callContext.callee` is the
 * unforgeable answer, stamped per hop from a source the caller does not write.
 *
 * ⚠️ **Presence is not the property.** A set-if-absent implementation leaves an upstream node's
 * address in place and a reaper then acts on the wrong one, with every limb here still green — so
 * each limb asserts the VALUE this hop should carry, and the discard limb supplies a wire value to
 * be overwritten.
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';

async function caller(name: string) {
  const c = env.TEST_DO.getByName(name);
  await c.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
  await c.clearSeenCallee();
  return c;
}

async function seenBy(c: { getSeenCallee: () => Promise<unknown> }): Promise<any> {
  await vi.waitFor(async () => {
    expect(await c.getSeenCallee()).toBeDefined();
  }, { timeout: 5000 });
  return await c.getSeenCallee();
}

describe('callContext.callee is stamped per hop, from the address', () => {
  it('dispatchEnvelope: the instance the CALLER addressed', async () => {
    // The reaper path. The callee rejected at admission, so the handler runs at the caller — and
    // what it must learn is which target failed, which is the address this call was sent to.
    const c = await caller('callee_local');
    c.testCalleeOnLocalHandler('REJECTING_DO', 'callee_local_target');
    expect(await seenBy(c)).toMatchObject({
      bindingName: 'REJECTING_DO', instanceName: 'callee_local_target',
    });
  });

  it('the FIRE-BACK leg shows the node that answered, from the last hop', async () => {
    // A handler reached by a fire-back runs at the CALLER, so a stamp from the receiving node's own
    // identity would show the caller itself. `executeEnvelope` takes the fire-back's last hop
    // instead, which the answering node's `fireResponse` appended.
    const c = await caller('callee_fireback');
    c.testCalleeOnFireBack('TEST_DO', 'callee_fireback_target');
    expect(await seenBy(c)).toMatchObject({
      type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'callee_fireback_target',
    });
  });

  it("executeEnvelope: the receiving node's OWN name", async () => {
    const c = await caller('callee_receiver_caller');
    const target = env.TEST_DO.getByName('callee_receiver');
    await target.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'callee_receiver' });
    await target.clearReceivedCallee();
    c.fireCall('TEST_DO', 'callee_receiver', 'reportCallee');
    await vi.waitFor(async () => {
      expect(await target.getReceivedCallee()).toBeDefined();
    }, { timeout: 5000 });
    expect(await target.getReceivedCallee())
      .toMatchObject({ bindingName: 'TEST_DO', instanceName: 'callee_receiver' });
  });

  it('DISCARDS a wire-supplied value rather than inheriting it', async () => {
    // The mutation this limb exists for is set-if-absent, which every other limb here tolerates.
    const target = env.TEST_DO.getByName('callee_discard');
    await target.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'callee_discard' });
    await target.clearReceivedCallee();
    const ack = await target.__executeOperation({
      version: 1,
      chain: preprocess([{ type: 'get', key: 'reportCallee' }, { type: 'apply', args: [] }]),
      callContext: {
        callChain: [{ type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'somebody_else' }],
        callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'somebody_else' },
      },
      metadata: {
        caller: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'somebody_else' },
        callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'callee_discard' },
      },
    } as never);
    expect(ack).toEqual({ $ack: true });
    // The forged value must not have survived admission — the node stamps its own.
    await vi.waitFor(async () => {
      expect(await target.getReceivedCallee()).toBeDefined();
    }, { timeout: 5000 });
    expect(await target.getReceivedCallee()).toMatchObject({ instanceName: 'callee_discard' });
  }, 10000);

  it('at the fire-back door, takes the last hop and DISCARDS a wire-supplied value', async () => {
    // A real fire-back carries the answering node's own request-door stamp as `callee`, which
    // always equals its last hop, so only a fire-back whose two disagree can tell which one the
    // door reads. The handler must see the last hop.
    const c = await caller('callee_fireback_discard');
    const answerer = { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'the_answerer' };
    const ack = await env.TEST_DO.getByName('callee_fireback_discard').__handleResponse({
      version: 1,
      chain: preprocess([{ type: 'get', key: 'recordCallee' }, { type: 'apply', args: ['done'] }]),
      callContext: {
        callChain: [
          { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'callee_fireback_discard' },
          answerer,
        ],
        callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'somebody_else' },
      },
      metadata: {
        caller: answerer,
        callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'callee_fireback_discard' },
      },
    } as never);
    expect(ack).toEqual({ $ack: true });
    expect(await seenBy(c)).toMatchObject({ instanceName: 'the_answerer' });
  }, 10000);
});
