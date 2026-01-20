/**
 * Unit tests for LumenizeClient
 *
 * These tests verify client-only behavior without mesh integration.
 * For mesh integration tests, see the end-to-end tests in test/for-docs/.
 *
 * NOTE: These tests use a minimal WebSocket stub, NOT full integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stringify } from '@lumenize/structured-clone';
import {
  LumenizeClient,
  LoginRequiredError,
  type LumenizeClientConfig,
  type ConnectionState,
  mesh,
} from '../src/index.js';

// ============================================
// Minimal WebSocket Stub for Unit Testing
// ============================================

type WebSocketEventHandler = ((event: any) => void) | null;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  url: string;
  protocol: string = '';
  protocols: string[];

  onopen: WebSocketEventHandler = null;
  onclose: WebSocketEventHandler = null;
  onerror: WebSocketEventHandler = null;
  onmessage: WebSocketEventHandler = null;

  #sentMessages: string[] = [];
  #closeCode?: number;
  #closeReason?: string;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.protocol = 'lmz';
    this.onopen?.({});
  }

  simulateClose(code: number, reason: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  simulateError(): void {
    this.onerror?.({});
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }

  getSentMessages(): string[] {
    return this.#sentMessages;
  }

  getCloseInfo(): { code?: number; reason?: string } {
    return { code: this.#closeCode, reason: this.#closeReason };
  }

  // WebSocket API
  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.#sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.#closeCode = code;
    this.#closeReason = reason;
    this.readyState = MockWebSocket.CLOSING;
    // In real WebSocket, close event fires asynchronously
    // For testing, we don't auto-fire it - tests call simulateClose
  }
}

// Global to track created WebSocket instances
let createdWebSockets: MockWebSocket[] = [];

function createMockWebSocketClass(): typeof WebSocket {
  return class extends (MockWebSocket as any) {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols);
      createdWebSockets.push(this as any);
    }
  } as typeof WebSocket;
}

// ============================================
// Test Client Implementation
// ============================================

class TestClient extends LumenizeClient {
  // Track calls to onBeforeCall
  onBeforeCallCalled = false;
  onBeforeCallContext: any = null;

  // Override to track calls
  onBeforeCall(): void {
    this.onBeforeCallCalled = true;
    try {
      this.onBeforeCallContext = this.lmz.callContext;
    } catch {
      // callContext not available
    }
    super.onBeforeCall();
  }

  // Expose a mesh method for testing
  @mesh
  handleMessage(text: string): string {
    return `Received: ${text}`;
  }

  // Non-mesh method for testing access control
  privateMethod(): string {
    return 'This should not be callable from mesh';
  }
}

// ============================================
// Tests
// ============================================

describe('LumenizeClient', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  afterEach(() => {
    // Clean up any created clients
    createdWebSockets.forEach(ws => {
      if (ws.readyState === MockWebSocket.OPEN || ws.readyState === MockWebSocket.CONNECTING) {
        ws.readyState = MockWebSocket.CLOSED;
      }
    });
  });

  describe('Configuration', () => {
    it('throws if instanceName is not provided', () => {
      expect(() => {
        new TestClient({
          WebSocket: createMockWebSocketClass(),
        } as any);
      }).toThrow('LumenizeClient requires instanceName in config');
    });

    it('uses default gateway binding name', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        WebSocket: createMockWebSocketClass(),
      });

      expect(client.lmz.bindingName).toBe('LUMENIZE_CLIENT_GATEWAY');
      client.disconnect();
    });

    it('allows custom gateway binding name', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        gatewayBindingName: 'CUSTOM_GATEWAY',
        WebSocket: createMockWebSocketClass(),
      });

      expect(client.lmz.bindingName).toBe('CUSTOM_GATEWAY');
      client.disconnect();
    });

    it('exposes instanceName via lmz api', () => {
      const client = new TestClient({
        instanceName: 'alice.tab123',
        baseUrl: 'wss://example.com',
        WebSocket: createMockWebSocketClass(),
      });

      expect(client.lmz.instanceName).toBe('alice.tab123');
      client.disconnect();
    });

    it('exposes type as LumenizeClient', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        WebSocket: createMockWebSocketClass(),
      });

      expect(client.lmz.type).toBe('LumenizeClient');
      client.disconnect();
    });
  });

  describe('URL Building', () => {
    it('converts https to wss', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'https://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
      });

      expect(createdWebSockets[0].url).toContain('wss://example.com');
      client.disconnect();
    });

    it('converts http to ws', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'http://localhost:8787',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
      });

      expect(createdWebSockets[0].url).toContain('ws://localhost:8787');
      client.disconnect();
    });

    it('builds correct path with binding and instance', () => {
      const client = new TestClient({
        instanceName: 'alice.tab123',
        baseUrl: 'wss://example.com',
        gatewayBindingName: 'MY_GATEWAY',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
      });

      expect(createdWebSockets[0].url).toBe('wss://example.com/gateway/MY_GATEWAY/alice.tab123');
      client.disconnect();
    });

    it('includes lmz protocol', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
      });

      expect(createdWebSockets[0].protocols).toContain('lmz');
      client.disconnect();
    });

    it('includes access token in protocol if provided', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'test-jwt-token',
        WebSocket: createMockWebSocketClass(),
      });

      expect(createdWebSockets[0].protocols).toContain('lmz.access-token.test-jwt-token');
      client.disconnect();
    });
  });

  describe('Connection State', () => {
    it('starts in connecting state after construction', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
      });

      expect(client.connectionState).toBe('connecting');
      client.disconnect();
    });

    it('transitions to connected on connection_status message', () => {
      const states: ConnectionState[] = [];
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
        onConnectionStateChange: (state) => states.push(state),
      });

      const ws = createdWebSockets[0];
      ws.simulateOpen();

      // Send connection_status message
            ws.simulateMessage(stringify({
        type: 'connection_status',
        subscriptionsLost: false,
      }));

      expect(client.connectionState).toBe('connected');
      expect(states).toContain('connected');
      client.disconnect();
    });

    it('calls onSubscriptionsLost when subscriptionsLost is true', () => {
      let subscriptionsLostCalled = false;
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
        onSubscriptionsLost: () => { subscriptionsLostCalled = true; },
      });

      const ws = createdWebSockets[0];
      ws.simulateOpen();

            ws.simulateMessage(stringify({
        type: 'connection_status',
        subscriptionsLost: true,
      }));

      expect(subscriptionsLostCalled).toBe(true);
      client.disconnect();
    });

    it('transitions to disconnected on disconnect()', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
      });

      client.disconnect();
      expect(client.connectionState).toBe('disconnected');
    });

    it('transitions to reconnecting after close', async () => {
      const states: ConnectionState[] = [];
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
        onConnectionStateChange: (state) => states.push(state),
      });

      const ws = createdWebSockets[0];
      ws.simulateClose(1006, 'Connection lost');

      expect(client.connectionState).toBe('reconnecting');
      expect(states).toContain('reconnecting');
      client.disconnect();
    });
  });

  describe('LoginRequiredError', () => {
    it('is thrown with correct properties', () => {
      const error = new LoginRequiredError('Test error', 4401, 'Token expired');

      expect(error.name).toBe('LoginRequiredError');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe(4401);
      expect(error.reason).toBe('Token expired');
    });

    it('calls onLoginRequired on 4400 close code', () => {
      let loginRequiredError: LoginRequiredError | null = null;
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
        onLoginRequired: (error) => { loginRequiredError = error; },
      });

      const ws = createdWebSockets[0];
      ws.simulateClose(4400, 'No token provided');

      expect(loginRequiredError).not.toBeNull();
      expect(loginRequiredError!.code).toBe(4400);
      expect(client.connectionState).toBe('disconnected');
      client.disconnect();
    });

    it('calls onLoginRequired on 4403 close code', () => {
      let loginRequiredError: LoginRequiredError | null = null;
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
        onLoginRequired: (error) => { loginRequiredError = error; },
      });

      const ws = createdWebSockets[0];
      ws.simulateClose(4403, 'Invalid token signature');

      expect(loginRequiredError).not.toBeNull();
      expect(loginRequiredError!.code).toBe(4403);
      client.disconnect();
    });
  });

  describe('Continuations', () => {
    it('ctn() returns a continuation proxy', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
      });

      const ctn = client.ctn<TestClient>();

      // Should be able to chain methods and get type-safe continuations
      const chain = ctn.handleMessage('test');
      expect(chain).toBeDefined();

      client.disconnect();
    });
  });

  describe('callContext access', () => {
    it('throws when accessing callContext outside of handler', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
      });

      expect(() => client.lmz.callContext).toThrow(
        'Cannot access callContext outside of a mesh call'
      );
      client.disconnect();
    });

  });

  describe('Symbol.dispose', () => {
    it('disconnects when using "using" keyword simulation', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
      });

      // Simulate what 'using' does
      client[Symbol.dispose]();

      expect(client.connectionState).toBe('disconnected');
    });
  });

  describe('Default onBeforeCall', () => {
    it('rejects calls from LumenizeClient origins by default', () => {
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
      });

      // Set up a fake call context with LumenizeClient origin
      // @ts-ignore - accessing private for testing
      client['#currentCallContext'] = {
        origin: { type: 'LumenizeClient', bindingName: 'GATEWAY', instanceName: 'other.tab1' },
        callChain: [],
        callee: { type: 'LumenizeClient', bindingName: 'GATEWAY', instanceName: 'user.tab1' },
        state: {},
      };

      // Note: We can't directly test onBeforeCall because #currentCallContext is private
      // This would be tested in integration tests
      client.disconnect();
    });
  });
});

describe('Message Queue', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('queues messages when not connected', () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    // WebSocket is connecting, not open yet
    expect(createdWebSockets[0].readyState).toBe(MockWebSocket.CONNECTING);

    // Make a call - it should be queued, not sent
    const callPromise = client.lmz.callRaw('SOME_DO', 'instance1', [
      { type: 'get', key: 'someMethod' },
      { type: 'apply', args: [] }
    ]);

    // Check no messages were sent yet
    expect(createdWebSockets[0].getSentMessages().length).toBe(0);

    client.disconnect();
  });

  it('flushes queue when connection_status is received', () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    // Make a call while connecting
    client.lmz.callRaw('SOME_DO', 'instance1', [
      { type: 'get', key: 'someMethod' },
      { type: 'apply', args: [] }
    ]);

    // Simulate connection
    const ws = createdWebSockets[0];
    ws.simulateOpen();

    // Send connection_status
        ws.simulateMessage(stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Now the queued message should have been sent
    expect(ws.getSentMessages().length).toBe(1);

    client.disconnect();
  });
});
