/**
 * A node that hosts Clients: `ClientGateway` composed in host-node mode on a `LumenizeDO`, the way
 * a scope's node hosts the Clients on its pages.
 *
 * vitest-plugin, because no Nebula route reaches a host node until the task that builds this moves
 * Nebula's pages onto it; the `/live` scenarios written then drive the same code end to end. Each
 * limb uses `ClientHostDO` from the test Worker, either through a real `LumenizeClient` that
 * upgrades at `/gateway/{id}` on `h*.hosted.test`, which the test Worker rewrites the way a scope's
 * Worker does, or through a socket played by hand where a limb needs to hold a frame unanswered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { preprocess } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import { LumenizeClient, type LumenizeClientConfig } from '../src/lumenize-client';
import { mesh } from '../src/mesh-decorator';
import { createTestRefreshFunction } from '../src/create-test-refresh-function';
import { GatewayMessageType, WS_CLOSE_GONE } from '../src/gateway-messages';
import type { CallEnvelope } from '../src/lmz-api';
import type { ClientHostDO, EchoDO, TestDO } from './test-worker-and-dos';

/** A Client whose push handler answers, and which records what it was sent. */
class HostedClient extends LumenizeClient {
  received: string[] = [];

  @mesh()
  receive(value: string): string {
    this.received.push(value);
    return `${value}!`;
  }
}

/** A real Client on `host`, upgrading at `/gateway/{sub}.tab1` on `{host}.hosted.test`. */
async function connect(host: string, extra: Partial<LumenizeClientConfig> = {}): Promise<HostedClient> {
  const sub = crypto.randomUUID();
  const browser = new Browser();
  const client = new HostedClient({
    instanceName: `${sub}.tab1`,
    baseUrl: `https://${host}.hosted.test`,
    hostFromHostname: true,
    refresh: createTestRefreshFunction({ sub }),
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    ...extra,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

/** A hosted Client's name on its host: `h1/{sub}.tab1`. */
const nameOn = (host: string, client: LumenizeClient) => `${host}/${client.lmz.instanceName}`;

/** A fake JWT; the host decodes what the test Worker's hooks would have verified. */
function fakeJwt(sub: string): string {
  const enc = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'EdDSA', typ: 'JWT' })}.${enc({ sub, exp: Math.floor(Date.now() / 1000) + 900 })}.sig`;
}

/** Upgrade straight to the host with `path`, as the Worker's forward would deliver it. */
function upgrade(host: string, path: string, sub: string): Promise<Response> {
  return env.CLIENT_HOST_DO.getByName(host).fetch(`https://example.com${path}`, {
    headers: {
      'Upgrade': 'websocket',
      'Sec-WebSocket-Protocol': 'lmz.2',
      'Authorization': `Bearer ${fakeJwt(sub)}`,
      'X-Lumenize-DO-Instance-Name-Or-Id': host,
      'X-Lumenize-DO-Binding-Name': 'CLIENT_HOST_DO',
    },
  });
}

/** A socket played by hand on `host` under the id `{sub}.tab1`, open once the host has said hello. */
async function socketOn(host: string, sub: string): Promise<{ ws: WebSocket; frames: any[] }> {
  const res = await upgrade(host, `/gateway/CLIENT_HOST_DO/${host}/${sub}.tab1`, sub);
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const frames: any[] = [];
  ws.addEventListener('message', (e: MessageEvent) => frames.push(JSON.parse(e.data as string)));
  ws.accept();
  await vi.waitFor(() => expect(frames.some((f) => f.type === GatewayMessageType.CONNECTION_STATUS)).toBe(true));
  return { ws, frames };
}

/** A node's call to the Client `clientName` on CLIENT_HOST_DO, answered to nobody. */
function callTo(clientName: string, ops: unknown[]): CallEnvelope {
  const node = { type: 'LumenizeDO' as const, bindingName: 'TEST_DO', instanceName: 'pusher' };
  return {
    version: 1,
    chain: preprocess(ops),
    callContext: { callChain: [node] },
    metadata: { caller: node, callee: { type: 'LumenizeDO', bindingName: 'CLIENT_HOST_DO', instanceName: clientName } },
  };
}

let entries: DebugLogOutput[] = [];
beforeEach(() => {
  entries = [];
  setDebugSink((e) => entries.push(e));
});
afterEach(() => clearDebugSink());

const marked = (message: string, match: (data: any) => boolean = () => true) =>
  entries.filter((e) => e.message === message && match(e.data));

describe('a node that hosts Clients', { timeout: 20000 }, () => {
  it('reaches each of two Clients on one host at its own address and at no other', async () => {
    using alice = await connect('h1');
    using dana = await connect('h1');
    const pusher = `pusher-${crypto.randomUUID()}`;
    const node = env.TEST_DO.getByName(pusher) as DurableObjectStub<TestDO>;
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: pusher });

    await node.callClient('CLIENT_HOST_DO', nameOn('h1', alice), 'receive', ['to-alice'], 'alice');
    await node.callClient('CLIENT_HOST_DO', nameOn('h1', dana), 'receive', ['to-dana'], 'dana');

    await vi.waitFor(async () => {
      expect(await node.getOutcomes('alice')).toHaveLength(1);
      expect(await node.getOutcomes('dana')).toHaveLength(1);
    }, { timeout: 5000 });
    expect(alice.received).toEqual(['to-alice']);
    expect(dana.received).toEqual(['to-dana']);
  });

  it('sends a hosted Client the answer to its call to another node, and runs nothing for it on the host', async () => {
    using alice = await connect('h2');
    const echo = await alice.lmz.callAsync('ECHO_DO', `echo-${crypto.randomUUID()}`, alice.ctn<EchoDO>().echo('hi'));

    expect(echo.message).toBe('Echo: hi');
    expect(echo.caller).toEqual({ type: 'LumenizeClient', bindingName: 'CLIENT_HOST_DO', instanceName: nameOn('h2', alice) });
    // The answer reached the Client through h2's fire-back door, and h2 admitted nothing for it.
    expect(marked('host admitted a call', (d) => d.instanceName === 'h2')).toHaveLength(0);
  });

  it('runs a hosted Client\'s call to its host in place, through the same door an RPC would pass', async () => {
    using alice = await connect('h3');
    const host = alice.ctn<ClientHostDO>();

    expect(await alice.lmz.callAsync('CLIENT_HOST_DO', 'h3', host.echo('in place'))).toBe('in place');
    expect(marked('ran in place', (d) => d.instance === 'h3')).toHaveLength(1);
    expect(marked('host admitted a call', (d) => d.instanceName === 'h3')).toHaveLength(1);

    await expect(alice.lmz.callAsync('CLIENT_HOST_DO', 'h3', host.secret())).rejects.toThrow(/secret/);
    await expect(alice.lmz.callAsync('CLIENT_HOST_DO', 'h3', host.guarded())).rejects.toThrow('Guard: hosts only');
  });

  it('pushes to its own Client and answers its Client\'s call with no RPC to itself', async () => {
    using alice = await connect('h4');
    const host = env.CLIENT_HOST_DO.getByName('h4') as DurableObjectStub<ClientHostDO>;
    const name = nameOn('h4', alice);

    expect(await alice.lmz.callAsync('CLIENT_HOST_DO', 'h4', alice.ctn<ClientHostDO>().echo('x'))).toBe('x');
    expect(marked('answered in place', (d) => d.instanceName === name)).toHaveLength(1);

    await alice.lmz.callAsync('CLIENT_HOST_DO', 'h4', alice.ctn<ClientHostDO>().pushTo(name, 'pushed', 'own'));
    await vi.waitFor(async () => expect(await host.answerFor('own')).toBe('pushed!'), { timeout: 5000 });
    expect(marked('delivered in place', (d) => d.instanceName === name)).toHaveLength(1);
  });

  it('stops a Client its host closes with 4410: the pending call is rejected, and it does not reconnect', async () => {
    const told: string[] = [];
    using alice = await connect('h7', { onHostDeleted: (e) => told.push(e.name) });

    // The call that closes the socket is still waiting for its answer when the close arrives.
    const pending = alice.lmz.callAsync('CLIENT_HOST_DO', 'h7', alice.ctn<ClientHostDO>().closeEveryClient(WS_CLOSE_GONE));
    await expect(pending).rejects.toMatchObject({ name: 'HostDeletedError' });
    expect(told).toEqual(['HostDeletedError']);
    // A scheduled reconnect would already read 'reconnecting'.
    expect(alice.connectionState).toBe('disconnected');
  });

  it('tells a Client that connects after its host closed every Client with 4410 the same', async () => {
    using alice = await connect('h9');
    await alice.lmz.callAsync('CLIENT_HOST_DO', 'h9', alice.ctn<ClientHostDO>().closeEveryClient(WS_CLOSE_GONE))
      .catch(() => undefined);

    // A page that loads while its host is still being torn down, before the reset.
    const told: string[] = [];
    const sub = crypto.randomUUID();
    const browser = new Browser();
    const late = new HostedClient({
      instanceName: `${sub}.tab1`,
      baseUrl: 'https://h9.hosted.test',
      hostFromHostname: true,
      refresh: createTestRefreshFunction({ sub }),
      fetch: browser.fetch,
      WebSocket: browser.WebSocket,
      onHostDeleted: (e) => told.push(e.name),
    });
    await vi.waitFor(() => expect(told).toEqual(['HostDeletedError']), { timeout: 10000 });
    expect(late.connectionState).toBe('disconnected');
    late.disconnect();
  });

  it('refuses a Client\'s call to another Client, on the same host and on another', async () => {
    using alice = await connect('h5');
    using dana = await connect('h5');
    using carol = await connect('h6');

    const refusal = 'Direct client-to-client calls are disabled by default';
    await expect(alice.lmz.callAsync('CLIENT_HOST_DO', nameOn('h5', dana), alice.ctn<HostedClient>().receive('x')))
      .rejects.toThrow(refusal);
    await expect(alice.lmz.callAsync('CLIENT_HOST_DO', nameOn('h6', carol), alice.ctn<HostedClient>().receive('x')))
      .rejects.toThrow(refusal);
    expect([...dana.received, ...carol.received]).toEqual([]);
  });
});

describe('a message addressed to a Client stamps no node\'s name', () => {
  it('on a never-stamped host, and on a never-stamped node that hosts none', async () => {
    const hostName = `fresh-host-${crypto.randomUUID()}`;
    const host = env.CLIENT_HOST_DO.getByName(hostName) as any;
    expect(await host.__executeOperation(callTo(`${hostName}/x.tab1`, [{ type: 'get', key: 'receive' }, { type: 'apply', args: [] }])))
      .toEqual({ $ack: true });
    await runInDurableObject(host, (instance: ClientHostDO) => expect(instance.lmz.instanceName).toBeUndefined());

    const nodeName = `fresh-node-${crypto.randomUUID()}`;
    const node = env.TEST_DO.getByName(nodeName) as any;
    const refused = await node.__executeOperation({
      ...callTo(`${nodeName}/x.tab1`, []),
      metadata: { callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: `${nodeName}/x.tab1` } },
    });
    expect('$error' in refused).toBe(true);
    await runInDurableObject(node, (instance: TestDO) => expect(instance.lmz.instanceName).toBeUndefined());

    // A call to each one's own name then stamps it as usual.
    expect(await host.__executeOperation({
      ...callTo(hostName, [{ type: 'get', key: 'echo' }, { type: 'apply', args: [1] }]),
      metadata: { callee: { type: 'LumenizeDO', bindingName: 'CLIENT_HOST_DO', instanceName: hostName } },
    })).toEqual({ $ack: true });
    await runInDurableObject(host, (instance: ClientHostDO) => expect(instance.lmz.instanceName).toBe(hostName));
  });

  it('at the fire-back door of a never-stamped host, where an answer runs nothing on the host', async () => {
    // The one state where a branch taken after the stamp would name the host after the Client and
    // run the Client's continuation there: no earlier entry has named the host.
    const hostName = `fresh-host-${crypto.randomUUID()}`;
    const host = env.CLIENT_HOST_DO.getByName(hostName) as any;
    await host.__handleResponse(callTo(`${hostName}/x.tab1`, [{ type: 'get', key: 'receive' }, { type: 'apply', args: ['answer'] }]));
    await runInDurableObject(host, (instance: ClientHostDO) => expect(instance.lmz.instanceName).toBeUndefined());
    expect(marked('host admitted a call', (d) => d.origin === 'pusher')).toHaveLength(0);
  });
});

describe('a host node\'s upgrade names exactly one Client', () => {
  it('refuses a path with no id, with two ids, or with a name longer than a tag', async () => {
    const sub = crypto.randomUUID();
    expect((await upgrade('h7', '/gateway/CLIENT_HOST_DO/h7', sub)).status).toBe(400);
    expect((await upgrade('h7', `/gateway/CLIENT_HOST_DO/h7/${sub}.tab1/more`, sub)).status).toBe(400);
    expect((await upgrade('h7', `/gateway/CLIENT_HOST_DO/h7/${sub}.${'t'.repeat(256)}`, sub)).status).toBe(400);
    expect((await upgrade('h7', `/gateway/CLIENT_HOST_DO/h7/${sub}.tab1`, sub)).status).toBe(101);
  });

  it('accepts a name of exactly 256 characters and refuses one of 257', async () => {
    // `h7/` is 3 characters and `{sub}.` 37, so 216 more make the tag 256.
    const sub = crypto.randomUUID();
    expect((await upgrade('h7', `/gateway/CLIENT_HOST_DO/h7/${sub}.${'t'.repeat(216)}`, sub)).status).toBe(101);
    expect((await upgrade('h7', `/gateway/CLIENT_HOST_DO/h7/${sub}.${'t'.repeat(217)}`, sub)).status).toBe(400);
  });

  it('refuses an id that does not start with the token\'s sub', async () => {
    expect((await upgrade('h7', '/gateway/CLIENT_HOST_DO/h7/someone-else.tab1', crypto.randomUUID())).status).toBe(403);
  });
});

describe('a reconnect on a host with several Clients', () => {
  it('resends a Client only the calls waiting for it', async () => {
    const host = 'h8';
    const aliceSub = crypto.randomUUID();
    const danaSub = crypto.randomUUID();
    await socketOn(host, aliceSub);
    const dana = await socketOn(host, danaSub);

    // A call to Dana, which she does not answer, waits for her answer.
    const stub = env.CLIENT_HOST_DO.getByName(host) as any;
    expect(await stub.__executeOperation(callTo(`${host}/${danaSub}.tab1`, [{ type: 'get', key: 'receive' }, { type: 'apply', args: ['for-dana'] }])))
      .toEqual({ $ack: true });
    await vi.waitFor(() => expect(dana.frames.some((f) => f.type === GatewayMessageType.INCOMING_CALL)).toBe(true));

    // Alice reconnects: nothing waits for her, so nothing is resent to her.
    const aliceAgain = await socketOn(host, aliceSub);
    // Dana reconnects: the call waiting for her is resent on her new socket.
    const danaAgain = await socketOn(host, danaSub);
    await vi.waitFor(() => expect(danaAgain.frames.some((f) => f.type === GatewayMessageType.INCOMING_CALL)).toBe(true));
    expect(aliceAgain.frames.filter((f) => f.type === GatewayMessageType.INCOMING_CALL)).toEqual([]);
  });
});
