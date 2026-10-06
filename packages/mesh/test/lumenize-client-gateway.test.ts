import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { stringify, parse, preprocess, postprocess } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import {
  GatewayMessageType,
  ClientDisconnectedError,
  WS_CLOSE_SUPERSEDED,
  type ConnectionStatusMessage,
  type CallMessage,
  type ResponseMessage,
  type IncomingCallMessage,
  type IncomingCallResponseMessage,
} from '../src/lumenize-client-gateway';
import type { CallEnvelope } from '../src/lmz-api';

/**
 * Create a fake JWT for gateway unit tests.
 * Gateway decodes JWT payload inline (no signature verification — Worker hooks already verified).
 * This builds a structurally valid JWT with the given payload claims.
 */
function createFakeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = 'fakesig';
  return `${header}.${body}.${sig}`;
}

/** Wait until the Gateway has processed a close and started `instanceName`'s grace period. */
async function waitForGracePeriod(entries: DebugLogOutput[], instanceName: string): Promise<void> {
  await vi.waitFor(() => {
    expect(entries.some((e) => e.message === 'grace period started' && e.data?.instanceName === instanceName)).toBe(true);
  });
}

/** Upgrade with extra headers, wait for connection_status, return the socket. */
async function connectWith(
  gateway: DurableObjectStub,
  instanceName: string,
  sub: string,
  extraHeaders: Record<string, string>,
): Promise<WebSocket> {
  const token = createFakeJwt({ sub, exp: Math.floor(Date.now() / 1000) + 900 });
  const response = await gateway.fetch('https://example.com', {
    headers: {
      'Upgrade': 'websocket',
      'Sec-WebSocket-Protocol': 'lmz.2',
      'Authorization': `Bearer ${token}`,
      'X-Lumenize-DO-Instance-Name-Or-Id': instanceName,
      'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
      ...extraHeaders,
    },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  await new Promise<void>((resolve) => {
    ws.addEventListener('message', function handler(event: MessageEvent) {
      const msg = JSON.parse(event.data as string);
      if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
        ws.removeEventListener('message', handler);
        resolve();
      }
    });
  });
  return ws;
}

/**
 * Send one client call and return its postprocessed result. `callContext` is sent as given though
 * `CallMessage` has no such field, which is how a test plays a hostile client.
 */
async function callAndAwait(
  ws: WebSocket, callId: string, binding: string, instance: string, ops: unknown[],
  callContext?: Record<string, unknown>,
): Promise<any> {
  const responsePromise = new Promise<Answer>((resolve) => {
    ws.addEventListener('message', function handler(event: MessageEvent) {
      const msg = JSON.parse(event.data as string);
      if (msg.type === GatewayMessageType.RESPONSE && msg.callId === callId) {
        ws.removeEventListener('message', handler);
        resolve(answerOf(msg));
      }
    });
  });
  const callMessage: CallMessage & { callContext?: Record<string, unknown> } = {
    type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER, callId, binding, instance,
    chain: preprocess(ops),
    ...(callContext ? { callContext } : {}),
  };
  ws.send(JSON.stringify(callMessage));
  const res = await responsePromise;
  expect(res.success).toBe(true);
  return res.result;
}

const GET_CONTEXT = [{ type: 'get', key: 'getCallContext' }, { type: 'apply', args: [] }];

/** The `loadId` every hand-built call frame here carries, and its answers echo. */
const LOAD_ID = 'test-load';
/** A result handler continuation for a hand-built call frame; its answer fills the last argument. */
const HANDLER = preprocess([{ type: 'get', key: 'onAnswer' }, { type: 'apply', args: [] }]);

/** A node's fire-back to a Client's Gateway: the Client's handler, filled with `value`. */
function fireBackTo(clientInstanceName: string, callId: string, value: unknown): CallEnvelope {
  return {
    version: 1,
    chain: preprocess([{ type: 'get', key: 'onAnswer' }, { type: 'apply', args: [value] }]),
    callContext: { callChain: [
      { type: 'LumenizeClient', bindingName: 'LUMENIZE_CLIENT_GATEWAY', instanceName: clientInstanceName },
      { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'answering-node' },
    ] },
    metadata: {
      caller: { type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'answering-node' },
      callee: { type: 'LumenizeClient', bindingName: 'LUMENIZE_CLIENT_GATEWAY', instanceName: clientInstanceName },
    },
    callId,
    loadId: LOAD_ID,
  };
}

/** What a `response` frame answered: the filled handler's last argument, a value or an Error. */
interface Answer { callId: string; loadId: string; success: boolean; result?: any; error?: any; callChain: any[] }
function answerOf(frame: ResponseMessage): Answer {
  const chain = postprocess(frame.chain) as Array<{ type: string; args?: unknown[] }>;
  const value = chain.at(-1)!.args!.at(-1);
  const base = { callId: frame.callId, loadId: frame.loadId, callChain: frame.callContext.callChain };
  return value instanceof Error ? { ...base, success: false, error: value } : { ...base, success: true, result: value };
}

/** The claims a node's call carries, which a test tells apart from the Client socket's own. */
const NODE_ORIGIN_AUTH = { sub: 'node-origin', claims: { aud: 'node-origin' } };

/**
 * A node's call to `client`, as `lmz.call` builds one: the node is `returnAddr`, and its result
 * handler continuation, `recordOutcome(tag)` on TEST_DO `recorder`, rides in `response`.
 * `metadata.callee` is typed as `lmz.call` types it, a DO, which the Gateway must not copy.
 */
function callToClient(
  client: string, recorder: string, tag: string,
  opts: { ops?: unknown[]; gatewayBinding?: string; callerBinding?: string } = {},
): CallEnvelope {
  const node = { type: 'LumenizeDO' as const, bindingName: 'TEST_DO', instanceName: recorder };
  return {
    version: 1,
    chain: preprocess(opts.ops ?? [{ type: 'get', key: 'someMethod' }, { type: 'apply', args: [] }]),
    callContext: { callChain: [node], originAuth: NODE_ORIGIN_AUTH },
    metadata: {
      caller: { ...node, bindingName: opts.callerBinding ?? node.bindingName },
      callee: { type: 'LumenizeDO', bindingName: opts.gatewayBinding ?? 'LUMENIZE_CLIENT_GATEWAY', instanceName: client },
    },
    response: {
      kind: 'mesh',
      returnAddr: node,
      handler: preprocess([{ type: 'get', key: 'recordOutcome' }, { type: 'apply', args: [tag] }]),
    },
  };
}

/** What TEST_DO `recorder`'s handler kept under `tag`, once the Gateway's fire-back has arrived. */
async function outcomeAt(recorder: string, tag: string): Promise<{ result: any; callee: any; callChain: any[]; originAuth: any }> {
  const node = env.TEST_DO.getByName(recorder);
  return vi.waitFor(async () => {
    const kept = await node.getOutcomes(tag);
    expect(kept).toHaveLength(1);
    return parse(kept[0]);
  }, { timeout: 5000 });
}

describe('LumenizeClientGateway', () => {
  describe('WebSocket connection', () => {
    it('rejects non-WebSocket requests', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('alice.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const response = await gateway.fetch('https://example.com', {
        method: 'GET',
      });

      expect(response.status).toBe(426); // Upgrade Required
    });

    it('rejects WebSocket upgrade without Authorization header', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('alice.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
        },
      });

      expect(response.status).toBe(401);
    });

    it('rejects WebSocket upgrade with identity mismatch', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('alice.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub: 'bob', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'alice.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(403); // Forbidden - identity mismatch
    });

    it('accepts WebSocket upgrade with valid Authorization header', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('alice.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub: 'alice', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'alice.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(101); // Switching Protocols
      expect(response.webSocket).toBeDefined();
    });

    it('sends connection_status message with subscriptionRequired: true on fresh connection', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('fresh-conn.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub: 'fresh-conn', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'fresh-conn.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(101);

      const ws = response.webSocket!;
      ws.accept();

      // Wait for connection_status message
      // Note: Gateway sends CONNECTION_STATUS via JSON.stringify (no complex types)
      const messagePromise = new Promise<ConnectionStatusMessage>((resolve) => {
        ws.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data as string) as ConnectionStatusMessage;
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            resolve(msg);
          }
        });
      });

      const statusMessage = await messagePromise;
      expect(statusMessage.type).toBe(GatewayMessageType.CONNECTION_STATUS);
      expect(statusMessage.subscriptionRequired).toBe(true);

      ws.close();
    });
  });

  describe('a push that meets an expired token waits for the reconnect', () => {
    /** Upgrade `instance` with a token carrying `claims` over a 900 s `exp`, and accept the socket. */
    async function upgrade(gateway: any, binding: string, instance: string, claims: Record<string, unknown>): Promise<WebSocket> {
      const token = createFakeJwt({ sub: instance.split('.')[0], exp: Math.floor(Date.now() / 1000) + 900, ...claims });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': instance,
          'X-Lumenize-DO-Binding-Name': binding,
        },
      });
      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();
      return ws;
    }

    /** Answer the next call down `ws` with `value`, and resolve once it has. */
    function answerNextCall(ws: WebSocket, value: unknown): Promise<void> {
      return new Promise((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type !== GatewayMessageType.INCOMING_CALL) return;
          ws.removeEventListener('message', handler);
          const answer: IncomingCallResponseMessage = {
            type: GatewayMessageType.INCOMING_CALL_RESPONSE,
            callId: (msg as IncomingCallMessage).callId,
            success: true,
            result: preprocess(value),
          };
          ws.send(JSON.stringify(answer));
          resolve();
        });
      });
    }

    /** A token that lives 2 s, and a wait past it with its socket open. */
    const shortExp = () => Math.floor(Date.now() / 1000) + 2;
    const lapse = () => new Promise((r) => setTimeout(r, 2500));

    // ⚠️ A REAL lapse on a REAL clock, not a token born expired: what a token born expired proves
    // is that the branch runs, not that a live socket survives its token lapsing under it.
    it('closes the socket with 4401, and delivers the push once the Client is back with a fresh token', async () => {
      const instance = 'lapsed.tab1';
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(instance)) as any;
      const ws = await upgrade(gateway, 'LUMENIZE_CLIENT_GATEWAY', instance, { exp: shortExp() });
      const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
      await lapse();

      expect(await gateway.__executeOperation(callToClient(instance, 'lapsed-recorder', 'lapsed'))).toEqual({ $ack: true });
      expect(await closed).toBe(4401);

      const ws2 = await upgrade(gateway, 'LUMENIZE_CLIENT_GATEWAY', instance, {});
      await answerNextCall(ws2, 'answered on the new socket');
      // MUTATION: answer at once, as before, and the node hears an Error.
      const { result } = await outcomeAt('lapsed-recorder', 'lapsed');
      expect(result).toBe('answered on the new socket');
      ws2.close();
    }, 20000);

    // The Gateway's other expiry check, on a frame the Client sends up, closes with 4401 too, and a
    // push right behind it, ahead of the Client's close echo, must wait for the reconnect as well.
    // Both run in one turn inside the Gateway here, so no echo can come between them.
    it('a push right behind a 4401 the Client\'s own frame caused waits for the reconnect', async () => {
      const instance = 'lapsed-frame.tab1';
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(instance)) as any;
      await upgrade(gateway, 'LUMENIZE_CLIENT_GATEWAY', instance, { exp: shortExp() });
      await lapse();

      await runInDurableObject(gateway, async (host: any, ctx: DurableObjectState) => {
        const [server] = ctx.getWebSockets(instance);
        void host.webSocketMessage(server, JSON.stringify({ type: GatewayMessageType.CALL }));
        expect(await host.__executeOperation(callToClient(instance, 'lapsed-frame-recorder', 'behind'))).toEqual({ $ack: true });
      });

      const ws2 = await upgrade(gateway, 'LUMENIZE_CLIENT_GATEWAY', instance, {});
      void answerNextCall(ws2, 'answered after the reconnect');
      // MUTATION: start no grace period at this 4401, and the push finds no socket and is answered
      // at once.
      const { result } = await outcomeAt('lapsed-frame-recorder', 'behind');
      expect(result).toBe('answered after the reconnect');
      ws2.close();
    }, 20000);

    // In-lane because no product path changes a claim inside one grace period. An admin's token
    // lapses under a push only admins may receive, and the Client comes back demoted.
    it('checks the held push against the new socket\'s claims, never the expired one\'s', async () => {
      const instance = 'lapsed-admin.tab1';
      const gateway = env.CUSTOM_GATEWAY.get(env.CUSTOM_GATEWAY.idFromName(instance)) as any;
      const ws = await upgrade(gateway, 'CUSTOM_GATEWAY', instance, { admin: true, exp: shortExp() });
      const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
      await lapse();

      expect(await gateway.__executeOperation(callToClient(instance, 'lapsed-admin-recorder', 'admins-only', {
        gatewayBinding: 'CUSTOM_GATEWAY', callerBinding: 'ADMINS_ONLY_BINDING',
      }))).toEqual({ $ack: true });
      expect(await closed).toBe(4401);

      const ws2 = await upgrade(gateway, 'CUSTOM_GATEWAY', instance, { admin: false });
      let delivered = false;
      void answerNextCall(ws2, 'delivered').then(() => { delivered = true; });
      // MUTATION: check against the socket the call found, and the push reaches a Client no longer
      // allowed it.
      const { result: error } = await outcomeAt('lapsed-admin-recorder', 'admins-only');
      expect(error.message).toBe('Custom: calls from ADMINS_ONLY_BINDING reach admins only');
      expect(delivered).toBe(false);
      ws2.close();
    }, 20000);
  });

  describe('Client-initiated calls', () => {
    it('forwards client call to EchoDO and returns result', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('caller.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      // Establish WebSocket connection
      const token = createFakeJwt({ sub: 'caller', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'caller.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(101);

      const ws = response.webSocket!;
      ws.accept();

      // Skip connection_status message
      const connectionStatusPromise = new Promise<void>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws.removeEventListener('message', handler);
            resolve();
          }
        });
      });
      await connectionStatusPromise;

      // Build the operation chain (OCAN format)
      // Chain format: [{ type: 'get', key: 'methodName' }, { type: 'apply', args: [...] }]
      // Client preprocesses the chain before sending over WebSocket (like LumenizeClient does)
      const chain = preprocess([
        { type: 'get', key: 'echo' },
        { type: 'apply', args: ['Hello from client!'] },
      ]);

      // Send a call to EchoDO
      const callMessage: CallMessage = {
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'test-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-instance-1',
        chain,
      };

      // Set up response listener
      // The Gateway sends the filled continuation down as a `response` frame
      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            // Postprocess the result field (Gateway preprocesses it)
            resolve(answerOf(msg));
          }
        });
      });

      // Send the call - use JSON.stringify since Gateway uses JSON.parse
      ws.send(JSON.stringify(callMessage));

      // Wait for response
      const callResponse = await responsePromise;

      expect(callResponse.callId).toBe('test-call-1');
      expect(callResponse.success).toBe(true);
      expect(callResponse.result).toMatchObject({
        message: 'Echo: Hello from client!',
      });

      // Verify origin was set correctly (now callChain[0])
      expect(callResponse.result.callChain[0]).toMatchObject({
        type: 'LumenizeClient',
        bindingName: 'LUMENIZE_CLIENT_GATEWAY',
        instanceName: 'caller.tab1',
      });

      ws.close();
    });

    it('sets originAuth from WebSocket attachment', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('auth-user.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      // Establish WebSocket with JWT carrying claims
      const token = createFakeJwt({
        sub: 'auth-user',
        exp: Math.floor(Date.now() / 1000) + 900,
        emailVerified: true,
        adminApproved: true,
        isAdmin: true,
      });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'auth-user.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(101);

      const ws = response.webSocket!;
      ws.accept();

      // Skip connection_status
      await new Promise<void>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws.removeEventListener('message', handler);
            resolve();
          }
        });
      });

      // Build the operation chain (OCAN format)
      // Client preprocesses the chain before sending over WebSocket (like LumenizeClient does)
      const chain = preprocess([
        { type: 'get', key: 'getCallContext' },
        { type: 'apply', args: [] },
      ]);

      // Call EchoDO to inspect context
      const callMessage: CallMessage = {
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'auth-test-call',
        binding: 'ECHO_DO',
        instance: 'echo-auth-test',
        chain,
      };

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            // Postprocess the result field (Gateway preprocesses it)
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify(callMessage));
      const callResponse = await responsePromise;

      expect(callResponse.success).toBe(true);
      expect(callResponse.result.originAuth).toMatchObject({
        sub: 'auth-user',
        claims: {
          emailVerified: true,
          adminApproved: true,
          isAdmin: true,
        },
      });

      ws.close();
    });

    it('refuses a continuation that cannot run, or that ends in no call, each by its own message, before dispatch', async () => {
      const entries: any[] = [];
      setDebugSink((e) => entries.push(e));
      try {
        const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName('malformed.tab1'));
        const ws = await connectWith(gateway, 'malformed.tab1', 'malformed', {});
        const frames: Array<{ callId?: string }> = [];
        ws.addEventListener('message', (e: MessageEvent) => frames.push(JSON.parse(e.data as string)));
        const send = (callId: string, handler: unknown) => ws.send(JSON.stringify({
          type: GatewayMessageType.CALL, loadId: LOAD_ID, handler, callId, binding: 'ECHO_DO', instance: 'echo-malformed',
          chain: preprocess([{ type: 'get', key: 'echo' }, { type: 'apply', args: ['x'] }]),
        }));
        send('bad-empty', preprocess([]));
        send('bad-get', preprocess([{ type: 'get', key: 'onAnswer' }]));
        // A well-formed call on the same socket is the barrier: by its answer, both were handled.
        await callAndAwait(ws, 'good', 'ECHO_DO', 'echo-malformed', [{ type: 'get', key: 'echo' }, { type: 'apply', args: ['ok'] }]);

        const refusals = entries.filter((e) => e.message === 'refused a call whose result handler continuation is malformed');
        expect(refusals.map((e) => [e.data.callId, e.data.refusal])).toEqual([
          ['bad-empty', 'Invalid operation chain: a chain must have at least one operation'],
          ['bad-get', 'Invalid result handler continuation: it must end in a call, which its answer is filled into'],
        ]);
        expect(frames.filter((f) => f.callId === 'bad-empty' || f.callId === 'bad-get')).toEqual([]);
        ws.close();
      } finally {
        clearDebugSink();
      }
    });
  });

  describe('the call chain — stamped whole at the Trust DMZ', () => {
    // The MECHANISM, in the lane CI runs. The proof is the `/live` scenario
    // `gateway-stamps-the-chain` (apps/nebula/harness), which drives the three readers a forged hop
    // used to reach on the running system: a stored subscriber binding on the Profile, the same on
    // a data-plane host, and a tab's own caller check. This test shows only that the hop is gone.
    it('drops every hop a client appends — the callee sees the verified origin alone', async () => {
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName('chain-user.tab1'));
      const ws = await connectWith(gateway, 'chain-user.tab1', 'chain-user', {});
      // An honest client sends no chain, and `CallMessage` has no field for one, but a hostile frame
      // can carry anything: here someone else's tab in element 0, then a last hop naming a DO.
      // Before the fix the Gateway replaced element 0 and kept everything after it.
      const forged = await callAndAwait(ws, 'chain-1', 'ECHO_DO', 'echo-chain', GET_CONTEXT, {
        callChain: [
          { type: 'LumenizeClient', bindingName: 'LUMENIZE_CLIENT_GATEWAY', instanceName: 'victim.tab9' },
          { type: 'LumenizeDO', bindingName: 'NOT_A_BINDING', instanceName: 'anything' },
          { type: 'LumenizeDO', bindingName: 'ECHO_DO', instanceName: 'a-do-it-never-passed' },
        ],
      });
      expect(forged.callChain).toEqual([
        { type: 'LumenizeClient', bindingName: 'LUMENIZE_CLIENT_GATEWAY', instanceName: 'chain-user.tab1' },
      ]);
      ws.close();
    });
  });

  describe('originRequest — HTTP facts of the upgrade, stamped at the Trust DMZ', () => {
    it('stamps origin from the upgrade URL and the header facts as sent', async () => {
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName('or-user.tab1'));
      const ws = await connectWith(gateway, 'or-user.tab1', 'or-user', {
        'User-Agent': 'lumenize-test-ua/1.0',
        'Accept-Language': 'fr-CA,fr;q=0.9',
        'CF-Connecting-IP': '203.0.113.7',
      });
      const ctx = await callAndAwait(ws, 'or-1', 'ECHO_DO', 'echo-or-1', GET_CONTEXT);

      // `origin` is the URL the upgrade ARRIVED on — never a header. Mutation: drop the `origin:`
      // line in `captureOriginRequest` and this reds; so does routing it from any header.
      expect(ctx.originRequest).toMatchObject({
        origin: 'https://example.com',
        userAgent: 'lumenize-test-ua/1.0',
        acceptLanguage: 'fr-CA,fr;q=0.9',
        ip: '203.0.113.7',
      });
      // A direct DO-stub fetch carries no runtime `cf`, so the pick is ABSENT rather than an
      // empty object — the attachment stays small and a consumer can tell "unknown" from "empty".
      expect(ctx.originRequest.cf).toBeUndefined();
      // And it rides beside originAuth, never inside callChain[0], which names the client.
      expect(ctx.originAuth.sub).toBe('or-user');
      expect(ctx.callChain[0]).not.toHaveProperty('originRequest');
      ws.close();
    });

    it('refreshes the snapshot on reconnect — the facts are connection-scoped', async () => {
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName('or-user.tab2'));
      const first = await connectWith(gateway, 'or-user.tab2', 'or-user', { 'User-Agent': 'lumenize-test-ua/1.0' });
      const before = await callAndAwait(first, 'or-2a', 'ECHO_DO', 'echo-or-2', GET_CONTEXT);
      expect(before.originRequest.userAgent).toBe('lumenize-test-ua/1.0');

      // Reconnect (supersedes the first socket) with a changed header.
      const second = await connectWith(gateway, 'or-user.tab2', 'or-user', { 'User-Agent': 'lumenize-test-ua/2.0' });
      const after = await callAndAwait(second, 'or-2b', 'ECHO_DO', 'echo-or-2', GET_CONTEXT);
      // Mutation: cache the snapshot on the instance instead of rebuilding it per upgrade → reds.
      expect(after.originRequest.userAgent).toBe('lumenize-test-ua/2.0');
      second.close();
    });

    it('survives DO→DO forwarding unchanged (multi-hop)', async () => {
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName('or-user.tab3'));
      const ws = await connectWith(gateway, 'or-user.tab3', 'or-user', { 'Accept-Language': 'de-DE' });
      // hop A captures its own context, then fires an onward call so hop B captures too.
      await callAndAwait(ws, 'or-3', 'TEST_DO', 'or-hop-a', [
        { type: 'get', key: 'captureAndForward' },
        { type: 'apply', args: ['TEST_DO', 'or-hop-b'] },
      ]);
      const hopB = env.TEST_DO.get(env.TEST_DO.idFromName('or-hop-b'));
      const observed = await vi.waitFor(async () => {
        const o = await hopB.getObservedContext();
        expect(o).toBeDefined();
        return o;
      });
      // Guards the inherit path in `buildOutgoingCallContext`: a hop that rebuilt the context by
      // naming fields would drop this. Mutation: stop spreading `currentContext` there → reds.
      expect(observed.originRequest).toMatchObject({ origin: 'https://example.com', acceptLanguage: 'de-DE' });
      expect(observed.callChain.map((n: { instanceName?: string }) => n.instanceName)).toEqual(['or-user.tab3', 'or-hop-a']);
      ws.close();
    });

    it('is absent on a DO-originated chain — only a client upgrade can populate it', async () => {
      const caller = env.TEST_DO.getByName('or-do-caller');
      const callee = env.TEST_DO.getByName('or-do-callee');
      // A DO learns its own identity on first contact (routing headers or an inbound envelope);
      // a raw-stub caller has had neither, so prime it the way call-context.test.ts does.
      await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'or-do-caller' });
      caller.fireCall('TEST_DO', 'or-do-callee', 'captureContext');
      const observed = await vi.waitFor(async () => {
        const o = await callee.getObservedContext();
        expect(o).toBeDefined();
        return o;
      });
      expect(observed.originRequest).toBeUndefined();
      expect(observed.originAuth).toBeUndefined();
    });
  });

  describe('ClientDisconnectedError', () => {
    it('is properly serializable with structured-clone', () => {
      const error = new ClientDisconnectedError('Test error');
      const serialized = stringify(error);
      const restored = parse(serialized);

      expect(restored).toBeInstanceOf(ClientDisconnectedError);
      expect(restored.message).toBe('Test error');
    });

    it('carries NO clientInstanceName — who died comes from the address, not the payload', () => {
      // The field was the whole vulnerability: `postprocess` copies every own key onto a plain
      // Error whatever the constructor, so a client's handler could throw one naming ANY other
      // client and have that subscriber's row deleted. A reaper reads `callContext.callee` now.
      const error = new ClientDisconnectedError('Test error');
      expect('clientInstanceName' in error).toBe(false);
      // And it does not survive a round trip either, which is the half that mattered on the wire.
      const restored = parse(stringify(error)) as Record<string, unknown>;
      expect(restored.clientInstanceName).toBeUndefined();
    });
  });

  describe('WebSocket supersession', () => {
    /**
     * Helper: connect a WebSocket to a gateway and wait for connection_status.
     * Returns { ws, statusMessage }.
     */
    async function connectAndWait(
      gateway: DurableObjectStub,
      sub: string,
      instanceName: string,
    ) {
      const token = createFakeJwt({ sub, exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': instanceName,
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();

      const statusMessage = await new Promise<ConnectionStatusMessage>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws.removeEventListener('message', handler);
            resolve(msg);
          }
        });
      });

      return { ws, statusMessage };
    }

    it('closes first connection with 4409 when second connection arrives', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('super.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      // First connection
      const { ws: ws1 } = await connectAndWait(gateway, 'super', 'super.tab1');

      // Listen for close on first socket
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws1.addEventListener('close', (event) => {
          resolve({ code: event.code, reason: event.reason });
        });
      });

      // Second connection — should supersede the first
      const { ws: ws2 } = await connectAndWait(gateway, 'super', 'super.tab1');

      // First socket should have been closed with 4409
      const closeEvent = await closePromise;
      expect(closeEvent.code).toBe(WS_CLOSE_SUPERSEDED);
      expect(closeEvent.reason).toBe('Superseded by new connection');

      ws2.close();
    });

    it('routes mesh calls to the new socket after supersession', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('route.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      // First connection
      const { ws: ws1 } = await connectAndWait(gateway, 'route', 'route.tab1');

      // Second connection supersedes the first
      const { ws: ws2 } = await connectAndWait(gateway, 'route', 'route.tab1');

      // Send a call through the second socket — verify it routes to EchoDO
      const chain = preprocess([
        { type: 'get', key: 'echo' },
        { type: 'apply', args: ['Hello from new socket!'] },
      ]);

      const callMessage: CallMessage = {
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'supersession-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-supersession-1',
        chain,
      };

      const responsePromise = new Promise<Answer>((resolve) => {
        ws2.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws2.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws2.send(JSON.stringify(callMessage));
      const callResponse = await responsePromise;

      expect(callResponse.success).toBe(true);
      expect(callResponse.result).toMatchObject({
        message: 'Echo: Hello from new socket!',
      });

      ws2.close();
    });

    it('reports subscriptionRequired: false on supersession (no grace period elapsed)', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('subs.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      // First connection
      const { ws: ws1 } = await connectAndWait(gateway, 'subs', 'subs.tab1');

      // Second connection — supersedes first, no grace period involved
      const { ws: ws2, statusMessage } = await connectAndWait(gateway, 'subs', 'subs.tab1');

      expect(statusMessage.subscriptionRequired).toBe(false);

      ws2.close();
    });

    // RESULT re-resolution — the deterministic core of the "thinking forever" fix.
    // A mesh node fires a client-originated call's RESULT to the Gateway's __handleResponse door;
    // the Gateway must deliver it to whatever socket the client is on NOW, never the socket the
    // call left on (delivery is re-resolved by instanceName, not bound to a transient socket).
    it('re-resolves an answer to the CURRENT socket after a swap, not the origin socket', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('flowc.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      // ws1 connects; ws2 then supersedes it (ws1 is closed with 4409).
      const { ws: ws1 } = await connectAndWait(gateway, 'flowc', 'flowc.tab1');
      const ws1Received: any[] = [];
      ws1.addEventListener('message', (event: MessageEvent) => {
        const m = JSON.parse(event.data as string);
        if (m.type === GatewayMessageType.RESPONSE) ws1Received.push(m);
      });

      const { ws: ws2 } = await connectAndWait(gateway, 'flowc', 'flowc.tab1');
      const ws2ResultPromise = new Promise<Answer>((resolve) => {
        ws2.addEventListener('message', function h(event: MessageEvent) {
          const m = JSON.parse(event.data as string);
          if (m.type === GatewayMessageType.RESPONSE) { ws2.removeEventListener('message', h); resolve(answerOf(m)); }
        });
      });

      // Fire the answer back to the door. It must land on ws2 (current) — NOT ws1 (origin/dead).
      const ack = await gateway.__handleResponse(fireBackTo('flowc.tab1', 'flowc-call-1', 'hello-current-socket'));
      expect(ack).toEqual({ $ack: true });

      const delivered = await ws2ResultPromise;
      expect(delivered.callId).toBe('flowc-call-1');
      expect(delivered.result).toBe('hello-current-socket');

      // Capable-of-failing: the origin socket received NOTHING (delivery is not socket-bound).
      await new Promise((r) => setTimeout(r, 50));
      expect(ws1Received.length).toBe(0);

      ws2.close();
    });

    // Q4: a client call whose REQUEST is rejected at admission (the callee's onBeforeCall throws)
    // must deliver an ERROR RESULT to the client, which must never hang. The Gateway fills the
    // Client's continuation with the callee's early-ack {$error} and sends it down.
    it('Q4: an admission-rejected client call delivers an ERROR RESULT to the client (never stranded)', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('q4-reject.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);
      const { ws } = await connectAndWait(gateway, 'q4-reject', 'q4-reject.tab1');

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function h(event: MessageEvent) {
          const m = JSON.parse(event.data as string);
          if (m.type === GatewayMessageType.RESPONSE) { ws.removeEventListener('message', h); resolve(answerOf(m)); }
        });
      });

      // REJECTING_DO.onBeforeCall throws → the Star early-acks {$error} → the Gateway sends an
      // error `response` for this callId (capable-of-failing: if #handleClientCall swallowed the
      // ack {$error} the client would hang and this promise never resolves).
      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'q4-reject-1',
        binding: 'REJECTING_DO',
        instance: 'q4-reject-target',
        chain: preprocess([{ type: 'get', key: 'ping' }, { type: 'apply', args: [] }]),
      }));

      const r = await responsePromise;
      expect(r.callId).toBe('q4-reject-1');
      expect(r.success).toBe(false);
      expect(r.error.message).toMatch(/admission rejected by onBeforeCall/);
      ws.close();
    });

    // A client 4-arg whose RESULT cannot be encoded must still get an ERROR RESULT. The callee
    // used to encode it outside any try, so the fire-back never left and the client hung.
    it('delivers an unencodable result to the client as a DataCloneError (never stranded)', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('unencodable.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);
      const { ws } = await connectAndWait(gateway, 'unencodable', 'unencodable.tab1');

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function h(event: MessageEvent) {
          const m = JSON.parse(event.data as string);
          if (m.type === GatewayMessageType.RESPONSE) { ws.removeEventListener('message', h); resolve(answerOf(m)); }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'unencodable-1',
        binding: 'TEST_DO',
        instance: 'unencodable-target',
        chain: preprocess([{ type: 'get', key: 'returnUnencodable' }, { type: 'apply', args: ['weakmap'] }]),
      }));

      const r = await responsePromise;
      expect(r.callId).toBe('unencodable-1');
      expect(r.success).toBe(false);
      const error = r.error;
      expect(error.name).toBe('DataCloneError');
      expect(error.message).toBe(
        'The result of TEST_DO.returnUnencodable() cannot cross the mesh. '
          + 'Could not serialize object of type "WeakMap". Convert it to a plain value first.',
      );
      ws.close();
    });

    it('drops an answer when the client has no socket — via the debug sink', async () => {
      const entries: any[] = [];
      setDebugSink((e) => entries.push(e));
      try {
        const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('flowc-nosocket.tab1');
        const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

        // No connection was ever established → no active socket, no grace period → immediate drop.
        const ack = await gateway.__handleResponse(fireBackTo('flowc-nosocket.tab1', 'flowc-drop-1', 'never-delivered'));
        expect(ack).toEqual({ $ack: true });
        expect(entries.some((e) => typeof e.message === 'string' && e.message.includes('no socket for the client\'s answer'))).toBe(true);
      } finally {
        clearDebugSink();
      }
    });
  });

  describe('JWT validation edge cases', () => {
    it('rejects invalid JWT format (cannot decode)', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('jwt-invalid.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': 'Bearer not-a-valid-jwt',
          'X-Lumenize-DO-Instance-Name-Or-Id': 'jwt-invalid.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).toBe('Unauthorized: invalid token');
    });

    it('rejects JWT missing sub claim', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('no-sub.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'no-sub.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).toBe('Unauthorized: missing identity');
    });

    it('rejects missing instance name header', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('no-instance.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub: 'no-instance', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
        },
      });

      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toBe('Forbidden: missing instance name');
    });

    it('rejects missing binding name header', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('no-binding.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub: 'no-binding', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'no-binding.tab1',
        },
      });

      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toBe('Forbidden: missing binding name');
    });

    it('rejects instance name without dot separator', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('nodot');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub: 'nodot', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'nodot',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain('invalid instance name format');
    });
  });

  describe('WebSocket message handling edge cases', () => {
    /**
     * Helper: connect a WebSocket and wait for connection_status.
     */
    async function connectGateway(sub: string, instanceName: string) {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName(instanceName);
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub, exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': instanceName,
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();

      await new Promise<void>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws.removeEventListener('message', handler);
            resolve();
          }
        });
      });

      return { ws, gateway };
    }

    it('handles unknown message type gracefully', async () => {
      const { ws } = await connectGateway('unknown-msg', 'unknown-msg.tab1');

      // Send unknown type — should not crash
      ws.send(JSON.stringify({ type: 'some_unknown_type', data: 'test' }));

      // Verify gateway still works after
      const chain = preprocess([
        { type: 'get', key: 'echo' },
        { type: 'apply', args: ['still alive'] },
      ]);

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'post-unknown-call',
        binding: 'ECHO_DO',
        instance: 'echo-post-unknown',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);
      ws.close();
    });

    it('handles invalid JSON message gracefully', async () => {
      const { ws } = await connectGateway('bad-json', 'bad-json.tab1');

      ws.send('not valid json {{{');

      // Gateway should still work after invalid JSON
      const chain = preprocess([
        { type: 'get', key: 'echo' },
        { type: 'apply', args: ['after bad json'] },
      ]);

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'post-badjson-call',
        binding: 'ECHO_DO',
        instance: 'echo-post-badjson',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);
      ws.close();
    });

    it('handles call to Worker binding (no instance)', async () => {
      const { ws } = await connectGateway('worker-call', 'worker-call.tab1');

      const chain = preprocess([
        { type: 'get', key: 'workerEcho' },
        { type: 'apply', args: ['hello-from-client'] },
      ]);

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'worker-call-1',
        binding: 'TEST_WORKER',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);
      expect(callResponse.result).toBe('worker-echo: hello-from-client');
      ws.close();
    });

    it('forwards call error response back to client', async () => {
      const { ws } = await connectGateway('error-call', 'error-call.tab1');

      const chain = preprocess([
        { type: 'get', key: 'throwError' },
        { type: 'apply', args: [] },
      ]);

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'error-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-error-test',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(false);
      expect(callResponse.error).toBeDefined();
      ws.close();
    });

    it('handles incoming_call_response for unknown callId gracefully', async () => {
      const { ws } = await connectGateway('icr-unknown', 'icr-unknown.tab1');

      // Send an incoming_call_response for a callId the gateway doesn't know about
      ws.send(JSON.stringify({
        type: GatewayMessageType.INCOMING_CALL_RESPONSE,
        callId: 'nonexistent-incoming-call',
        success: true,
        result: null,
      }));

      // Gateway should handle gracefully — verify it still works
      const chain = preprocess([
        { type: 'get', key: 'echo' },
        { type: 'apply', args: ['still alive after unknown icr'] },
      ]);

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'post-icr-call',
        binding: 'ECHO_DO',
        instance: 'echo-post-icr',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);
      ws.close();
    });

    it('a frame\'s callContext reaches the node as nothing — no state key, since the Gateway builds the context', async () => {
      const { ws } = await connectGateway('state-test', 'state-test.tab1');

      const chain = preprocess([
        { type: 'get', key: 'getCallContext' },
        { type: 'apply', args: [] },
      ]);

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'state-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-state-test',
        chain,
        // A hostile frame: CallMessage has no callContext, so whatever this carries is never read.
        callContext: {
          callChain: [],
          state: preprocess({ isEditor: true }),
        },
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);
      expect(callResponse.result).not.toHaveProperty('state');
      ws.close();
    });
  });

  describe('Token expiry during message handling', () => {
    it('closes WebSocket with 4401 when token has expired', async () => {
      const instanceName = 'exp-test.tab1';
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName(instanceName);
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      // Create JWT with exp in the past
      const token = createFakeJwt({
        sub: 'exp-test',
        exp: Math.floor(Date.now() / 1000) - 60, // 1 minute ago
      });

      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': instanceName,
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();

      // Skip connection_status message
      await new Promise<void>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws.removeEventListener('message', handler);
            resolve();
          }
        });
      });

      // Listen for close event
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.addEventListener('close', (event) => {
          resolve({ code: event.code, reason: event.reason });
        });
      });

      // Send a message — should trigger token expiry check and close
      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'expired-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-expired',
        chain: preprocess([
          { type: 'get', key: 'echo' },
          { type: 'apply', args: ['should not reach'] },
        ]),
      }));

      const closeEvent = await closePromise;
      expect(closeEvent.code).toBe(4401);
      expect(closeEvent.reason).toBe('Token expired');
    });
  });

  describe('__executeOperation (mesh→client calls)', () => {
    it('returns $error for invalid envelope version', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('exec-op-v0.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id) as any;

      const result = await gateway.__executeOperation({
        version: 0,
        chain: {},
        callContext: { callChain: [] },
        metadata: {},
      });

      expect(result.$error).toBeDefined();
      const error = postprocess(result.$error);
      expect(error.message).toContain('Unsupported RPC envelope version');
    });

    it('acks a call to a Client with no socket, and the node\'s handler then hears ClientDisconnectedError from that Client', async () => {
      const name = 'exec-op-disconnected.tab1';
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(name)) as any;

      expect(await gateway.__executeOperation(callToClient(name, 'exec-op-disconnected-recorder', 'gone')))
        .toEqual({ $ack: true });

      const { result, callee, callChain, originAuth } = await outcomeAt('exec-op-disconnected-recorder', 'gone');
      expect({ name: result.name, message: result.message })
        .toEqual({ name: 'ClientDisconnectedError', message: 'Client is not connected' });
      // With no socket, the Client's names come from the envelope, and its type from the Gateway.
      const client = { type: 'LumenizeClient', bindingName: 'LUMENIZE_CLIENT_GATEWAY', instanceName: name };
      expect(callChain).toEqual([{ type: 'LumenizeDO', bindingName: 'TEST_DO', instanceName: 'exec-op-disconnected-recorder' }, client]);
      expect(callee).toEqual(client);
      expect(originAuth).toEqual(NODE_ORIGIN_AUTH);
    });

    it('answers the node with the decode error when the Client\'s answer will not decode', async () => {
      const name = 'exec-op-undecodable.tab1';
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(name)) as any;
      const ws = await connectWith(gateway, name, 'exec-op-undecodable', {});
      ws.addEventListener('message', (event: MessageEvent) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type !== GatewayMessageType.INCOMING_CALL) return;
        // An arraybuffer whose bytes are not an array: structured-clone refuses to decode it.
        ws.send(JSON.stringify({
          type: GatewayMessageType.INCOMING_CALL_RESPONSE, callId: msg.callId, success: true,
          result: { json: { $type: 'arraybuffer', subtype: 'ArrayBuffer', data: 'not-an-array' }, meta: {} },
        }));
      });

      expect(await gateway.__executeOperation(callToClient(name, 'exec-op-undecodable-recorder', 'undecodable')))
        .toEqual({ $ack: true });
      const { result } = await outcomeAt('exec-op-undecodable-recorder', 'undecodable');
      expect({ name: result.name, message: result.message })
        .toEqual({ name: 'DataCloneError', message: 'Could not deserialize arraybuffer: data is not an array' });
      ws.close();
    });

    it('acks before the Client answers, then fills the node\'s handler with the answer, under the node\'s own claims', async () => {
      const name = 'exec-op-held.tab1';
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(name)) as any;
      const ws = await connectWith(gateway, name, 'exec-op-held', {});
      const incoming = new Promise<IncomingCallMessage>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.INCOMING_CALL) { ws.removeEventListener('message', handler); resolve(msg); }
        });
      });

      // The Client holds its answer until the ack is in: an ack that waited for it would never come.
      const ack = await Promise.race([
        gateway.__executeOperation(callToClient(name, 'exec-op-held-recorder', 'held')),
        new Promise((resolve) => setTimeout(() => resolve('no ack while the Client held its answer'), 2000)),
      ]);
      expect(ack).toEqual({ $ack: true });

      const call = await incoming;
      ws.send(JSON.stringify({
        type: GatewayMessageType.INCOMING_CALL_RESPONSE, callId: call.callId, success: true, result: preprocess('held-answer'),
      } satisfies IncomingCallResponseMessage));

      const { result, callChain, originAuth } = await outcomeAt('exec-op-held-recorder', 'held');
      expect(result).toBe('held-answer');
      // From the socket's attachment this time, and the node's claims, never the socket's.
      expect(callChain.at(-1)).toEqual({ type: 'LumenizeClient', bindingName: 'LUMENIZE_CLIENT_GATEWAY', instanceName: name });
      expect(originAuth).toEqual(NODE_ORIGIN_AUTH);
      ws.close();
    });
  });

  describe('Grace period', () => {
    // Every test here waits on the Gateway's own markers, so the sink is installed for each.
    let entries: DebugLogOutput[] = [];
    beforeEach(() => {
      entries = [];
      setDebugSink((e) => entries.push(e));
    });
    afterEach(() => clearDebugSink());

    it('an evicted Gateway answers a push at once, and tells the reconnect subscriptionRequired: true', async () => {
      const name = 'grace-evicted.tab1';
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(name)) as any;

      const token = createFakeJwt({ sub: 'grace-evicted', exp: Math.floor(Date.now() / 1000) + 900 });
      const headers = {
        'Upgrade': 'websocket',
        'Sec-WebSocket-Protocol': 'lmz.2',
        'Authorization': `Bearer ${token}`,
        'X-Lumenize-DO-Instance-Name-Or-Id': name,
        'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
      };
      const response = await gateway.fetch('https://example.com', { headers });
      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();
      ws.close(1000, 'Normal close');
      await waitForGracePeriod(entries, name);

      // Evict it inside the grace period. The grace period lives in memory, so it goes with it.
      // A stub that saw the abort stays broken, so the calls below take a fresh one, as a caller would.
      await runInDurableObject(gateway, (_instance, ctx) => { ctx.abort(); }).catch(() => {});
      const fresh = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(name)) as any;

      expect(await fresh.__executeOperation(callToClient(name, 'grace-evicted-recorder', 'push')))
        .toEqual({ $ack: true });
      const { result: error } = await outcomeAt('grace-evicted-recorder', 'push');
      expect({ name: error.name, message: error.message })
        .toEqual({ name: 'ClientDisconnectedError', message: 'Client is not connected' });

      const response2 = await fresh.fetch('https://example.com', { headers });
      expect(response2.status).toBe(101);
      const ws2 = response2.webSocket!;
      ws2.accept();
      const status = await new Promise<ConnectionStatusMessage>((resolve) => {
        ws2.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws2.removeEventListener('message', handler);
            resolve(msg);
          }
        });
      });
      expect(status.subscriptionRequired).toBe(true);
      ws2.close();
    });

    it('reconnect within grace period reports subscriptionRequired: false', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('grace.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub: 'grace', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'grace.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });
      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();

      await new Promise<void>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws.removeEventListener('message', handler);
            resolve();
          }
        });
      });

      // Close WebSocket (not superseded) — starts the grace period
      ws.close(1000, 'Normal close');

      // Wait for webSocketClose to have processed the close frame and started the grace period.
      // ws.close() only queues the frame; under CPU contention the reconnect fetch
      // below can race ahead of webSocketClose if we don't wait.
      await waitForGracePeriod(entries, 'grace.tab1');

      // Reconnect within grace period
      const token2 = createFakeJwt({ sub: 'grace', exp: Math.floor(Date.now() / 1000) + 900 });
      const response2 = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token2}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'grace.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });
      expect(response2.status).toBe(101);
      const ws2 = response2.webSocket!;
      ws2.accept();

      const statusMessage = await new Promise<ConnectionStatusMessage>((resolve) => {
        ws2.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws2.removeEventListener('message', handler);
            resolve(msg);
          }
        });
      });

      expect(statusMessage.subscriptionRequired).toBe(false);
      ws2.close();
    });

    it('a call during the grace period is acked at once, and answered once the Client reconnects in time', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('grace-exec-reconnect.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id) as any;

      const token = createFakeJwt({ sub: 'grace-exec-reconnect', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'grace-exec-reconnect.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });
      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();

      await new Promise<void>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws.removeEventListener('message', handler);
            resolve();
          }
        });
      });

      ws.close(1000, 'Normal close');

      await waitForGracePeriod(entries, 'grace-exec-reconnect.tab1');

      // Acked at once; the delivery parks in the grace period's wait.
      expect(await gateway.__executeOperation(callToClient('grace-exec-reconnect.tab1', 'grace-exec-reconnect-recorder', 'push')))
        .toEqual({ $ack: true });

      // The call is parked once the Gateway logs that it is waiting for this Client.
      await vi.waitFor(() => {
        expect(entries.some((e) => e.message === 'Client disconnected, waiting for reconnect during grace period'
          && e.data?.instanceName === 'grace-exec-reconnect.tab1')).toBe(true);
      });

      // Reconnect a fresh WebSocket before the grace period ends.
      // webSocketMessage on the new WS resolves pending reconnect waiters.
      const token2 = createFakeJwt({ sub: 'grace-exec-reconnect', exp: Math.floor(Date.now() / 1000) + 900 });
      const response2 = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token2}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'grace-exec-reconnect.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });
      expect(response2.status).toBe(101);
      const ws2 = response2.webSocket!;
      ws2.accept();

      // After the reconnect, the Gateway sends the INCOMING_CALL over the new socket and waits for
      // its INCOMING_CALL_RESPONSE, which fills the node's handler.
      await new Promise<void>((resolve) => {
        ws2.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.INCOMING_CALL) {
            ws2.removeEventListener('message', handler);
            const response: IncomingCallResponseMessage = {
              type: GatewayMessageType.INCOMING_CALL_RESPONSE,
              callId: (msg as IncomingCallMessage).callId,
              success: true,
              result: preprocess('reconnected-result'),
            };
            ws2.send(JSON.stringify(response));
            resolve();
          }
        });
      });

      const { result, originAuth } = await outcomeAt('grace-exec-reconnect-recorder', 'push');
      expect(result).toBe('reconnected-result');
      // The node's claims ride the fire-back, never the reconnected socket's.
      expect(originAuth).toEqual(NODE_ORIGIN_AUTH);
      ws2.close();
    });

    // What keeps a Gateway resident while it waits is `ctx.waitUntil`, from compatibility date
    // 2026-10-01. Nothing in-lane evicts it, so the spy is the witness here, and the deployed pass at
    // the wipe gate is what shows the object stays resident.
    it('hands every wait it keeps to ctx.waitUntil: a push awaiting its Client, and an answer awaiting a reconnect', async () => {
      const name = 'grace-wait-until.tab1';
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(env.LUMENIZE_CLIENT_GATEWAY.idFromName(name)) as any;
      const ws = await connectWith(gateway, name, 'grace-wait-until', {});
      const held: Array<{ settled: boolean }> = [];
      await runInDurableObject(gateway, (instance: any) => {
        const ctx = instance.ctx as DurableObjectState;
        const original = ctx.waitUntil.bind(ctx);
        vi.spyOn(ctx, 'waitUntil').mockImplementation((promise: Promise<unknown>) => {
          const entry = { settled: false };
          held.push(entry);
          promise.finally(() => { entry.settled = true; });
          original(promise);
        });
      });

      // A push to a Client that has not answered yet: its wait is held from the ack on.
      const incoming = new Promise<IncomingCallMessage>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.INCOMING_CALL) { ws.removeEventListener('message', handler); resolve(msg); }
        });
      });
      expect(await gateway.__executeOperation(callToClient(name, 'grace-wait-until-recorder', 'push'))).toEqual({ $ack: true });
      const call = await incoming;
      expect(held).toEqual([{ settled: false }]);
      ws.send(JSON.stringify({
        type: GatewayMessageType.INCOMING_CALL_RESPONSE, callId: call.callId, success: true, result: preprocess('answered'),
      } satisfies IncomingCallResponseMessage));
      expect((await outcomeAt('grace-wait-until-recorder', 'push')).result).toBe('answered');
      await vi.waitFor(() => expect(held[0].settled).toBe(true));

      // An answer for a Client inside its grace period: acked at once, held until the reconnect.
      ws.close(1000, 'Normal close');
      await waitForGracePeriod(entries, name);
      const ack = await Promise.race([
        gateway.__handleResponse(fireBackTo(name, 'wait-until-1', 'after-reconnect')),
        new Promise((resolve) => setTimeout(() => resolve('no ack while the Client was away'), 2000)),
      ]);
      expect(ack).toEqual({ $ack: true });
      expect(held).toHaveLength(2);
      expect(held[1].settled).toBe(false);

      const token = createFakeJwt({ sub: 'grace-wait-until', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Sec-WebSocket-Protocol': 'lmz.2',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': name,
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });
      const ws2 = response.webSocket!;
      const delivered = new Promise<Answer>((resolve) => {
        ws2.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) { ws2.removeEventListener('message', handler); resolve(answerOf(msg)); }
        });
      });
      ws2.accept();
      expect((await delivered).result).toBe('after-reconnect');
      await vi.waitFor(() => expect(held[1].settled).toBe(true));
      ws2.close();
    });
  });
});

// ============================================
// CustomGateway — hook override tests
// ============================================

describe('CustomGateway (hook overrides)', () => {
  /**
   * Helper: connect a WebSocket to a CustomGateway and wait for connection_status.
   */
  async function connectCustom(
    sub: string,
    instanceName: string,
    extraClaims: Record<string, unknown> = {}
  ) {
    const id = env.CUSTOM_GATEWAY.idFromName(instanceName);
    const gateway = env.CUSTOM_GATEWAY.get(id);

    const token = createFakeJwt({
      sub,
      exp: Math.floor(Date.now() / 1000) + 900,
      ...extraClaims,
    });
    const response = await gateway.fetch('https://example.com', {
      headers: {
        'Upgrade': 'websocket',
        'Sec-WebSocket-Protocol': 'lmz.2',
        'Authorization': `Bearer ${token}`,
        'X-Lumenize-DO-Instance-Name-Or-Id': instanceName,
        'X-Lumenize-DO-Binding-Name': 'CUSTOM_GATEWAY',
      },
    });

    if (response.status !== 101) {
      return { response, ws: null as any, gateway };
    }

    const ws = response.webSocket!;
    ws.accept();

    await new Promise<void>((resolve) => {
      ws.addEventListener('message', function handler(event: MessageEvent) {
        const msg = JSON.parse(event.data as string);
        if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
          ws.removeEventListener('message', handler);
          resolve();
        }
      });
    });

    return { response, ws, gateway };
  }

  describe('bindingName from routing header', () => {
    it('uses binding name from X-Lumenize-DO-Binding-Name header in verifiedOrigin and caller metadata', async () => {
      const { ws } = await connectCustom('cg-bind', 'cg-bind.tab1', { role: 'user' });

      const chain = preprocess([
        { type: 'get', key: 'echo' },
        { type: 'apply', args: ['binding-test'] },
      ]);

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'cg-bind-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-cg-bind',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);

      // callChain[0] should use the custom binding name
      expect(callResponse.result.callChain[0]).toMatchObject({
        type: 'LumenizeClient',
        bindingName: 'CUSTOM_GATEWAY',
        instanceName: 'cg-bind.tab1',
      });

      ws.close();
    });
  });

  describe('onBeforeAccept', () => {
    it('extracts custom claims from JWT payload', async () => {
      const { ws } = await connectCustom('cg-claims', 'cg-claims.tab1', {
        role: 'admin',
        org: 'acme',
      });

      // Call EchoDO to inspect originAuth
      const chain = preprocess([
        { type: 'get', key: 'getCallContext' },
        { type: 'apply', args: [] },
      ]);

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'cg-claims-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-cg-claims',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);
      expect(callResponse.result.originAuth).toMatchObject({
        sub: 'cg-claims',
        claims: {
          role: 'admin',
          org: 'acme',
        },
      });

      ws.close();
    });

    it('rejects connection when custom hook returns Response', async () => {
      const { response } = await connectCustom('cg-blocked', 'cg-blocked.tab1', {
        role: 'blocked',
      });

      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toBe('Custom: blocked role');
    });
  });

  describe('onBeforeCallToMesh', () => {
    it('stamps a top-level field the callee reads', async () => {
      const { ws } = await connectCustom('cg-enrich', 'cg-enrich.tab1', {
        role: 'editor',
        org: 'widgets-inc',
      });

      const chain = preprocess([
        { type: 'get', key: 'getCallContext' },
        { type: 'apply', args: [] },
      ]);

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'cg-enrich-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-cg-enrich',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);

      // The field CustomGateway's onBeforeCallToMesh stamped reached the callee
      expect(callResponse.result._auth).toMatchObject({
        sub: 'cg-enrich',
        claims: {
          role: 'editor',
          org: 'widgets-inc',
        },
      });

      ws.close();
    });
  });

  describe('onBeforeCallToClient', () => {
    it('rejects incoming call from blocked binding', async () => {
      const instanceName = 'cg-block-client.tab1';
      const id = env.CUSTOM_GATEWAY.idFromName(instanceName);
      const gateway = env.CUSTOM_GATEWAY.get(id) as any;

      // Connect a client first
      const { ws } = await connectCustom('cg-block-client', instanceName, { role: 'user' });

      // A call from a blocked binding: acked, then refused by the hook, and the refusal fills the node's handler.
      expect(await gateway.__executeOperation(callToClient(instanceName, 'cg-block-recorder', 'blocked', {
        gatewayBinding: 'CUSTOM_GATEWAY', callerBinding: 'BLOCKED_BINDING',
      }))).toEqual({ $ack: true });

      const { result: error } = await outcomeAt('cg-block-recorder', 'blocked');
      expect(error.message).toContain('BLOCKED_BINDING');

      ws.close();
    });

    it('allows incoming call from non-blocked binding', async () => {
      const instanceName = 'cg-allow-client.tab1';
      const id = env.CUSTOM_GATEWAY.idFromName(instanceName);
      const gateway = env.CUSTOM_GATEWAY.get(id) as any;

      // Connect a client
      const { ws } = await connectCustom('cg-allow-client', instanceName, { role: 'user' });

      // Set up listener for the incoming call on the client side
      const incomingCallPromise = new Promise<IncomingCallMessage>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.INCOMING_CALL) {
            ws.removeEventListener('message', handler);
            resolve(msg);
          }
        });
      });

      // A call from a non-blocked binding is forwarded to the Client.
      expect(await gateway.__executeOperation(callToClient(instanceName, 'cg-allow-recorder', 'allowed', {
        gatewayBinding: 'CUSTOM_GATEWAY', callerBinding: 'ALLOWED_BINDING',
      }))).toEqual({ $ack: true });

      // Wait for the incoming call to be forwarded to the client
      const incomingCall = await incomingCallPromise;
      expect(incomingCall.type).toBe(GatewayMessageType.INCOMING_CALL);

      // Respond from client
      ws.send(JSON.stringify({
        type: GatewayMessageType.INCOMING_CALL_RESPONSE,
        callId: incomingCall.callId,
        success: true,
        result: preprocess('client-response'),
      }));

      const { result } = await outcomeAt('cg-allow-recorder', 'allowed');
      expect(result).toBe('client-response');

      ws.close();
    });
  });

  describe('end-to-end composition', () => {
    it('all hooks compose: custom accept → enriched context → validated forwarding', async () => {
      // Connect with custom claims
      const { ws } = await connectCustom('cg-e2e', 'cg-e2e.tab1', {
        role: 'admin',
        org: 'composure-inc',
      });

      // Call EchoDO — triggers onBeforeCallToMesh (context enrichment)
      const chain = preprocess([
        { type: 'get', key: 'getCallContext' },
        { type: 'apply', args: [] },
      ]);

      const responsePromise = new Promise<Answer>((resolve) => {
        ws.addEventListener('message', function handler(event: MessageEvent) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(answerOf(msg));
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL, loadId: LOAD_ID, handler: HANDLER,
        callId: 'cg-e2e-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-cg-e2e',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);

      // Verify all hooks composed correctly:
      // 1. onBeforeAccept: custom claims extracted
      expect(callResponse.result.originAuth).toMatchObject({
        sub: 'cg-e2e',
        claims: { role: 'admin', org: 'composure-inc' },
      });

      // 2. onBeforeCallToMesh: a top-level _auth stamped onto the context
      expect(callResponse.result._auth).toMatchObject({
        sub: 'cg-e2e',
        claims: { role: 'admin', org: 'composure-inc' },
      });

      // 3. bindingName: from X-Lumenize-DO-Binding-Name routing header
      expect(callResponse.result.callChain[0].bindingName).toBe('CUSTOM_GATEWAY');

      ws.close();
    });
  });
});
