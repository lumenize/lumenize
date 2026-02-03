import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { stringify, parse, preprocess, postprocess } from '@lumenize/structured-clone';
import {
  GatewayMessageType,
  ClientDisconnectedError,
  type ConnectionStatusMessage,
  type CallMessage,
  type CallResponseMessage,
  type IncomingCallMessage,
  type IncomingCallResponseMessage,
} from '../src/lumenize-client-gateway';

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
        },
      });

      expect(response.status).toBe(101); // Switching Protocols
      expect(response.webSocket).toBeDefined();
    });

    it('sends connection_status message with subscriptionsLost: false on fresh connection', async () => {
      const id = env.LUMENIZE_CLIENT_GATEWAY.idFromName('fresh-conn.tab1');
      const gateway = env.LUMENIZE_CLIENT_GATEWAY.get(id);

      const token = createFakeJwt({ sub: 'fresh-conn', exp: Math.floor(Date.now() / 1000) + 900 });
      const response = await gateway.fetch('https://example.com', {
        headers: {
          'Upgrade': 'websocket',
          'Authorization': `Bearer ${token}`,
          'X-Lumenize-DO-Instance-Name-Or-Id': 'fresh-conn.tab1',
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
      expect(statusMessage.subscriptionsLost).toBe(false);

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
        userId: 'auth-user', // Bridge: attachment.sub → originAuth.userId
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

  // Note: Grace period and alarm tests are more complex and may require
  // additional test infrastructure to properly test the state machine.
  // These can be added in a follow-up once the basic functionality is verified.
});
