import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { stringify, parse, preprocess, postprocess } from '@lumenize/structured-clone';
import {
  GatewayMessageType,
  ClientDisconnectedError,
  WS_CLOSE_SUPERSEDED,
  type ConnectionStatusMessage,
  type CallMessage,
  type CallResponseMessage,
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

  describe('Client-initiated calls', () => {
    it('forwards client call to EchoDO and returns result', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('caller.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      // Establish WebSocket connection
      const token = createFakeJwt({ sub: 'caller', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
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
        ws.addEventListener('message', function handler(event) {
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
        type: GatewayMessageType.CALL,
        callId: 'test-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-instance-1',
        chain,
      };

      // Set up response listener
      // Gateway sends CALL_RESPONSE via JSON.stringify with result: preprocess(result)
      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            // Postprocess the result field (Gateway preprocesses it)
            msg.result = postprocess(msg.result);
            resolve(msg);
          }
        });
      });

      // Send the call - use JSON.stringify since Gateway uses JSON.parse
      ws.send(JSON.stringify(callMessage));

      // Wait for response
      const callResponse = await responsePromise;

      expect(callResponse.type).toBe(GatewayMessageType.CALL_RESPONSE);
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
        ws.addEventListener('message', function handler(event) {
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
        type: GatewayMessageType.CALL,
        callId: 'auth-test-call',
        binding: 'ECHO_DO',
        instance: 'echo-auth-test',
        chain,
      };

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            // Postprocess the result field (Gateway preprocesses it)
            msg.result = postprocess(msg.result);
            resolve(msg);
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
  });

  describe('ClientDisconnectedError', () => {
    it('is properly serializable with structured-clone', () => {
      const error = new ClientDisconnectedError('Test error', 'alice.tab1');
      const serialized = stringify(error);
      const restored = parse(serialized);

      expect(restored).toBeInstanceOf(ClientDisconnectedError);
      expect(restored.message).toBe('Test error');
      expect((restored as ClientDisconnectedError).clientInstanceName).toBe('alice.tab1');
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
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': instanceName,
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();

      const statusMessage = await new Promise<ConnectionStatusMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
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
        type: GatewayMessageType.CALL,
        callId: 'supersession-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-supersession-1',
        chain,
      };

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws2.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws2.removeEventListener('message', handler);
            msg.result = postprocess(msg.result);
            resolve(msg);
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
  });

  describe('JWT validation edge cases', () => {
    it('rejects invalid JWT format (cannot decode)', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('jwt-invalid.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
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
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': instanceName,
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });

      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();

      await new Promise<void>((resolve) => {
        ws.addEventListener('message', function handler(event) {
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

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(msg);
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
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

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(msg);
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
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

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            msg.result = postprocess(msg.result);
            resolve(msg);
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
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

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            resolve(msg);
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
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

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            msg.result = postprocess(msg.result);
            resolve(msg);
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
        callId: 'post-icr-call',
        binding: 'ECHO_DO',
        instance: 'echo-post-icr',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);
      ws.close();
    });

    it('passes callContext.state through to target DO', async () => {
      const { ws } = await connectGateway('state-test', 'state-test.tab1');

      const chain = preprocess([
        { type: 'get', key: 'getCallContext' },
        { type: 'apply', args: [] },
      ]);

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            msg.result = postprocess(msg.result);
            resolve(msg);
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
        callId: 'state-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-state-test',
        chain,
        callContext: {
          callChain: [],
          state: preprocess({ myKey: 'myValue' }),
        },
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);
      expect(callResponse.result.state).toMatchObject({ myKey: 'myValue' });
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
        ws.addEventListener('message', function handler(event) {
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
        type: GatewayMessageType.CALL,
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
        callContext: { callChain: [], state: {} },
        metadata: {},
      });

      expect(result.$error).toBeDefined();
      const error = postprocess(result.$error);
      expect(error.message).toContain('Unsupported RPC envelope version');
    });

    it('returns ClientDisconnectedError when no client connected', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('exec-op-disconnected.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id) as any;

      const result = await gateway.__executeOperation({
        version: 1,
        chain: preprocess([
          { type: 'get', key: 'someMethod' },
          { type: 'apply', args: [] },
        ]),
        callContext: { callChain: [], state: {} },
        metadata: {},
      });

      expect(result.$error).toBeDefined();
      const error = postprocess(result.$error);
      expect(error).toBeInstanceOf(ClientDisconnectedError);
      expect(error.message).toContain('Client is not connected');
    });
  });

  describe('Grace period and alarm', () => {
    it('reconnect within grace period reports subscriptionRequired: false', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('grace.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub: 'grace', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'grace.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });
      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();

      await new Promise<void>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws.removeEventListener('message', handler);
            resolve();
          }
        });
      });

      // Close WebSocket (not superseded) — triggers grace period alarm
      ws.close(1000, 'Normal close');

      // Reconnect within grace period
      const token2 = createFakeJwt({ sub: 'grace', exp: Math.floor(Date.now() / 1000) + 900 });
      const response2 = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Authorization': `Bearer ${token2}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'grace.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });
      expect(response2.status).toBe(101);
      const ws2 = response2.webSocket!;
      ws2.accept();

      const statusMessage = await new Promise<ConnectionStatusMessage>((resolve) => {
        ws2.addEventListener('message', function handler(event) {
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

    it('reports subscriptionRequired: true after grace period expires', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('grace-expired.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub: 'grace-expired', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'grace-expired.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });
      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      ws.accept();

      await new Promise<void>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws.removeEventListener('message', handler);
            resolve();
          }
        });
      });

      ws.close(1000, 'Normal close');

      // Fire the grace period alarm (simulates expiry)
      await runDurableObjectAlarm(gateway);

      // Reconnect after alarm — should report subscriptionRequired: true
      const token2 = createFakeJwt({ sub: 'grace-expired', exp: Math.floor(Date.now() / 1000) + 900 });
      const response2 = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Authorization': `Bearer ${token2}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'grace-expired.tab1',
          'X-Lumenize-DO-Binding-Name': 'LUMENIZE_CLIENT_GATEWAY',
        },
      });
      expect(response2.status).toBe(101);
      const ws2 = response2.webSocket!;
      ws2.accept();

      const statusMessage = await new Promise<ConnectionStatusMessage>((resolve) => {
        ws2.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CONNECTION_STATUS) {
            ws2.removeEventListener('message', handler);
            resolve(msg);
          }
        });
      });

      expect(statusMessage.subscriptionRequired).toBe(true);
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
      ws.addEventListener('message', function handler(event) {
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

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            msg.result = postprocess(msg.result);
            resolve(msg);
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
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

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            msg.result = postprocess(msg.result);
            resolve(msg);
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
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
    it('injects claims into callContext.state', async () => {
      const { ws } = await connectCustom('cg-enrich', 'cg-enrich.tab1', {
        role: 'editor',
        org: 'widgets-inc',
      });

      const chain = preprocess([
        { type: 'get', key: 'getCallContext' },
        { type: 'apply', args: [] },
      ]);

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            msg.result = postprocess(msg.result);
            resolve(msg);
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
        callId: 'cg-enrich-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-cg-enrich',
        chain,
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);

      // Verify _auth was injected into state by onBeforeCallToMesh
      expect(callResponse.result.state._auth).toMatchObject({
        sub: 'cg-enrich',
        claims: {
          role: 'editor',
          org: 'widgets-inc',
        },
      });

      ws.close();
    });

    it('preserves client-sent state alongside injected auth', async () => {
      const { ws } = await connectCustom('cg-merge', 'cg-merge.tab1', {
        role: 'viewer',
      });

      const chain = preprocess([
        { type: 'get', key: 'getCallContext' },
        { type: 'apply', args: [] },
      ]);

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            msg.result = postprocess(msg.result);
            resolve(msg);
          }
        });
      });

      // Client sends state with a custom key
      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
        callId: 'cg-merge-call-1',
        binding: 'ECHO_DO',
        instance: 'echo-cg-merge',
        chain,
        callContext: {
          callChain: [],
          state: preprocess({ myClientKey: 'clientValue' }),
        },
      }));

      const callResponse = await responsePromise;
      expect(callResponse.success).toBe(true);

      // Both client state and injected _auth should be present
      expect(callResponse.result.state.myClientKey).toBe('clientValue');
      expect(callResponse.result.state._auth).toMatchObject({
        sub: 'cg-merge',
        claims: { role: 'viewer' },
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

      // Call __executeOperation directly with a blocked caller binding
      const envelope: CallEnvelope = {
        version: 1,
        chain: preprocess([
          { type: 'get', key: 'someMethod' },
          { type: 'apply', args: [] },
        ]),
        callContext: { callChain: [], state: {} },
        metadata: {
          caller: {
            type: 'LumenizeDO',
            bindingName: 'BLOCKED_BINDING',
            instanceName: 'some-instance',
          },
        },
      };

      const result = await gateway.__executeOperation(envelope);

      expect(result.$error).toBeDefined();
      const error = postprocess(result.$error);
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
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.INCOMING_CALL) {
            ws.removeEventListener('message', handler);
            resolve(msg);
          }
        });
      });

      // Call __executeOperation with a non-blocked binding — should forward to client
      const envelope: CallEnvelope = {
        version: 1,
        chain: preprocess([
          { type: 'get', key: 'someMethod' },
          { type: 'apply', args: [] },
        ]),
        callContext: { callChain: [], state: {} },
        metadata: {
          caller: {
            type: 'LumenizeDO',
            bindingName: 'ALLOWED_BINDING',
            instanceName: 'some-instance',
          },
        },
      };

      // Start the __executeOperation (it will wait for client response)
      const execPromise = gateway.__executeOperation(envelope);

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

      const result = await execPromise;
      expect(result.$result).toBeDefined();

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

      const responsePromise = new Promise<CallResponseMessage>((resolve) => {
        ws.addEventListener('message', function handler(event) {
          const msg = JSON.parse(event.data as string);
          if (msg.type === GatewayMessageType.CALL_RESPONSE) {
            ws.removeEventListener('message', handler);
            msg.result = postprocess(msg.result);
            resolve(msg);
          }
        });
      });

      ws.send(JSON.stringify({
        type: GatewayMessageType.CALL,
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

      // 2. onBeforeCallToMesh: _auth injected into state
      expect(callResponse.result.state._auth).toMatchObject({
        sub: 'cg-e2e',
        claims: { role: 'admin', org: 'composure-inc' },
      });

      // 3. bindingName: from X-Lumenize-DO-Binding-Name routing header
      expect(callResponse.result.callChain[0].bindingName).toBe('CUSTOM_GATEWAY');

      ws.close();
    });
  });
});
