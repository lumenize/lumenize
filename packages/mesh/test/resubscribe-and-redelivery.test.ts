/**
 * A push the Gateway sends again on a new socket runs its handler once, and a new token reaches the
 * socket.
 *
 * Each limb drives a real `LumenizeClient` through the test Worker's real Gateway. What a test
 * cannot make happen through a product path — a socket dropped by the network, a frame lost in
 * flight — it makes happen at the edge: the Gateway closes the socket from inside its Durable
 * Object, or the Client's `WebSocket` drops one frame. A missed answer's re-subscribe needs the
 * Gateway's call timeout to run out, so it is in `gateway-timing.test.ts`, and the lost
 * subscriptions are driven live by `resubscribe-when-lost`.
 */
import { describe, it, expect, vi } from 'vitest';
// Also what lets `Browser`'s default fetch reach the test Worker through `SELF`.
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { parse } from '@lumenize/structured-clone';
import { LumenizeClient, ANSWER_RECORD_SIZE, type LumenizeClientConfig } from '../src/lumenize-client';
import { mesh } from '../src/mesh-decorator';
import { createTestRefreshFunction } from '../src/create-test-refresh-function';

/** A client with nothing of its own: what a plain `LumenizeClient` does. */
class PlainClient extends LumenizeClient {}

/** A Client whose push handlers count their runs, one of them held until the test releases it. */
class PushedClient extends LumenizeClient {
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

/** A client that can make an authenticated HTTP request, as `NebulaClient` does. */
class FetchingClient extends LumenizeClient {
  fetchAuthed(url: string): Promise<Response> {
    return this.authedFetch(url);
  }
}

/** The `exp` of the token on each socket `client`'s Gateway still holds open. */
async function socketExps(client: LumenizeClient): Promise<number[]> {
  const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(client.lmz.instanceName!));
  return runInDurableObject(gateway, (_instance: unknown, ctx: DurableObjectState) => ctx.getWebSockets()
    .filter((ws) => ws.readyState === WebSocket.OPEN)
    .map((ws) => (ws.deserializeAttachment() as { claims: { exp: number } }).claims.exp));
}

/**
 * A WebSocket that can drop the next `incoming_call` frame it receives, as a frame lost in flight
 * on a socket the Gateway is replacing would be.
 */
function droppingWebSocket(Base: typeof WebSocket): typeof WebSocket & { dropNextIncomingCall: boolean } {
  return class extends Base {
    static dropNextIncomingCall = false;
    override dispatchEvent(event: Event): boolean {
      const ctor = this.constructor as unknown as { dropNextIncomingCall: boolean };
      if (ctor.dropNextIncomingCall && event.type === 'message'
        && JSON.parse(String((event as MessageEvent).data)).type === 'incoming_call') {
        ctor.dropNextIncomingCall = false;
        return true;
      }
      return super.dispatchEvent(event);
    }
  } as never;
}

/** A WebSocket that counts the sockets a Client opens with it. */
function openingWebSocket(Base: typeof WebSocket): typeof WebSocket & { opened: number } {
  return class extends Base {
    static opened = 0;
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      (this.constructor as unknown as { opened: number }).opened += 1;
    }
  } as never;
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

async function connect<T extends LumenizeClient>(
  Ctor: new (config: LumenizeClientConfig) => T, extra: Partial<LumenizeClientConfig> = {},
): Promise<T> {
  const sub = crypto.randomUUID();
  const browser = new Browser();
  const client = new Ctor({
    instanceName: `${sub}.tab1`,
    baseUrl: 'https://localhost',
    refresh: createTestRefreshFunction({ sub }),
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    ...extra,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

/** Close the Client's socket from inside its Gateway, as the network or the Gateway itself would. */
async function closeFromGateway(client: LumenizeClient, code: number): Promise<void> {
  const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(client.lmz.instanceName!));
  await runInDurableObject(gateway, (_instance: unknown, ctx: DurableObjectState) => {
    for (const ws of ctx.getWebSockets()) ws.close(code, 'closed by the test');
  });
}

/** A node that has called `client`'s `method`, and what its handler kept once the answer came back. */
async function nodeCalling(client: LumenizeClient, method: string) {
  const name = `rr-${crypto.randomUUID()}`;
  const node = env.TEST_DO.getByName(name);
  await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
  await node.callClient('LUMENIZE_CLIENT_GATEWAY', client.lmz.instanceName!, method, [], method);
  return {
    node,
    outcome: () => vi.waitFor(async () => {
      const kept = await node.getOutcomes(method);
      expect(kept).toHaveLength(1);
      return parse(kept[0]).result;
    }, { timeout: 5000 }),
  };
}

describe('a push the Gateway sends again on a new socket', () => {
  it('runs its handler once, and the repeat is answered from the record', async () => {
    using client = await connect(PushedClient);
    const { outcome } = await nodeCalling(client, 'slowAnswer');
    await vi.waitFor(() => expect(client.slowRuns).toBe(1));

    // The socket drops while the handler runs, so its answer has nowhere to go; the Gateway still
    // holds the call, and sends it again once the Client is back.
    await closeFromGateway(client, 4000);
    await vi.waitFor(() => expect(client.connectionState).toBe('reconnecting'));
    client.release();

    // MUTATIONS: drop the record, and the handler runs twice; answer a repeat with nothing, and no
    // answer ever arrives.
    expect(await outcome()).toBe('slow-answer');
    expect(client.slowRuns).toBe(1);
  }, 20_000);

  it('is delivered across a token rotation when the frame on the old socket was lost, with no 4408', async () => {
    const Dropping = droppingWebSocket(new Browser().WebSocket);
    // A token inside the 30 s refresh-ahead window from birth, so the Client's next call rotates.
    const sub = crypto.randomUUID();
    using client = await connect(PushedClient, {
      instanceName: `${sub}.tab1`, refresh: createTestRefreshFunction({ sub, ttl: 20 }), WebSocket: Dropping,
    });
    Dropping.dropNextIncomingCall = true;
    const { outcome } = await nodeCalling(client, 'ping');
    await vi.waitFor(() => expect(Dropping.dropNextIncomingCall).toBe(false)); // the frame was lost

    // The rotation opens a new socket under the same name; the Gateway supersedes the old one and
    // sends the waiting call down the new one. MUTATION: stop re-sending, and it never arrives.
    await client.lmz.callAsync('TEST_DO', `rr-${crypto.randomUUID()}`, (client.ctn() as any).ping());
    expect(await outcome()).toBe('pong');
    expect(client.pings).toBe(1);
  }, 20_000);

  it('keeps a bounded record of recent answers', async () => {
    using client = await connect(PushedClient);
    const name = `rr-${crypto.randomUUID()}`;
    const node = env.TEST_DO.getByName(name);
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
    const total = ANSWER_RECORD_SIZE + 3;
    for (let i = 0; i < total; i++) {
      await node.callClient('LUMENIZE_CLIENT_GATEWAY', client.lmz.instanceName!, 'ping', [], 'bounded', true);
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

    // The Gateway sends the call again on the new socket while the handler is still held.
    await closeFromGateway(client, 4000);
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
    const name = `rr-${crypto.randomUUID()}`;
    const node = env.TEST_DO.getByName(name);
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
    const crowd = ANSWER_RECORD_SIZE + 3;
    for (let i = 0; i < crowd; i++) {
      await node.callClient('LUMENIZE_CLIENT_GATEWAY', client.lmz.instanceName!, 'ping', [], 'crowd');
    }
    await vi.waitFor(async () => expect(await node.getOutcomes('crowd')).toHaveLength(crowd), { timeout: 10000 });

    // MUTATION: evict the oldest entry whatever it holds, and the repeat finds no record of the
    // held call and runs its handler a second time.
    await closeFromGateway(client, 4000);
    await vi.waitFor(() => expect(Counting.incomingCalls).toBe(crowd + 2), { timeout: 10000 });
    client.release();
    expect(await outcome()).toBe('slow-answer');
    expect(client.slowRuns).toBe(1);
  }, 30_000);
});

describe('a new token reaches the socket', () => {
  it('a refresh made for an HTTP request moves the open socket onto the new token', async () => {
    const sub = crypto.randomUUID();
    // A token inside the 30 s refresh-ahead window from birth, so the request refreshes it.
    using client = await connect(FetchingClient, { instanceName: `${sub}.tab1`, refresh: createTestRefreshFunction({ sub, ttl: 20 }) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Two seconds on, so the refreshed token's `exp` differs from the first.
      vi.setSystemTime(Date.now() + 2000);
      await (await client.fetchAuthed('https://localhost/')).text();
      const exp = (client.claims as { exp: number }).exp;
      // MUTATION: leave the socket alone, and the Gateway keeps the replaced token's `exp`.
      await vi.waitFor(async () => expect(await socketExps(client)).toEqual([exp]), { timeout: 10000 });
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  // A refresh that brings a new `sub` rotates the socket once, under the new name, inside the
  // refresh. The request's own check must then find a socket already on the new token. The request
  // is slowed so that socket is open when it returns, as a real network round trip leaves it.
  it('a refresh for an HTTP request that brings a new sub opens one socket under it', async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    let who = first;
    // Tokens inside the 30 s refresh-ahead window from birth, so the request refreshes.
    const refreshes = {
      [first]: createTestRefreshFunction({ sub: first, ttl: 20 }),
      [second]: createTestRefreshFunction({ sub: second, ttl: 20 }),
    };
    const browser = new Browser();
    const Opening = openingWebSocket(browser.WebSocket);
    const slowFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/slow')) await new Promise((r) => setTimeout(r, 500));
      return browser.fetch(input, init);
    };
    let required = 0;
    using client = await connect(FetchingClient, {
      instanceName: `${first}.tab1`,
      refresh: ((...args: unknown[]) => (refreshes[who] as (...a: unknown[]) => unknown)(...args)) as LumenizeClientConfig['refresh'],
      WebSocket: Opening,
      fetch: slowFetch,
      onSubscriptionRequired: () => { required += 1; },
    });
    expect(required).toBe(1);
    const before = Opening.opened;

    who = second;
    await (await client.fetchAuthed('https://localhost/slow')).text();
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10_000 });
    expect(client.lmz.instanceName).toBe(`${second}.tab1`);
    // The new name's Gateway has no record of this Client, so it reports a loss.
    await vi.waitFor(() => expect(required).toBe(2), { timeout: 10_000 });
    // MUTATION: compare the token with the one held before the request, and the request rotates a
    // second time, opening a third socket.
    expect(Opening.opened - before).toBe(1);
  }, 20_000);

  it('a Client reused under another identity after clearAccessToken() connects under that identity\'s name', async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    let who = first;
    const refreshes = { [first]: createTestRefreshFunction({ sub: first }), [second]: createTestRefreshFunction({ sub: second }) };
    using client = await connect(PlainClient, {
      instanceName: `${first}.tab1`,
      refresh: ((...args: unknown[]) => (refreshes[who] as (...a: unknown[]) => unknown)(...args)) as LumenizeClientConfig['refresh'],
    });
    client.disconnect();
    client.clearAccessToken();
    who = second;
    client.connect();
    // MUTATION: compare the new token with the claims clearAccessToken() emptied, and the Client
    // keeps the first name, which the Gateway refuses for the second identity's token.
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
    expect(client.lmz.instanceName).toBe(`${second}.tab1`);
  }, 20_000);
});
