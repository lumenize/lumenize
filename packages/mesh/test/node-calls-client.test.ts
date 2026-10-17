/**
 * A node's call to a Client: its host acks early, keeps the node's result handler continuation,
 * and fills it with the Client's answer the way a node's fire-back does.
 *
 * Every limb drives a real `MeshClient`, logged in through Mesh's Registry and hosted by a
 * scope's node, called by a real node, and reads what that node's own handler received at its
 * fire-back door. The direct `__executeOperation` limbs — no socket, the early ack, the spy on
 * `ctx.waitUntil` — are in `client-gateway.test.ts`, which plays the socket by hand.
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { parse } from '@lumenize/structured-clone';
import { MeshClient } from '../src/mesh-client';
import { mesh } from '../src/mesh-decorator';
import { connectClient, loginOf } from './support/login';

/** An Error subclass that carries a property of its own, unregistered on `globalThis`. */
class BoundError extends Error {
  name = 'BoundError';
  code = 42;
}

/** A Client whose push handlers answer with what each limb needs. */
class AnsweringClient extends MeshClient {
  @mesh()
  rich(): Record<string, unknown> {
    const cyclic: Record<string, unknown> = { label: 'loop' };
    cyclic.self = cyclic;
    const alias = { shared: true };
    return {
      map: new Map([['a', 1]]),
      date: new Date('2026-10-05T12:00:00.000Z'),
      cyclic,
      aliasA: alias,
      aliasB: alias,
      error: new BoundError('bound'),
    };
  }

  /** Answers with an Error named as the host's own verdict that a Client is gone. */
  @mesh()
  returnGone(): Error {
    return Object.assign(new Error('gone'), { name: 'ClientDisconnectedError' });
  }

  @mesh()
  throwGone(): never {
    throw Object.assign(new Error('gone'), { name: 'ClientDisconnectedError' });
  }
}

/** A real Client on a fresh universe's page. */
const connect = () => connectClient(AnsweringClient);

/** A Client's address on its host: `h-1a2b3c4d/{sub}.tab1`. */
const addressOf = (client: MeshClient) => `${loginOf(client).scope}/${client.lmz.instanceName}`;

/** A node that calls `client`'s `method` and keeps the answer, read back once it arrives. */
async function answerFrom(client: AnsweringClient, method: string): Promise<any> {
  const name = `ncc-${crypto.randomUUID()}`;
  const node = env.TEST_DO.getByName(name);
  await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
  await node.callClient('CLIENT_HOST_DO', addressOf(client), method, [], method);
  return vi.waitFor(async () => {
    const kept = await node.getOutcomes(method);
    expect(kept).toHaveLength(1);
    return parse(kept[0]);
  }, { timeout: 5000 });
}

describe('a node\'s call to a Client', () => {
  it('fills the node\'s handler with the Client\'s answer, intact: a Map, a Date, a cycle, an alias and an Error subclass', async () => {
    using client = await connect();
    const { result, callee, callChain } = await answerFrom(client, 'rich');

    expect(result.map).toBeInstanceOf(Map);
    expect(result.map.get('a')).toBe(1);
    expect(result.date).toBeInstanceOf(Date);
    expect(result.date.toISOString()).toBe('2026-10-05T12:00:00.000Z');
    expect(result.cyclic.self).toBe(result.cyclic);
    expect(result.aliasA).toBe(result.aliasB);
    expect(result.error).toBeInstanceOf(Error);
    expect({ name: result.error.name, message: result.error.message, code: result.error.code })
      .toEqual({ name: 'BoundError', message: 'bound', code: 42 });
    // The Client is the last hop, and so the handler's `callee`, as a node that answered would be.
    const client_ = { type: 'LumenizeClient', bindingName: 'CLIENT_HOST_DO', instanceName: addressOf(client) };
    expect(callChain.at(-1)).toEqual(client_);
    expect(callee).toEqual(client_);
  });

  it('under onErrorOnly fires back only a thrown Error, as between nodes: an answer and a returned Error are successes', async () => {
    using client = await connect();
    const name = `ncc-${crypto.randomUUID()}`;
    const node = env.TEST_DO.getByName(name);
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
    const address = addressOf(client);
    await node.callClient('CLIENT_HOST_DO', address, 'rich', [], 'answer', true);
    await node.callClient('CLIENT_HOST_DO', address, 'returnGone', [], 'returned', true);
    await node.callClient('CLIENT_HOST_DO', address, 'throwGone', [], 'thrown', true);

    // The thrown one is the barrier: the Client answers in order, so the two before it have been
    // answered, and would have fired back, by the time it arrives.
    await vi.waitFor(async () => expect(await node.getOutcomes('thrown')).toHaveLength(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(await node.getOutcomes('answer')).toEqual([]);
    expect(await node.getOutcomes('returned')).toEqual([]);
  });

  it('renames a Client\'s own ClientDisconnectedError, returned or thrown, so no Client can get itself reaped', async () => {
    using client = await connect();
    const returned = await answerFrom(client, 'returnGone');
    const thrown = await answerFrom(client, 'throwGone');
    for (const { result } of [returned, thrown]) {
      expect(result).toBeInstanceOf(Error);
      expect({ name: result.name, message: result.message })
        .toEqual({ name: 'Error', message: 'ClientDisconnectedError: gone' });
    }
  });
});
