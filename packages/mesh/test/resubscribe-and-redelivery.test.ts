/**
 * A push a host sends again on a new socket runs its handler once, and a Client reused under
 * another identity connects under that identity's name.
 *
 * Each limb drives a real `MeshClient`, logged in through Mesh's Registry, on its scope's host.
 * What a test cannot make happen through a product path — a socket dropped by the network, a frame
 * lost in flight — it makes happen at the edge: the host closes the socket from inside its Durable
 * Object, or the Client's `WebSocket` drops one frame. A missed answer's re-subscribe needs the
 * host's call timeout to run out, so it is in `gateway-timing.test.ts`; the limbs that need a token
 * born inside the refresh-ahead window are in `short-tokens.test.ts`, whose project mints them; and
 * the lost subscriptions are driven live by `resubscribe-when-lost`.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { parse } from '@lumenize/structured-clone';
import { MeshClient, ANSWER_RECORD_SIZE, type MeshClientConfig } from '../src/mesh-client';
import { mesh } from '../src/mesh-decorator';
import { connectClient, loginAt, loginOf, uniqueScope } from './support/login';

/** A client with nothing of its own: what a plain `MeshClient` does. */
class PlainClient extends MeshClient {}

/** A Client whose push handlers count their runs, one of them held until the test releases it. */
class PushedClient extends MeshClient {
  slowRuns = 0;
  pings = 0;
  #release!: () => void;
  #held = new Promise<void>((resolve) => { this.#release = resolve; });

  @mesh()
  async slowAnswer(): Promise<string> {
    this.slowRuns += 1;
    await this.#held;
    return 'slow-answer';
  }

  @mesh()
  ping(): string {
    this.pings += 1;
    return 'pong';
  }

  release(): void {
    this.#release();
  }

  answers(): number {
    return this.answerRecordCount();
  }
}

/** A WebSocket that counts the `incoming_call` frames it receives. */
function countingWebSocket(Base: typeof WebSocket): typeof WebSocket & { incomingCalls: number } {
  return class extends Base {
    static incomingCalls = 0;
    override dispatchEvent(event: Event): boolean {
      if (event.type === 'message' && JSON.parse(String((event as MessageEvent).data)).type === 'incoming_call') {
        (this.constructor as unknown as { incomingCalls: number }).incomingCalls += 1;
      }
      return super.dispatchEvent(event);
    }
  } as never;
}

/** A real Client on a fresh universe's page. */
const connect = <T extends MeshClient>(Ctor: new (config: MeshClientConfig) => T, extra: Partial<MeshClientConfig> = {}) =>
  connectClient(Ctor, uniqueScope('h'), extra);

/** A Client's address on its host: `h-1a2b3c4d/{sub}.tab1`. */
const addressOf = (client: MeshClient) => `${loginOf(client).scope}/${client.lmz.instanceName}`;

/** Close the Client's socket from inside its host, as the network or the host itself would. */
async function closeFromHost(client: MeshClient, code: number): Promise<void> {
  const host = env.CLIENT_HOST_DO.getByName(loginOf(client).scope);
  await runInDurableObject(host, (_instance: unknown, ctx: DurableObjectState) => {
    for (const ws of ctx.getWebSockets(addressOf(client))) ws.close(code, 'closed by the test');
  });
}

/** A node that has called `client`'s `method`, and what its handler kept once the answer came back. */
async function nodeCalling(client: MeshClient, method: string) {
  const name = `rr_${crypto.randomUUID()}`;
  const node = env.TEST_DO.getByName(name);
  await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
  await node.callClient('CLIENT_HOST_DO', addressOf(client), method, [], method);
  return {
    node,
    outcome: () => vi.waitFor(async () => {
      const kept = await node.getOutcomes(method);
      expect(kept).toHaveLength(1);
      return parse(kept[0]).result;
    }, { timeout: 5000 }),
  };
}

describe('a push the host sends again on a new socket', () => {
  it('runs its handler once, and the repeat is answered from the record', async () => {
    using client = await connect(PushedClient);
    const { outcome } = await nodeCalling(client, 'slowAnswer');
    await vi.waitFor(() => expect(client.slowRuns).toBe(1));

    // The socket drops while the handler runs, so its answer has nowhere to go; the host still
    // holds the call, and sends it again once the Client is back.
    await closeFromHost(client, 4000);
    await vi.waitFor(() => expect(client.connectionState).toBe('reconnecting'));
    client.release();

    // MUTATIONS: drop the record, and the handler runs twice; answer a repeat with nothing, and no
    // answer ever arrives.
    expect(await outcome()).toBe('slow-answer');
    expect(client.slowRuns).toBe(1);
  }, 20_000);

  it('keeps a bounded record of recent answers', async () => {
    using client = await connect(PushedClient);
    const name = `rr_${crypto.randomUUID()}`;
    const node = env.TEST_DO.getByName(name);
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
    const total = ANSWER_RECORD_SIZE + 3;
    for (let i = 0; i < total; i++) {
      await node.callClient('CLIENT_HOST_DO', addressOf(client), 'ping', [], 'bounded', true);
    }
    await vi.waitFor(() => expect(client.pings).toBe(total), { timeout: 10000 });
    // MUTATION: make the record unbounded, and it holds every one.
    expect(client.answers()).toBe(ANSWER_RECORD_SIZE);
  }, 20_000);

  it('a repeat that arrives while the first run is still going waits for that run\'s answer', async () => {
    const Counting = countingWebSocket(new Browser().WebSocket);
    using client = await connect(PushedClient, { WebSocket: Counting });
    const { outcome } = await nodeCalling(client, 'slowAnswer');
    await vi.waitFor(() => expect(client.slowRuns).toBe(1));

    // The host sends the call again on the new socket while the handler is still held.
    await closeFromHost(client, 4000);
    await vi.waitFor(() => expect(Counting.incomingCalls).toBe(2), { timeout: 10000 });
    client.release();

    // MUTATION: record a call only once it has answered, and the repeat runs the handler again.
    expect(await outcome()).toBe('slow-answer');
    expect(client.slowRuns).toBe(1);
  }, 20_000);

  it('never evicts a call still running, so a repeat of it still waits', async () => {
    const Counting = countingWebSocket(new Browser().WebSocket);
    using client = await connect(PushedClient, { WebSocket: Counting });
    const { outcome } = await nodeCalling(client, 'slowAnswer');
    await vi.waitFor(() => expect(client.slowRuns).toBe(1));

    // A full record's worth of answered calls behind it, every answer back at the node.
    const name = `rr_${crypto.randomUUID()}`;
    const node = env.TEST_DO.getByName(name);
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
    const crowd = ANSWER_RECORD_SIZE + 3;
    for (let i = 0; i < crowd; i++) {
      await node.callClient('CLIENT_HOST_DO', addressOf(client), 'ping', [], 'crowd');
    }
    await vi.waitFor(async () => expect(await node.getOutcomes('crowd')).toHaveLength(crowd), { timeout: 10000 });

    // MUTATION: evict the oldest entry whatever it holds, and the repeat finds no record of the
    // held call and runs its handler a second time.
    await closeFromHost(client, 4000);
    await vi.waitFor(() => expect(Counting.incomingCalls).toBe(crowd + 2), { timeout: 10000 });
    client.release();
    expect(await outcome()).toBe('slow-answer');
    expect(client.slowRuns).toBe(1);
  }, 30_000);
});

describe('a Client reused under another identity', () => {
  it('a Client reused under another identity after clearAccessToken() connects under that identity\'s name', async () => {
    const scope = uniqueScope('h');
    const first = await loginAt(scope);
    const second = await loginAt(scope);
    let who = first;
    const browser = new Browser();
    using client = new PlainClient({
      instanceName: `${first.sub}.tab1`,
      baseUrl: first.baseUrl,
      refresh: () => who.refresh(),
      fetch: browser.fetch,
      WebSocket: browser.WebSocket,
    });
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
    client.disconnect();
    client.clearAccessToken();
    who = second;
    client.connect();
    // MUTATION: compare the new token with the claims clearAccessToken() emptied, and the Client
    // keeps the first name, which the Worker refuses for the second identity's token.
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
    expect(client.lmz.instanceName).toBe(`${second.sub}.tab1`);
  }, 20_000);
});
