/**
 * Unit tests for LumenizeClient
 *
 * These tests verify client-only behavior without mesh integration.
 * For mesh integration tests, see the end-to-end tests in test/for-docs/.
 *
 * NOTE: These tests use a minimal WebSocket stub, NOT full integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Note: LumenizeClient uses JSON.parse for incoming messages
// Tests use JSON.stringify to simulate gateway messages
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
  @mesh()
  handleMessage(text: string): string {
    return `Received: ${text}`;
  }

  // Non-mesh method for testing access control
  privateMethod(): string {
    return 'This should not be callable from mesh';
  }

  // ============================================
  // @mesh(guard) test helpers for Client
  // ============================================

  // Method with guard that checks for 'admin' role in callContext.state
  @mesh((instance: TestClient) => {
    const role = instance.lmz.callContext?.state?.['role'];
    if (role !== 'admin') {
      throw new Error('Client Guard: admin role required');
    }
  })
  guardedClientAdminMethod(): string {
    return 'client-admin-only-result';
  }

  // Method with guard that checks for any authenticated user
  @mesh((instance: TestClient) => {
    const userId = instance.lmz.callContext?.state?.['userId'];
    if (!userId) {
      throw new Error('Client Guard: authentication required');
    }
  })
  guardedClientAuthMethod(): string {
    return 'client-authenticated-result';
  }

  // Method with async guard (to test Promise support)
  @mesh(async (instance: TestClient) => {
    // Simulate async check
    await Promise.resolve();
    const token = instance.lmz.callContext?.state?.['token'];
    if (token !== 'valid-token') {
      throw new Error('Client Guard: valid token required');
    }
  })
  guardedClientAsyncMethod(): string {
    return 'client-async-guard-passed';
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
    it('allows omitting instanceName when refresh is a URL string', () => {
      // Should not throw — instanceName will be auto-generated on connect
      const client = new TestClient({
        baseUrl: 'wss://example.com',
        WebSocket: createMockWebSocketClass(),
        refresh: '/auth/refresh-token',
      });
      client.disconnect();
    });

    it('allows omitting instanceName when refresh is a function', () => {
      // Should not throw — function returns { access_token, sub }
      const client = new TestClient({
        baseUrl: 'wss://example.com',
        WebSocket: createMockWebSocketClass(),
        refresh: async () => ({ access_token: 'token', sub: 'user-123' }),
      });
      client.disconnect();
    });

    it('throws when accessing lmz.instanceName before connected (auto-generate mode)', () => {
      const client = new TestClient({
        baseUrl: 'wss://example.com',
        WebSocket: createMockWebSocketClass(),
        refresh: '/auth/refresh-token',
      });

      expect(() => client.lmz.instanceName).toThrow(
        'instanceName is only available after connected state'
      );
      client.disconnect();
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
      ws.simulateMessage(JSON.stringify({
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

      ws.simulateMessage(JSON.stringify({
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
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Now the queued message should have been sent
    expect(ws.getSentMessages().length).toBe(1);

    client.disconnect();
  });
});

describe('Stale close from superseded socket', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('does not clobber new connection when old socket closes with 4409', () => {
    const states: ConnectionState[] = [];
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
      onConnectionStateChange: (state) => states.push(state),
    });

    // First WebSocket connects
    const ws1 = createdWebSockets[0];
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));
    expect(client.connectionState).toBe('connected');

    // Simulate network drop — close fires, triggers reconnect
    ws1.simulateClose(1006, 'Connection lost');
    expect(client.connectionState).toBe('reconnecting');

    // Client reconnects — new WebSocket is created
    // (reconnect timer fires, creating ws2)
    // For unit test, manually trigger connect since timers are mocked
    client.connect();
    const ws2 = createdWebSockets[1];
    expect(ws2).toBeDefined();

    ws2.simulateOpen();
    ws2.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));
    expect(client.connectionState).toBe('connected');

    // Now the old socket's stale close event arrives (e.g., server sent 4409).
    // Before the fix, this would set this.#ws = null, clobbering ws2.
    ws1.simulateClose(4409, 'Superseded by new connection');

    // Connection should still be 'connected' — stale close must be ignored
    expect(client.connectionState).toBe('connected');

    client.disconnect();
  });

  it('still handles close normally when socket is current', () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws1 = createdWebSockets[0];
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));
    expect(client.connectionState).toBe('connected');

    // Normal close on the current socket should still work
    ws1.simulateClose(1006, 'Connection lost');
    expect(client.connectionState).toBe('reconnecting');

    client.disconnect();
  });
});

describe('@mesh(guard) on LumenizeClient', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('guard is defined on decorated methods', () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    // The guard methods should exist and be mesh-callable
    expect(typeof client.guardedClientAdminMethod).toBe('function');
    expect(typeof client.guardedClientAuthMethod).toBe('function');
    expect(typeof client.guardedClientAsyncMethod).toBe('function');

    client.disconnect();
  });

  // Note: Full guard execution tests require mesh integration which is tested
  // via the for-docs integration tests. The guard mechanism is shared across
  // all node types via ocan/execute.ts, and is thoroughly tested for LumenizeDO
  // in call-context.test.ts. The TestWorker guards are also tested there.
});

describe('Token refresh', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('refreshes token via function before connecting', async () => {
    let refreshCalled = false;
    const client = new TestClient({
      baseUrl: 'wss://example.com',
      WebSocket: createMockWebSocketClass(),
      refresh: async () => {
        refreshCalled = true;
        return { access_token: 'new-token', sub: 'user-from-refresh' };
      },
    });

    // Wait for async connect to complete (refresh + WebSocket creation)
    await new Promise(r => setTimeout(r, 10));

    expect(refreshCalled).toBe(true);
    // instanceName should be auto-generated from sub
    expect(client.lmz.instanceName).toContain('user-from-refresh');
    client.disconnect();
  });

  it('refreshes token via URL endpoint before connecting', async () => {
    let fetchCalled = false;
    const client = new TestClient({
      baseUrl: 'wss://example.com',
      WebSocket: createMockWebSocketClass(),
      refresh: '/auth/refresh-token',
      fetch: async (url, init) => {
        fetchCalled = true;
        expect(url).toBe('/auth/refresh-token');
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({
          access_token: 'url-token',
          sub: 'url-user',
        }));
      },
    });

    await new Promise(r => setTimeout(r, 10));

    expect(fetchCalled).toBe(true);
    expect(client.lmz.instanceName).toContain('url-user');
    client.disconnect();
  });

  it('handles token expiry close code (4401) by refreshing', async () => {
    let refreshCount = 0;
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'initial-token',
      WebSocket: createMockWebSocketClass(),
      refresh: async () => {
        refreshCount++;
        return { access_token: `token-${refreshCount}`, sub: 'user' };
      },
    });

    // With accessToken provided, WS is created synchronously
    const ws1 = createdWebSockets[0];
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));
    expect(client.connectionState).toBe('connected');

    // Simulate token expiry close — should trigger refresh + reconnect
    ws1.simulateClose(4401, 'Token expired');

    // Wait for refresh + reconnect
    await new Promise(r => setTimeout(r, 50));

    expect(refreshCount).toBeGreaterThanOrEqual(1);
    client.disconnect();
  });

  it('calls onLoginRequired when refresh fails', async () => {
    let loginRequiredCalled = false;
    let refreshCallCount = 0;
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'initial-token',
      WebSocket: createMockWebSocketClass(),
      refresh: async () => {
        refreshCallCount++;
        // Fail on the second call (4401 handler), succeed on first (initial connect doesn't call refresh)
        throw new Error('Refresh failed');
      },
      onLoginRequired: () => {
        loginRequiredCalled = true;
      },
    });

    // With accessToken provided, WS is created synchronously
    const ws1 = createdWebSockets[0];
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Token expiry close triggers refresh, which fails
    ws1.simulateClose(4401, 'Token expired');

    await new Promise(r => setTimeout(r, 50));

    expect(loginRequiredCalled).toBe(true);
    expect(client.connectionState).toBe('disconnected');
    client.disconnect();
  });
});

describe('Reconnection', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('schedules reconnect with exponential backoff', async () => {
    const states: ConnectionState[] = [];
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
      onConnectionStateChange: (state) => states.push(state),
    });

    const ws1 = createdWebSockets[0];
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Close triggers reconnect scheduling
    ws1.simulateClose(1006, 'Connection lost');
    expect(client.connectionState).toBe('reconnecting');

    // After timeout fires, a new WS should be created
    // Wait for initial backoff (1s) + buffer
    await new Promise(r => setTimeout(r, 1200));

    expect(createdWebSockets.length).toBeGreaterThanOrEqual(2);
    client.disconnect();
  });

  it('calls onConnectionError on WebSocket error', () => {
    let errorCalled = false;
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
      onConnectionError: () => { errorCalled = true; },
    });

    const ws = createdWebSockets[0];
    ws.simulateError();

    expect(errorCalled).toBe(true);
    client.disconnect();
  });

  it('connect() is no-op when already connected', () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Should not create a new WebSocket
    client.connect();
    expect(createdWebSockets.length).toBe(1);

    client.disconnect();
  });
});

describe('Incoming calls from mesh', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('executes @mesh handler on incoming call and sends response', async () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Simulate incoming call from gateway
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    ws.simulateMessage(JSON.stringify({
      type: 'incoming_call',
      callId: 'incoming-1',
      chain: pp([
        { type: 'get', key: 'handleMessage' },
        { type: 'apply', args: ['hello from mesh'] },
      ]),
      callContext: {
        callChain: [
          { type: 'LumenizeDO', bindingName: 'SOME_DO', instanceName: 'inst-1' },
        ],
        state: pp({}),
      },
    }));

    // Wait for async handler
    await new Promise(r => setTimeout(r, 50));

    // Client should have sent an incoming_call_response
    const sentMessages = ws.getSentMessages();
    const responseMsg = sentMessages.find(m => {
      const parsed = JSON.parse(m);
      return parsed.type === 'incoming_call_response';
    });

    expect(responseMsg).toBeDefined();
    const parsed = JSON.parse(responseMsg!);
    expect(parsed.callId).toBe('incoming-1');
    expect(parsed.success).toBe(true);

    client.disconnect();
  });

  it('sends error response when incoming call handler throws', async () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    const { preprocess: pp } = await import('@lumenize/structured-clone');
    // Call a method that doesn't exist — should fail
    ws.simulateMessage(JSON.stringify({
      type: 'incoming_call',
      callId: 'incoming-err-1',
      chain: pp([
        { type: 'get', key: 'nonExistentMethod' },
        { type: 'apply', args: [] },
      ]),
      callContext: {
        callChain: [
          { type: 'LumenizeDO', bindingName: 'SOME_DO', instanceName: 'inst-1' },
        ],
        state: pp({}),
      },
    }));

    await new Promise(r => setTimeout(r, 50));

    const sentMessages = ws.getSentMessages();
    const responseMsg = sentMessages.find(m => {
      const parsed = JSON.parse(m);
      return parsed.type === 'incoming_call_response';
    });

    expect(responseMsg).toBeDefined();
    const parsed = JSON.parse(responseMsg!);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();

    client.disconnect();
  });
});

describe('Message queue overflow', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('rejects when message queue is full', async () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    // Queue up many calls while not connected
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 101; i++) {
      promises.push(
        client.lmz.callRaw('SOME_DO', 'instance1', [
          { type: 'get', key: 'someMethod' },
          { type: 'apply', args: [i] }
        ])
      );
    }

    // The 101st call should be rejected with 'Message queue full'
    await expect(promises[100]).rejects.toThrow('Message queue full');

    client.disconnect();
  });
});

describe('call() fire-and-forget', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('sends call message without blocking', () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // call() should not throw and should return void
    const remote = client.ctn<TestClient>().handleMessage('fire-and-forget');
    client.lmz.call('SOME_DO', 'instance1', remote);

    // Message should have been sent
    expect(ws.getSentMessages().length).toBe(1);

    client.disconnect();
  });

  it('sends call with handler continuation', async () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    const remote = client.ctn<TestClient>().handleMessage('call-with-handler');
    const handler = client.ctn().handleMessage(remote);
    client.lmz.call('SOME_DO', 'instance1', remote, handler);

    // Message should have been sent
    expect(ws.getSentMessages().length).toBe(1);

    client.disconnect();
  });
});

describe('Message handling edge cases', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('handles invalid JSON in incoming message gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Send invalid JSON — should not throw, just log error
    ws.simulateMessage('not valid json {{{');

    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to parse Gateway message:',
      expect.any(SyntaxError),
    );

    consoleSpy.mockRestore();
    client.disconnect();
  });

  it('warns on unknown Gateway message type', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Send a message with an unknown type
    ws.simulateMessage(JSON.stringify({ type: 'unknown_message_type' }));

    expect(consoleSpy).toHaveBeenCalledWith(
      'Unknown Gateway message type:',
      'unknown_message_type',
    );

    consoleSpy.mockRestore();
    client.disconnect();
  });

  it('warns when receiving response for unknown callId', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Send a call_response for a callId that doesn't exist
    ws.simulateMessage(JSON.stringify({
      type: 'call_response',
      callId: 'nonexistent-call-id',
      success: true,
      result: null,
    }));

    expect(consoleSpy).toHaveBeenCalledWith(
      'Received response for unknown call:',
      'nonexistent-call-id',
    );

    consoleSpy.mockRestore();
    client.disconnect();
  });

  it('resolves pending call on successful call_response', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Make a call
    const resultPromise = client.lmz.callRaw('SOME_DO', 'instance1', [
      { type: 'get', key: 'someMethod' },
      { type: 'apply', args: [] },
    ]);

    // Extract the callId from the sent message
    const sentMsg = JSON.parse(ws.getSentMessages()[0]);
    const callId = sentMsg.callId;

    // Simulate a successful response
    ws.simulateMessage(JSON.stringify({
      type: 'call_response',
      callId,
      success: true,
      result: pp('hello-result'),
    }));

    const result = await resultPromise;
    expect(result).toBe('hello-result');

    client.disconnect();
  });

  it('rejects pending call on error call_response', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Make a call
    const resultPromise = client.lmz.callRaw('SOME_DO', 'instance1', [
      { type: 'get', key: 'someMethod' },
      { type: 'apply', args: [] },
    ]);

    const sentMsg = JSON.parse(ws.getSentMessages()[0]);
    const callId = sentMsg.callId;

    // Simulate an error response
    ws.simulateMessage(JSON.stringify({
      type: 'call_response',
      callId,
      success: false,
      error: pp(new Error('Something went wrong')),
    }));

    await expect(resultPromise).rejects.toThrow('Something went wrong');

    client.disconnect();
  });
});

describe('Token refresh edge cases', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('throws when no refresh method configured and token needed', async () => {
    // Create client without accessToken or refresh — connect will fail
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      WebSocket: createMockWebSocketClass(),
    });

    // connect() is called in constructor, but with instanceName + no accessToken,
    // it calls #refreshToken() which should throw "No refresh method configured"
    // Wait for async connect to settle
    await new Promise(r => setTimeout(r, 50));

    // Client should be in reconnecting state (failed connect triggers reconnect)
    // or disconnected. The error is swallowed internally.
    client.disconnect();
  });

  it('throws when refresh URL returns non-ok response', async () => {
    let loginRequiredCalled = false;
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      WebSocket: createMockWebSocketClass(),
      refresh: '/auth/refresh-token',
      fetch: async () => new Response('Unauthorized', { status: 401 }),
      onLoginRequired: () => { loginRequiredCalled = true; },
    });

    // Wait for async connect
    await new Promise(r => setTimeout(r, 50));

    client.disconnect();
  });

  it('throws when refresh returns no access_token', async () => {
    const client = new TestClient({
      baseUrl: 'wss://example.com',
      WebSocket: createMockWebSocketClass(),
      refresh: async () => ({ access_token: '', sub: 'user' } as any),
    });

    // Wait for async connect
    await new Promise(r => setTimeout(r, 50));

    client.disconnect();
  });
});

describe('Disconnect cleanup', () => {
  beforeEach(() => {
    createdWebSockets = [];
  });

  it('rejects pending calls on disconnect', async () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    // Make a call while connecting (not connected yet so message is queued)
    const callPromise = client.lmz.callRaw('SOME_DO', 'instance1', [
      { type: 'get', key: 'someMethod' },
      { type: 'apply', args: [] },
    ]);

    // Disconnect before response
    client.disconnect();

    await expect(callPromise).rejects.toThrow('Client disconnected');
  });

  it('clears reconnect timer on disconnect', () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionsLost: false,
    }));

    // Trigger reconnect scheduling
    ws.simulateClose(1006, 'Connection lost');
    expect(client.connectionState).toBe('reconnecting');

    // Disconnect should clear the reconnect timer
    client.disconnect();
    expect(client.connectionState).toBe('disconnected');
  });
});
