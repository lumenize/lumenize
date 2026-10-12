/**
 * A new token reaches the socket, and a push the host sends again across a token rotation runs
 * once, for Clients whose every token is born inside the 30 s refresh-ahead window.
 *
 * The `short-tokens` project sets `AUTH_ACCESS_TOKEN_TTL` to 20 s, the deployment's ceiling on an
 * access token's lifetime, so a Client logged in through Mesh's Registry (ADR-009 rung 2) refreshes
 * on its next call or request. Every other project mints the default 900 s token.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { parse } from '@lumenize/structured-clone';
import { MeshClient, type MeshClientConfig } from '../src/mesh-client';
import { mesh } from '../src/mesh-decorator';
import { connectClient, loginAt, loginOf, uniqueScope } from './support/login';
import type { ClientHostDO } from './test-worker-and-dos';

/** A Client whose push handler counts its runs. */
class PingedClient extends MeshClient {
  pings = 0;

  @mesh()
  ping(): string {
    this.pings += 1;
    return 'pong';
  }
}

/** A client that can make an authenticated HTTP request, as `NebulaClient` does. */
class FetchingClient extends MeshClient {
  fetchAuthed(url: string): Promise<Response> {
    return this.authedFetch(url);
  }
}

/** A Client's address on its host: `h-1a2b3c4d/{sub}.tab1`. */
const addressOf = (client: MeshClient) => `${loginOf(client).scope}/${client.lmz.instanceName}`;

/** The `exp` of the token on each socket `client`'s host still holds open for it. */
async function socketExps(client: MeshClient): Promise<number[]> {
  const host = env.CLIENT_HOST_DO.getByName(loginOf(client).scope);
  return runInDurableObject(host, (_instance: unknown, ctx: DurableObjectState) => ctx.getWebSockets(addressOf(client))
    .filter((ws) => ws.readyState === WebSocket.OPEN)
    .map((ws) => (ws.deserializeAttachment() as { claims: { exp: number } }).claims.exp));
}

/**
 * A WebSocket that can drop the next `incoming_call` frame it receives, as a frame lost in flight
 * on a socket the host is replacing would be.
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

/** A WebSocket that counts the sockets a Client opens with it, and records each one's close code. */
function openingWebSocket(Base: typeof WebSocket): typeof WebSocket & { opened: number; closed: number[] } {
  return class extends Base {
    static opened = 0;
    static closed: number[] = [];
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      (this.constructor as unknown as { opened: number }).opened += 1;
    }
    override dispatchEvent(event: Event): boolean {
      const handled = super.dispatchEvent(event);
      // Recorded after the Client's own handler has run.
      if (event.type === 'close') (this.constructor as unknown as { closed: number[] }).closed.push((event as CloseEvent).code);
      return handled;
    }
  } as never;
}

/** Close every socket `scope`'s host holds for the Client `instanceName`, as its Gateway does. */
async function closeFromHost(scope: string, instanceName: string, code: number, reason: string): Promise<void> {
  const host = env.CLIENT_HOST_DO.getByName(scope);
  await runInDurableObject(host, (_instance: unknown, ctx: DurableObjectState) => {
    for (const ws of ctx.getWebSockets(`${scope}/${instanceName}`)) ws.close(code, reason);
  });
}

describe('a push the host sends again across a token rotation', () => {
  it('is delivered when the frame on the old socket was lost, with no 4408', async () => {
    const Dropping = droppingWebSocket(new Browser().WebSocket);
    using client = await connectClient(PingedClient, uniqueScope('h'), { WebSocket: Dropping });
    Dropping.dropNextIncomingCall = true;
    const name = `rr_${crypto.randomUUID()}`;
    const node = env.TEST_DO.getByName(name);
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
    await node.callClient('CLIENT_HOST_DO', addressOf(client), 'ping', [], 'ping');
    await vi.waitFor(() => expect(Dropping.dropNextIncomingCall).toBe(false)); // the frame was lost

    // The rotation opens a new socket under the same name; the host supersedes the old one and
    // sends the waiting call down the new one. MUTATION: stop re-sending, and it never arrives.
    await client.lmz.callAsync('TEST_DO', `rr_${crypto.randomUUID()}`, (client.ctn() as any).ping());
    const answer = await vi.waitFor(async () => {
      const kept = await node.getOutcomes('ping');
      expect(kept).toHaveLength(1);
      return parse(kept[0]).result;
    }, { timeout: 5000 });
    expect(answer).toBe('pong');
    expect(client.pings).toBe(1);
  }, 20_000);
});

describe('a new token reaches the socket', () => {
  it('a refresh made for an HTTP request moves the open socket onto the new token', async () => {
    using client = await connectClient(FetchingClient);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Two seconds on, so the refreshed token's `exp` differs from the first.
      vi.setSystemTime(Date.now() + 2000);
      const before = (client.claims as { exp: number }).exp;
      await (await client.fetchAuthed(`${loginOf(client).baseUrl}/`)).text();
      expect((client.claims as { exp: number }).exp).toBeGreaterThan(before);
      // Every 20 s token is born due, so the socket's own reconnect may refresh once more: what must
      // hold is that the open socket carries the token the Client holds now.
      // MUTATION: leave the socket alone, and the host keeps the replaced token's `exp`.
      await vi.waitFor(async () => expect(await socketExps(client)).toEqual([(client.claims as { exp: number }).exp]), { timeout: 10000 });
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  // A refresh that brings a new `sub` rotates the socket once, under the new name, inside the
  // refresh. The request's own check must then find a socket already on the new token. The request
  // is slowed so that socket is open when it returns, as a real network round trip leaves it.
  it('a refresh for an HTTP request that brings a new sub opens one socket under it', async () => {
    const scope = uniqueScope('h');
    const first = await loginAt(scope);
    const second = await loginAt(scope);
    let who = first;
    const browser = new Browser();
    const Opening = openingWebSocket(browser.WebSocket);
    const slowFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/slow')) await new Promise((r) => setTimeout(r, 500));
      return browser.fetch(input, init);
    };
    let required = 0;
    using client = new FetchingClient({
      instanceName: `${first.sub}.tab1`,
      baseUrl: first.baseUrl,
      refresh: (() => who.refresh()) as MeshClientConfig['refresh'],
      WebSocket: Opening,
      fetch: slowFetch,
      onSubscriptionRequired: () => { required += 1; },
    });
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
    expect(required).toBe(1);
    const before = Opening.opened;

    who = second;
    await (await client.fetchAuthed(`${first.baseUrl}/slow`)).text();
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10_000 });
    expect(client.lmz.instanceName).toBe(`${second.sub}.tab1`);
    // The new name has no record on the host, so it reports a loss.
    await vi.waitFor(() => expect(required).toBe(2), { timeout: 10_000 });
    // MUTATION: compare the token with the one held before the request, and the request rotates a
    // second time, opening a third socket.
    expect(Opening.opened - before).toBe(1);
  }, 20_000);
});

describe('a token that lapses while a rotation waits on its refresh', () => {
  // In-lane rather than `/live`: the host's 4401 has to land while the rotation's refresh is out,
  // and only a `refresh` the test supplies can hold one open. Under load it lands there by chance,
  // which is how Nebula's `resubscribe-on-signal` lost its rotation's call.
  it('opens one socket, and the call that started the rotation is answered', async () => {
    const login = await loginAt(uniqueScope('h'));
    const browser = new Browser();
    const Opening = openingWebSocket(browser.WebSocket);
    let held: Promise<void> = Promise.resolve();
    let refreshes = 0;
    using client = new FetchingClient({
      instanceName: `${login.sub}.tab1`,
      baseUrl: login.baseUrl,
      refresh: (async () => { refreshes += 1; await held; return login.refresh(); }) as MeshClientConfig['refresh'],
      fetch: browser.fetch,
      WebSocket: Opening,
    });
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
    let release!: () => void;
    held = new Promise((resolve) => { release = resolve; });
    const [opened, refreshed] = [Opening.opened, refreshes];

    // Every token here is born due, so the call is queued and the socket rotated, and the
    // rotation's refresh is held.
    const answered = client.lmz.callAsync(
      'CLIENT_HOST_DO', login.scope, client.ctn<ClientHostDO>().echo('answered'), { timeoutMs: 10_000 });
    await vi.waitFor(() => expect(refreshes).toBe(refreshed + 1));
    // The host closes the old socket 4401, as its Gateway does when a frame arrives on a lapsed token.
    await closeFromHost(login.scope, client.lmz.instanceName!, 4401, 'Token expired');
    await vi.waitFor(() => expect(Opening.closed).toContain(4401));
    release();

    // MUTATION: let that close start its own refresh and reconnect, and a second socket opens
    // beside the rotation's, onto which the queued call can be flushed before it is open and lost.
    expect(await answered).toBe('answered');
    expect(Opening.opened - opened).toBe(1);
  }, 20_000);
});
