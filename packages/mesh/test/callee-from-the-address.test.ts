/**
 * The framework tells a handler which node this hop was addressed to.
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
    const c = await caller('callee-local');
    c.testCalleeOnLocalHandler('REJECTING_DO', 'callee-local-target');
    expect(await seenBy(c)).toMatchObject({
      bindingName: 'REJECTING_DO', instanceName: 'callee-local-target',
    });
  });

  it('the FIRE-BACK leg shows the receiving node, never the remote it called', async () => {
    // A handler reached by a fire-back runs at the CALLER, and `executeEnvelope` stamps the field
    // there from that node's own identity — so what it sees is itself, not `callee-fireback-target`.
    // ⚠️ Worth stating because the obvious reading is the other one: `fireResponse` is where a
    // fire-back is built, so a return address set THERE looks like the natural source. It is not,
    // and it is not set: `__handleResponse` overwrites, so such a value never reaches a handler.
    // The assertion that discriminates is the negative — the remote's name must not appear.
    const c = await caller('callee-fireback');
    c.testCalleeOnFireBack('TEST_DO', 'callee-fireback-target');
    const seen = await seenBy(c) as { instanceName?: string };
    expect(seen.instanceName).toBe('callee-fireback');
    expect(seen.instanceName).not.toBe('callee-fireback-target');
  });

  it("executeEnvelope: the receiving node's OWN name", async () => {
    const c = await caller('callee-receiver-caller');
    const target = env.TEST_DO.getByName('callee-receiver');
    await target.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'callee-receiver' });
    await target.clearReceivedCallee();
    c.fireCall('TEST_DO', 'callee-receiver', 'reportCallee');
    await vi.waitFor(async () => {
      expect(await target.getReceivedCallee()).toBeDefined();
    }, { timeout: 5000 });
    expect(await target.getReceivedCallee())
      .toMatchObject({ bindingName: 'TEST_DO', instanceName: 'callee-receiver' });
  });

  it('DISCARDS a wire-supplied value rather than inheriting it', async () => {
    // The mutation this limb exists for is set-if-absent, which every other limb here tolerates.
    const target = env.TEST_DO.getByName('callee-discard');
    await target.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'callee-discard' });
    await target.clearReceivedCallee();
    const ack = await target.__executeOperation({
      version: 1,
      chain: preprocess([{ type: 'get', key: 'reportCallee' }, { type: 'apply', args: [] }]),
      callContext: {
        callChain: [{ type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'somebody-else' }],
        callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'somebody-else' },
        state: {},
      },
      metadata: {
        caller: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'somebody-else' },
        callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'callee-discard' },
      },
    } as never);
    expect(ack).toEqual({ $ack: true });
    // The forged value must not have survived admission — the node stamps its own.
    await vi.waitFor(async () => {
      expect(await target.getReceivedCallee()).toBeDefined();
    }, { timeout: 5000 });
    expect(await target.getReceivedCallee()).toMatchObject({ instanceName: 'callee-discard' });
  }, 10000);
});
