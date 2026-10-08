/**
 * A node that hosts Clients: a `ScopedMeshDO`, which composes `ClientGateway`, the way a scope's
 * node hosts the Clients on its pages.
 *
 * vitest-plugin, because these limbs need a host that is not Nebula's, a node never stamped, or a
 * socket held unanswered; `scope-hosts-its-clients` and the other `/live` scenarios drive the same
 * code end to end through Nebula's pages. Each limb uses `ClientHostDO` from the test Worker, either
 * through a real `LumenizeClient` that logs in through Mesh's Registry (ADR-009 rung 2) and upgrades
 * at `/gateway/{id}` on its scope's host, or through a socket played by hand where a limb needs to
 * hold a frame unanswered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { preprocess } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import { LumenizeClient, type LumenizeClientConfig } from '../src/lumenize-client';
import { mesh } from '../src/mesh-decorator';
import { GatewayMessageType, WS_CLOSE_GONE } from '../src/gateway-messages';
import type { CallEnvelope } from '../src/lmz-api';
import type { ClientHostDO, EchoDO, TestDO } from './test-worker-and-dos';
import { loginAt, uniqueScope, type Login } from './support/login';

/** A Client whose push handler answers, and which records what it was sent. */
class HostedClient extends LumenizeClient {
  received: string[] = [];

  @mesh()
  receive(value: string): string {
    this.received.push(value);
    return `${value}!`;
  }
}

/** A real Client on `host`'s page, logged in there, upgrading at `/gateway/{sub}.tab1`. */
async function connect(host: string, extra: Partial<LumenizeClientConfig> = {}): Promise<HostedClient> {
  const login = await loginAt(host);
  const browser = new Browser();
  const client = new HostedClient({
    instanceName: `${login.sub}.tab1`,
    baseUrl: login.baseUrl,
    refresh: login.refresh,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    ...extra,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

/** A hosted Client's name on its host: `h-1a2b3c4d/{sub}.tab1`. */
const nameOn = (host: string, client: LumenizeClient) => `${host}/${client.lmz.instanceName}`;

/** Upgrade straight to the host with `path` and `login`'s token, as the Worker's forward delivers it. */
function upgrade(host: string, path: string, login: Login): Promise<Response> {
  return env.CLIENT_HOST_DO.getByName(host).fetch(`https://example.com${path}`, {
    headers: {
      'Upgrade': 'websocket',
      'Sec-WebSocket-Protocol': 'lmz.2',
      'Authorization': `Bearer ${login.accessToken}`,
      'X-Lumenize-DO-Instance-Name-Or-Id': host,
      'X-Lumenize-DO-Binding-Name': 'CLIENT_HOST_DO',
    },
  });
}

/** A socket played by hand on `host` under the id `{sub}.tab1`, open once the host has said hello. */
async function socketOn(host: string, login: Login): Promise<{ ws: WebSocket; frames: any[] }> {
  const res = await upgrade(host, `/gateway/CLIENT_HOST_DO/${host}/${login.sub}.tab1`, login);
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const frames: any[] = [];
  ws.addEventListener('message', (e: MessageEvent) => frames.push(JSON.parse(e.data as string)));
  ws.accept();
  await vi.waitFor(() => expect(frames.some((f) => f.type === GatewayMessageType.CONNECTION_STATUS)).toBe(true));
  return { ws, frames };
}

/** The node that pushes to a Client in these limbs: a `TestDO`, named by an id. */
const PUSHER = 'pusher_node';

/** A node's call to the Client `clientName` on CLIENT_HOST_DO, answered to nobody. */
function callTo(clientName: string, ops: unknown[]): CallEnvelope {
  const node = { type: 'LumenizeDO' as const, bindingName: 'TEST_DO', instanceName: PUSHER };
  return {
    version: 1,
    chain: preprocess(ops),
    callContext: { callChain: [node] },
    metadata: { caller: node, callee: { type: 'LumenizeDO', bindingName: 'CLIENT_HOST_DO', instanceName: clientName } },
  };
}

/** A Client's upgrade through the test Worker, at `/gateway/{id}` on `host`'s page. */
function upgradeThroughWorker(host: string, id: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Upgrade': 'websocket' };
  headers['Sec-WebSocket-Protocol'] = token ? `lmz.2, lmz.access-token.${token}` : 'lmz.2';
  return SELF.fetch(`http://${host}.lumenize.localhost/gateway/${id}`, { headers });
}

/** A token shaped like `claims` and signed by no key the Worker trusts. */
function forgedToken(claims: Record<string, unknown>): string {
  const enc = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'BLUE' })}.${enc(claims)}.${enc({ forged: true })}`;
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
    const h = uniqueScope('h');
    using alice = await connect(h);
    using dana = await connect(h);
    const node = env.TEST_DO.getByName(PUSHER) as DurableObjectStub<TestDO>;
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: PUSHER });

    await node.callClient('CLIENT_HOST_DO', nameOn(h, alice), 'receive', ['to-alice'], 'alice');
    await node.callClient('CLIENT_HOST_DO', nameOn(h, dana), 'receive', ['to-dana'], 'dana');

    await vi.waitFor(async () => {
      expect(await node.getOutcomes('alice')).toHaveLength(1);
      expect(await node.getOutcomes('dana')).toHaveLength(1);
    }, { timeout: 5000 });
    expect(alice.received).toEqual(['to-alice']);
    expect(dana.received).toEqual(['to-dana']);
  });

  it('sends a hosted Client the answer to its call to another node, and runs nothing for it on the host', async () => {
    const h = uniqueScope('h');
    using alice = await connect(h);
    const echo = await alice.lmz.callAsync('ECHO_DO', `echo_${crypto.randomUUID()}`, alice.ctn<EchoDO>().echo('hi'));

    expect(echo.message).toBe('Echo: hi');
    expect(echo.caller).toEqual({ type: 'LumenizeClient', bindingName: 'CLIENT_HOST_DO', instanceName: nameOn(h, alice) });
    // The answer reached the Client through the host's fire-back door, and the host admitted nothing for it.
    expect(marked('host admitted a call', (d) => d.instanceName === h)).toHaveLength(0);
  });

  it('runs a hosted Client\'s call to its host in place, through the same door an RPC would pass', async () => {
    const h = uniqueScope('h');
    using alice = await connect(h);
    const host = alice.ctn<ClientHostDO>();

    expect(await alice.lmz.callAsync('CLIENT_HOST_DO', h, host.echo('in place'))).toBe('in place');
    expect(marked('ran in place', (d) => d.instance === h)).toHaveLength(1);
    expect(marked('host admitted a call', (d) => d.instanceName === h)).toHaveLength(1);

    await expect(alice.lmz.callAsync('CLIENT_HOST_DO', h, host.secret())).rejects.toThrow(/secret/);
    await expect(alice.lmz.callAsync('CLIENT_HOST_DO', h, host.guarded())).rejects.toThrow('Guard: hosts only');
  });

  it('pushes to its own Client and answers its Client\'s call with no RPC to itself', async () => {
    const h = uniqueScope('h');
    using alice = await connect(h);
    const host = env.CLIENT_HOST_DO.getByName(h) as DurableObjectStub<ClientHostDO>;
    const name = nameOn(h, alice);

    expect(await alice.lmz.callAsync('CLIENT_HOST_DO', h, alice.ctn<ClientHostDO>().echo('x'))).toBe('x');
    expect(marked('answered in place', (d) => d.instanceName === name)).toHaveLength(1);

    await alice.lmz.callAsync('CLIENT_HOST_DO', h, alice.ctn<ClientHostDO>().pushTo(name, 'pushed', 'own'));
    await vi.waitFor(async () => expect(await host.answerFor('own')).toBe('pushed!'), { timeout: 5000 });
    expect(marked('delivered in place', (d) => d.instanceName === name)).toHaveLength(1);
  });

  it('stops a Client its host closes with 4410: the pending call is rejected, and it does not reconnect', async () => {
    const h = uniqueScope('h');
    const told: string[] = [];
    using alice = await connect(h, { onHostDeleted: (e) => told.push(e.name) });

    // The call that closes the socket is still waiting for its answer when the close arrives.
    const pending = alice.lmz.callAsync('CLIENT_HOST_DO', h, alice.ctn<ClientHostDO>().closeEveryClient(WS_CLOSE_GONE));
    await expect(pending).rejects.toMatchObject({ name: 'HostDeletedError' });
    expect(told).toEqual(['HostDeletedError']);
    // A scheduled reconnect would already read 'reconnecting'.
    expect(alice.connectionState).toBe('disconnected');
  });

  it('refuses a Client\'s call to another Client, on the same host and on another', async () => {
    const h5 = uniqueScope('h');
    const h6 = uniqueScope('h');
    using alice = await connect(h5);
    using dana = await connect(h5);
    using carol = await connect(h6);

    const refusal = 'Direct client-to-client calls are disabled by default';
    await expect(alice.lmz.callAsync('CLIENT_HOST_DO', nameOn(h5, dana), alice.ctn<HostedClient>().receive('x')))
      .rejects.toThrow(refusal);
    await expect(alice.lmz.callAsync('CLIENT_HOST_DO', nameOn(h6, carol), alice.ctn<HostedClient>().receive('x')))
      .rejects.toThrow(refusal);
    expect([...dana.received, ...carol.received]).toEqual([]);
  });
});

describe('a message addressed to a Client stamps no node\'s name', () => {
  it('on a never-stamped host, and on a never-stamped node that hosts none', async () => {
    const hostName = uniqueScope('fresh');
    // The claim wipes the host's node, as a creation does, so the host is still never stamped after it.
    const login = await loginAt(hostName);
    const host = env.CLIENT_HOST_DO.getByName(hostName) as any;
    expect(await host.__executeOperation(callTo(`${hostName}/x.tab1`, [{ type: 'get', key: 'receive' }, { type: 'apply', args: [] }])))
      .toEqual({ $ack: true });
    await runInDurableObject(host, (instance: ClientHostDO) => expect(instance.lmz.instanceName).toBeUndefined());

    const nodeName = `fresh_node_${crypto.randomUUID()}`;
    const node = env.TEST_DO.getByName(nodeName) as any;
    const refused = await node.__executeOperation({
      ...callTo(`${nodeName}/x.tab1`, []),
      metadata: { callee: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: `${nodeName}/x.tab1` } },
    });
    expect('$error' in refused).toBe(true);
    await runInDurableObject(node, (instance: TestDO) => expect(instance.lmz.instanceName).toBeUndefined());

    // A call to each one's own name then stamps it as usual. The host is a scoped node, so the call
    // carries a token with passage into it.
    expect(await host.__executeOperation({
      ...callTo(hostName, [{ type: 'get', key: 'echo' }, { type: 'apply', args: [1] }]),
      callContext: { callChain: [{ type: 'LumenizeClient', bindingName: 'CLIENT_HOST_DO', instanceName: `${hostName}/${login.sub}.tab1` }], originAuth: { sub: login.sub, claims: parseClaims(login.accessToken) } },
      metadata: { callee: { type: 'LumenizeDO', bindingName: 'CLIENT_HOST_DO', instanceName: hostName } },
    })).toEqual({ $ack: true });
    await runInDurableObject(host, (instance: ClientHostDO) => expect(instance.lmz.instanceName).toBe(hostName));
  });

  it('at the fire-back door of a never-stamped host, where an answer runs nothing on the host', async () => {
    // The one state where a branch taken after the stamp would name the host after the Client and
    // run the Client's continuation there: no earlier entry has named the host.
    const hostName = uniqueScope('fresh');
    const host = env.CLIENT_HOST_DO.getByName(hostName) as any;
    await host.__handleResponse(callTo(`${hostName}/x.tab1`, [{ type: 'get', key: 'receive' }, { type: 'apply', args: ['answer'] }]));
    await runInDurableObject(host, (instance: ClientHostDO) => expect(instance.lmz.instanceName).toBeUndefined());
    expect(marked('host admitted a call', (d) => d.origin === PUSHER)).toHaveLength(0);
  });
});

describe('a host node\'s upgrade names exactly one Client', () => {
  it('refuses a path with no id, with two ids, or with a name longer than a tag', async () => {
    const h = uniqueScope('h');
    const login = await loginAt(h);
    expect((await upgrade(h, `/gateway/CLIENT_HOST_DO/${h}`, login)).status).toBe(400);
    expect((await upgrade(h, `/gateway/CLIENT_HOST_DO/${h}/${login.sub}.tab1/more`, login)).status).toBe(400);
    expect((await upgrade(h, `/gateway/CLIENT_HOST_DO/${h}/${login.sub}.${'t'.repeat(256)}`, login)).status).toBe(400);
    expect((await upgrade(h, `/gateway/CLIENT_HOST_DO/${h}/${login.sub}.tab1`, login)).status).toBe(101);
  });

  it('accepts a name of exactly 256 characters and refuses one of 257', async () => {
    const h = uniqueScope('h');
    const login = await loginAt(h);
    // The tag is `{host}/{sub}.{tab}`: what the host and `{sub}.` leave of 256 goes to the tab.
    const room = 256 - `${h}/${login.sub}.`.length;
    expect((await upgrade(h, `/gateway/CLIENT_HOST_DO/${h}/${login.sub}.${'t'.repeat(room)}`, login)).status).toBe(101);
    expect((await upgrade(h, `/gateway/CLIENT_HOST_DO/${h}/${login.sub}.${'t'.repeat(room + 1)}`, login)).status).toBe(400);
  });
});

describe('a test Worker\'s upgrade, through Mesh\'s hostedUpgrade', () => {
  // The refusals a Client's upgrade meets before routing, so no upgrade reaches a node without a valid
  // token for its host whose `sub` begins the id. Mutation: skip the verify call in `hostedUpgrade` →
  // the forged token, which carries the right `aud` and `sub`, upgrades.
  it('refuses no token with 401 and a forged one with 403, and admits a real one', async () => {
    const h = uniqueScope('h');
    const login = await loginAt(h);
    const id = `${login.sub}.tab1`;

    const none = await upgradeThroughWorker(h, id);
    expect(none.status).toBe(401);
    expect(await none.text()).toBe('Unauthorized: missing access token');

    const now = Math.floor(Date.now() / 1000);
    const forged = forgedToken({ ...parseClaims(login.accessToken), iat: now, exp: now + 900 });
    const refused = await upgradeThroughWorker(h, id, forged);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe('Forbidden: invalid JWT');

    expect((await upgradeThroughWorker(h, id, login.accessToken)).status).toBe(101);
  });

  it('refuses a token for another host, and an id that does not begin with the token\'s sub', async () => {
    const h = uniqueScope('h');
    const elsewhere = await loginAt(uniqueScope('h'));
    const login = await loginAt(h);

    const otherHost = await upgradeThroughWorker(h, `${elsewhere.sub}.tab1`, elsewhere.accessToken);
    expect(otherHost.status).toBe(403);
    expect(await otherHost.text()).toBe('Forbidden: the token is for another host');

    const notMine = await upgradeThroughWorker(h, 'someone-else.tab1', login.accessToken);
    expect(notMine.status).toBe(403);
    expect(await notMine.text()).toBe('Forbidden: identity mismatch');
  });

  // `{sub}x` has no dot, and every character but its last is the sub, so only the dot check
  // refuses it. MUTATION: drop `dot === -1 ||` from `hostedUpgrade`, and it upgrades.
  it('refuses an id with no dot, which names no tab of the token\'s sub', async () => {
    const h = uniqueScope('h');
    const login = await loginAt(h);
    const nodot = await upgradeThroughWorker(h, `${login.sub}x`, login.accessToken);
    expect(nodot.status).toBe(403);
    expect(await nodot.text()).toBe('Forbidden: identity mismatch');
  });
});

describe('a reconnect on a host with several Clients', () => {
  it('resends a Client only the calls waiting for it', async () => {
    const host = uniqueScope('h');
    const alice = await loginAt(host);
    const danaLogin = await loginAt(host);
    await socketOn(host, alice);
    const dana = await socketOn(host, danaLogin);

    // A call to Dana, which she does not answer, waits for her answer.
    const stub = env.CLIENT_HOST_DO.getByName(host) as any;
    expect(await stub.__executeOperation(callTo(`${host}/${danaLogin.sub}.tab1`, [{ type: 'get', key: 'receive' }, { type: 'apply', args: ['for-dana'] }])))
      .toEqual({ $ack: true });
    await vi.waitFor(() => expect(dana.frames.some((f) => f.type === GatewayMessageType.INCOMING_CALL)).toBe(true));

    // Alice reconnects: nothing waits for her, so nothing is resent to her.
    const aliceAgain = await socketOn(host, alice);
    // Dana reconnects: the call waiting for her is resent on her new socket.
    const danaAgain = await socketOn(host, danaLogin);
    await vi.waitFor(() => expect(danaAgain.frames.some((f) => f.type === GatewayMessageType.INCOMING_CALL)).toBe(true));
    expect(aliceAgain.frames.filter((f) => f.type === GatewayMessageType.INCOMING_CALL)).toEqual([]);
  });
});

/** The claims a token carries, decoded as the host decodes them. */
function parseClaims(token: string): Record<string, unknown> {
  return parseJwtUnsafe(token)!.payload as unknown as Record<string, unknown>;
}
