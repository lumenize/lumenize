import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { preprocess, parse } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import {
  GatewayMessageType,
  type ConnectionStatusMessage,
} from '../src/gateway-messages';
import { MeshClient } from '../src/mesh-client';
import { mesh } from '../src/mesh-decorator';
import { connectClient, loginOf, uniqueScope } from './support/login';

/** A Client whose one push handler never answers, as a tab the browser froze. */
class FrozenClient extends MeshClient {
  @mesh()
  hang(): Promise<never> {
    return new Promise(() => {});
  }
}

/**
 * Tests of a host's `ClientGateway` that need its grace period to RUN OUT. They live in the
 * `gateway-timing` project, whose `LUMENIZE_MESH_GRACE_PERIOD_MS` is short, because every `main`
 * project keeps the 60 s test-mode grace period that its reconnect tests rely on under contention.
 *
 * Each test gets a host of its own, `HOST`, a `ClientHostDO`; a Client `x.tab1` on it is
 * `{HOST}/x.tab1`.
 */

/** The host every Client in the running test is on: a scope only that test names. */
let HOST: string;
beforeEach(() => { HOST = uniqueScope('gw'); });
/** The running test's host. */
const host = () => env.CLIENT_HOST_DO.getByName(HOST) as any;
/** A Client's name on the running test's host: `{HOST}/x.tab1`. */
const clientOn = (id: string) => `${HOST}/${id}`;

/**
 * A structurally valid JWT, ADR-009 rung 3, justified: these limbs upgrade straight into the host,
 * past the Worker, so nothing verifies a signature and the host decodes only the claims; one limb
 * needs a token that lapses two seconds after it is minted.
 */
function createFakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64(payload)}.fakesig`;
}

/** Upgrade as `instanceName`, and return the socket with its `connection_status`. */
async function connect(
  gateway: DurableObjectStub,
  instanceName: string,
  exp = Math.floor(Date.now() / 1000) + 900,
): Promise<{ ws: WebSocket; status: ConnectionStatusMessage }> {
  const sub = instanceName.split('.')[0];
  const response = await gateway.fetch(`https://example.com/gateway/CLIENT_HOST_DO/${HOST}/${instanceName}`, {
    headers: {
      'Upgrade': 'websocket',
      'Sec-WebSocket-Protocol': 'lmz.2',
      'Authorization': `Bearer ${createFakeJwt({ sub, exp })}`,
      'X-Lumenize-DO-Instance-Name-Or-Id': HOST,
      'X-Lumenize-DO-Binding-Name': 'CLIENT_HOST_DO',
    },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  const status = await new Promise<ConnectionStatusMessage>((resolve) => {
    ws.addEventListener('message', function handler(event: MessageEvent) {
      const msg = JSON.parse(event.data as string);
      if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    });
  });
  return { ws, status };
}

/** Wait for a Gateway marker naming `instanceName`. */
async function waitForMarker(entries: DebugLogOutput[], message: string, instanceName: string): Promise<void> {
  await vi.waitFor(() => {
    expect(entries.some((e) => e.message === message && e.data?.instanceName === instanceName)).toBe(true);
  }, { timeout: 5000 });
}

describe('a host\'s grace period running out', () => {
  it('reports subscriptionRequired: true after the grace period ends', async () => {
    const entries: DebugLogOutput[] = [];
    setDebugSink((e) => entries.push(e));
    try {
      const name = 'grace-expired.tab1';
      const gateway = host();

      const { ws } = await connect(gateway, name);
      ws.close(1000, 'Normal close');
      await waitForMarker(entries, 'grace period started', clientOn(name));
      await waitForMarker(entries, 'Grace period expired', clientOn(name));

      const { ws: ws2, status } = await connect(gateway, name);
      expect(status.subscriptionRequired).toBe(true);
      ws2.close();
    } finally {
      clearDebugSink();
    }
  }, 10_000);

  // The call timeout is short in this project. A Client that never answers is answered
  // ClientDisconnectedError, which a reaper drops its row on, so its socket is closed with 4408 to
  // make it reconnect, and that connection is told to re-subscribe.
  it('a push the Client never answers times out: the node hears ClientDisconnectedError and the socket closes with 4408', async () => {
    const name = 'timeout-4408.tab1';
    const gateway = host() as any;
    const { ws } = await connect(gateway, name);
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
    // Deliberately never answers the INCOMING_CALL.

    const recorder = { type: 'LumenizeDO' as const, bindingName: 'TEST_DO', instanceName: 'timeout_4408_recorder' };
    expect(await gateway.__executeOperation({
      version: 1,
      chain: preprocess([{ type: 'get', key: 'noSuchClientMethod' }, { type: 'apply', args: [] }]),
      callContext: { callChain: [recorder] },
      metadata: { caller: recorder, callee: { type: 'LumenizeDO', bindingName: 'CLIENT_HOST_DO', instanceName: clientOn(name) } },
      response: { kind: 'mesh', returnAddr: recorder, handler: preprocess([{ type: 'get', key: 'recordOutcome' }, { type: 'apply', args: ['timeout'] }]) },
    })).toEqual({ $ack: true });

    const error = await vi.waitFor(async () => {
      const kept = await env.TEST_DO.getByName(recorder.instanceName).getOutcomes('timeout');
      expect(kept).toHaveLength(1);
      return parse(kept[0]).result;
    }, { timeout: 5000 });
    expect({ name: error.name, message: error.message })
      .toEqual({ name: 'ClientDisconnectedError', message: 'Client call timed out' });
    const code = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('no close'), 2000))]);
    expect(code).toBe(4408);

    // A Client that never sees the close code, its close frame lost, is told by the Gateway itself.
    // MUTATION: never record the loss on the grace period, and a reconnect inside it is told `false`.
    const { ws: back, status } = await connect(gateway, name);
    expect(status.subscriptionRequired).toBe(true);
    back.close();
  }, 10_000);

  // The push goes down a socket that then closes before the Client answers, so the Gateway's
  // timeout finds no socket to close with 4408. It marks the grace period instead.
  it('a push that times out after its socket closed tells the Client\'s next connection subscriptionRequired: true', async () => {
    const entries: DebugLogOutput[] = [];
    setDebugSink((e) => entries.push(e));
    try {
      const name = 'timeout-after-close.tab1';
      const gateway = host() as any;
      const { ws } = await connect(gateway, name);
      const incoming = new Promise<void>((resolve) => ws.addEventListener('message', (e) => {
        if (JSON.parse(e.data as string).type === GatewayMessageType.INCOMING_CALL) resolve();
      }));

      const recorder = { type: 'LumenizeDO' as const, bindingName: 'TEST_DO', instanceName: 'timeout_after_close_recorder' };
      expect(await gateway.__executeOperation({
        version: 1,
        chain: preprocess([{ type: 'get', key: 'someMethod' }, { type: 'apply', args: [] }]),
        callContext: { callChain: [recorder] },
        metadata: { caller: recorder, callee: { type: 'LumenizeDO', bindingName: 'CLIENT_HOST_DO', instanceName: clientOn(name) } },
        response: { kind: 'mesh', returnAddr: recorder, handler: preprocess([{ type: 'get', key: 'recordOutcome' }, { type: 'apply', args: ['gone'] }]) },
      })).toEqual({ $ack: true });
      await incoming;
      ws.close(1000, 'the network went away');
      await waitForMarker(entries, 'grace period started', clientOn(name));

      // The timeout answers the node, which would drop this Client's subscriber row on it.
      await vi.waitFor(async () => {
        const kept = await env.TEST_DO.getByName(recorder.instanceName).getOutcomes('gone');
        expect(kept).toHaveLength(1);
        expect(parse(kept[0]).result.name).toBe('ClientDisconnectedError');
      }, { timeout: 5000 });

      // MUTATION: never record the loss on the grace period, and this reconnect is told `false`.
      const { ws: back, status } = await connect(gateway, name);
      expect(status.subscriptionRequired).toBe(true);
      back.close();
    } finally {
      clearDebugSink();
    }
  }, 10_000);

  // A real Client misses a real answer. The Gateway closes its socket with 4408, and tells its
  // reconnect, back inside the grace period, that its subscriptions may be gone: that report is the
  // only signal the Client acts on.
  it('a Client that misses an answer re-subscribes on its reconnect inside the grace period', async () => {
    let required = 0;
    using client = await connectClient(FrozenClient, HOST, { onSubscriptionRequired: () => { required += 1; } });
    const { sub } = loginOf(client);
    expect(required).toBe(1); // a first connection

    // POSITIVE CONTROL: a close that loses nothing, back inside the grace period.
    await runInDurableObject(host(), (_instance: unknown, ctx: DurableObjectState) => {
      for (const ws of ctx.getWebSockets(clientOn(`${sub}.tab1`))) ws.close(4000, 'the network dropped');
    });
    await vi.waitFor(() => expect(client.connectionState).toBe('reconnecting'));
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10_000 });
    expect(required).toBe(1);

    const name = `frozen_${sub}`;
    const node = env.TEST_DO.getByName(name);
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
    await node.callClient('CLIENT_HOST_DO', clientOn(client.lmz.instanceName!), 'hang', [], 'frozen');
    await vi.waitFor(() => expect(client.connectionState).toBe('reconnecting'), { timeout: 5_000 });
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10_000 });
    // MUTATION: never record the loss at the host, and this reconnect is told `false`.
    expect(required).toBe(2);
    const [kept] = await node.getOutcomes('frozen');
    expect(parse(kept).result.name).toBe('ClientDisconnectedError');
  }, 20_000);

  it('a call waiting in the grace period answers ClientDisconnectedError when it ends', async () => {
    const entries: DebugLogOutput[] = [];
    setDebugSink((e) => entries.push(e));
    try {
      const name = 'grace-exec-expiry.tab1';
      const gateway = host() as any;

      const { ws } = await connect(gateway, name);
      ws.close(1000, 'Normal close');
      await waitForMarker(entries, 'grace period started', clientOn(name));

      // Acked at once; the delivery parks in the grace period's wait, and nothing reconnects, so the
      // deadline fails it and the node's handler hears so.
      const recorder = { type: 'LumenizeDO' as const, bindingName: 'TEST_DO', instanceName: 'grace_exec_expiry_recorder' };
      const ack = await gateway.__executeOperation({
        version: 1,
        chain: preprocess([
          { type: 'get', key: 'someMethod' },
          { type: 'apply', args: [] },
        ]),
        callContext: { callChain: [recorder] },
        metadata: { caller: recorder, callee: { type: 'LumenizeDO', bindingName: 'CLIENT_HOST_DO', instanceName: clientOn(name) } },
        response: { kind: 'mesh', returnAddr: recorder, handler: preprocess([{ type: 'get', key: 'recordOutcome' }, { type: 'apply', args: ['expiry'] }]) },
      });
      expect(ack).toEqual({ $ack: true });

      // Filled through structured-clone, so the class's name survives the fire-back.
      const error = await vi.waitFor(async () => {
        const kept = await env.TEST_DO.getByName(recorder.instanceName).getOutcomes('expiry');
        expect(kept).toHaveLength(1);
        return parse(kept[0]).result;
      }, { timeout: 8000 });
      expect({ name: error.name, message: error.message })
        .toEqual({ name: 'ClientDisconnectedError', message: 'Client did not reconnect within grace period' });
    } finally {
      clearDebugSink();
    }
  }, 10_000);

  // A Client whose network died never echoes the Gateway's 4408, so the socket stays listed, closing,
  // past the grace period, and the close may arrive later still. Neither must read as a Client with
  // nothing lost. A socket the test has not accepted echoes nothing until it is accepted.
  describe('a failed delivery is still reported after the grace period ends', () => {
    /** Upgrade as `name` without accepting the test's end, and let a push to it time out. */
    async function lostOnADeadSocket(name: string, recorderName: string, entries: DebugLogOutput[]): Promise<{ gateway: any; ws: WebSocket }> {
      const gateway = host() as any;
      const response = await gateway.fetch(`https://example.com/gateway/CLIENT_HOST_DO/${HOST}/${name}`, {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${createFakeJwt({ sub: name.split('.')[0], exp: Math.floor(Date.now() / 1000) + 900 })}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': HOST,
          'X-Lumenize-DO-Binding-Name': 'CLIENT_HOST_DO',
        },
      });
      expect(response.status).toBe(101);
      const recorder = { type: 'LumenizeDO' as const, bindingName: 'TEST_DO', instanceName: recorderName };
      expect(await gateway.__executeOperation({
        version: 1,
        chain: preprocess([{ type: 'get', key: 'someMethod' }, { type: 'apply', args: [] }]),
        callContext: { callChain: [recorder] },
        metadata: { caller: recorder, callee: { type: 'LumenizeDO', bindingName: 'CLIENT_HOST_DO', instanceName: clientOn(name) } },
        response: { kind: 'mesh', returnAddr: recorder, handler: preprocess([{ type: 'get', key: 'recordOutcome' }, { type: 'apply', args: ['lost'] }]) },
      })).toEqual({ $ack: true });
      await vi.waitFor(async () => {
        expect(await env.TEST_DO.getByName(recorderName).getOutcomes('lost')).toHaveLength(1);
      }, { timeout: 5000 });
      await waitForMarker(entries, 'Grace period expired', clientOn(name));
      return { gateway, ws: response.webSocket! };
    }

    it('while the Gateway still lists the socket it closed', async () => {
      const entries: DebugLogOutput[] = [];
      setDebugSink((e) => entries.push(e));
      try {
        const name = 'lost-listed.tab1';
        const { gateway } = await lostOnADeadSocket(name, 'lost_listed_recorder', entries);
        // MUTATION: read the loss only from the grace period, and the closing socket reads as a
        // supersede, told `false`.
        const { ws: back, status } = await connect(gateway, name);
        expect(status.subscriptionRequired).toBe(true);
        back.close();
      } finally {
        clearDebugSink();
      }
    }, 15_000);

    it('when the close finally arrives', async () => {
      const entries: DebugLogOutput[] = [];
      setDebugSink((e) => entries.push(e));
      try {
        const name = 'lost-late-close.tab1';
        const { gateway, ws } = await lostOnADeadSocket(name, 'lost_late_close_recorder', entries);
        ws.accept(); // the network comes back, and the 4408 is echoed at last
        await waitForMarker(entries, 'grace period started', clientOn(name));
        // MUTATION: start that grace period without the loss, and the reconnect inside it is told `false`.
        const { ws: back, status } = await connect(gateway, name);
        expect(status.subscriptionRequired).toBe(true);
        back.close();
      } finally {
        clearDebugSink();
      }
    }, 15_000);
  });

  // A Client whose session was revoked cannot refresh, so it never comes back after the 4401 close,
  // and the push held for it is answered as any missed reconnect is. A real lapse, as in
  // `client-gateway.test.ts`, where the Client does come back.
  it('a push held at a lapsed token answers ClientDisconnectedError when the Client never comes back', async () => {
    const name = 'lapsed-gone.tab1';
    const gateway = host() as any;
    const { ws } = await connect(gateway, name, Math.floor(Date.now() / 1000) + 2);
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
    await new Promise((r) => setTimeout(r, 2500));

    const recorder = { type: 'LumenizeDO' as const, bindingName: 'TEST_DO', instanceName: 'lapsed_gone_recorder' };
    expect(await gateway.__executeOperation({
      version: 1,
      chain: preprocess([{ type: 'get', key: 'someMethod' }, { type: 'apply', args: [] }]),
      callContext: { callChain: [recorder] },
      metadata: { caller: recorder, callee: { type: 'LumenizeDO', bindingName: 'CLIENT_HOST_DO', instanceName: clientOn(name) } },
      response: { kind: 'mesh', returnAddr: recorder, handler: preprocess([{ type: 'get', key: 'recordOutcome' }, { type: 'apply', args: ['lapsed'] }]) },
    })).toEqual({ $ack: true });
    expect(await closed).toBe(4401);

    // MUTATION: answer at once at the lapse, and the node hears it before any grace period.
    const error = await vi.waitFor(async () => {
      const kept = await env.TEST_DO.getByName(recorder.instanceName).getOutcomes('lapsed');
      expect(kept).toHaveLength(1);
      return parse(kept[0]).result;
    }, { timeout: 8000 });
    expect({ name: error.name, message: error.message })
      .toEqual({ name: 'ClientDisconnectedError', message: 'Client did not reconnect within grace period' });
  }, 15_000);
});
