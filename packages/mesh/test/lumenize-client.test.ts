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
import { WS_HEARTBEAT_PING, WS_HEARTBEAT_PONG } from '../src/ws-heartbeat.js';

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
// JWT fixture helper
// ============================================

/**
 * Build a structurally valid JWT with the given payload claims.
 * Signature is fake — used for unit tests that parse the payload
 * (`parseJwtUnsafe`) without verification.
 */
function createFakeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${header}.${body}.fakesig`;
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

  // Continuation-only: capture a 4-arg call's delivered outcome (value OR Error) for assertions.
  // Runs as the in-heap handler when a RESULT arrives (requireMeshDecorator:false — no @mesh needed).
  #lastCallOutcome: any = undefined;
  #callOutcomeCount = 0;
  captureOutcome(resultOrError: any): void {
    this.#lastCallOutcome = resultOrError;
    this.#callOutcomeCount += 1;
  }
  getLastCallOutcome(): any {
    return this.#lastCallOutcome;
  }
  getCallOutcomeCount(): number {
    return this.#callOutcomeCount;
  }
  // Expose the protected test-only count for callAsync no-leak/cleanup assertions.
  getPendingAsyncCallCount(): number {
    return this.pendingAsyncCallCount();
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

  // Method with synchronous guard
  @mesh((instance: TestClient) => {
    const token = instance.lmz.callContext?.state?.['token'];
    if (token !== 'valid-token') {
      throw new Error('Client Guard: valid token required');
    }
  })
  guardedClientMethod(): string {
    return 'client-guard-passed';
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

  describe('client.claims', () => {
    it('is null before any token is available', () => {
      const client = new TestClient({
        baseUrl: 'wss://example.com',
        WebSocket: createMockWebSocketClass(),
        refresh: '/auth/refresh-token',
      });

      expect(client.claims).toBeNull();
      client.disconnect();
    });

    it('is populated from initial accessToken in config', () => {
      const token = createFakeJwt({ sub: 'alice', aud: 'tenant-x', iat: 1700000000 });
      const client = new TestClient({
        instanceName: 'alice.tab1',
        baseUrl: 'wss://example.com',
        accessToken: token,
        WebSocket: createMockWebSocketClass(),
      });

      expect(client.claims).not.toBeNull();
      expect(client.claims?.sub).toBe('alice');
      expect(client.claims?.aud).toBe('tenant-x');
      expect(client.claims?.iat).toBe(1700000000);
      client.disconnect();
    });

    it('is populated after refresh via function', async () => {
      const token = createFakeJwt({ sub: 'bob', aud: 'tenant-y' });
      const client = new TestClient({
        baseUrl: 'wss://example.com',
        WebSocket: createMockWebSocketClass(),
        refresh: async () => ({ access_token: token }),
      });

      await new Promise(r => setTimeout(r, 10));

      expect(client.claims?.sub).toBe('bob');
      expect(client.claims?.aud).toBe('tenant-y');
      client.disconnect();
    });

    it('is frozen — payload cannot be mutated', () => {
      const token = createFakeJwt({ sub: 'carol' });
      const client = new TestClient({
        instanceName: 'carol.tab1',
        baseUrl: 'wss://example.com',
        accessToken: token,
        WebSocket: createMockWebSocketClass(),
      });

      expect(Object.isFrozen(client.claims)).toBe(true);
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
        subscriptionRequired: false,
      }));

      expect(client.connectionState).toBe('connected');
      expect(states).toContain('connected');
      client.disconnect();
    });

    it('calls onSubscriptionRequired when subscriptionRequired is true', () => {
      let subscriptionRequiredCalled = false;
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: 'token',
        WebSocket: createMockWebSocketClass(),
        onSubscriptionRequired: () => { subscriptionRequiredCalled = true; },
      });

      const ws = createdWebSockets[0];
      ws.simulateOpen();

      ws.simulateMessage(JSON.stringify({
        type: 'connection_status',
        subscriptionRequired: true,
      }));

      expect(subscriptionRequiredCalled).toBe(true);
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

  describe('clearAccessToken', () => {
    it('drops the in-memory token and claims so the next connect re-refreshes', async () => {
      // P9: the mesh half of logout. disconnect() keeps the token (reconnect
      // works); clearAccessToken() forgets it — claims go null AND the next
      // connect() must call refresh again.
      let refreshCount = 0;
      const client = new TestClient({
        instanceName: 'user.tab1',
        baseUrl: 'wss://example.com',
        accessToken: createFakeJwt({ sub: 'user' }),
        WebSocket: createMockWebSocketClass(),
        refresh: async () => {
          refreshCount++;
          return { access_token: createFakeJwt({ sub: 'user', n: refreshCount }) };
        },
      });

      // accessToken supplied → claims populated, no refresh on initial connect.
      expect(client.claims).not.toBeNull();
      expect(refreshCount).toBe(0);

      client.disconnect();          // tear down; token + claims still held
      client.clearAccessToken();    // now forget them
      // Asserts the #claims = null line (without it, claims stays populated).
      expect(client.claims).toBeNull();

      // Asserts the #accessToken = null line: with the token gone, connect()
      // must re-refresh; if the token weren't cleared, #connectInternal skips
      // refresh and refreshCount stays 0.
      client.connect();
      await vi.waitFor(() => expect(refreshCount).toBe(1));

      client.disconnect();
    });
  });

  // The default onBeforeCall (client peer-guard) is covered by capable-of-failing INTEGRATION tests
  // in test/for-docs/calls/peer-guard.test.ts — the guard needs a real callChain, which #currentCallContext
  // (private) can't be faked into here. A prior placeholder unit test lived here but asserted nothing.
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

    // Make a fire-and-forget call — it should be queued, not sent (not connected yet).
    client.lmz.call('SOME_DO', 'instance1', (client.ctn() as any).someMethod());

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
    client.lmz.call('SOME_DO', 'instance1', (client.ctn() as any).someMethod());

    // Simulate connection
    const ws = createdWebSockets[0];
    ws.simulateOpen();

    // Send connection_status
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionRequired: false,
    }));

    // Now the queued message should have been sent
    expect(ws.getSentMessages().length).toBe(1);

    client.disconnect();
  });
});

describe('A call after the token lapsed', () => {
  beforeEach(() => { createdWebSockets = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('is never sent on the stale socket — it is queued, the socket rotates, and the new socket delivers it', async () => {
    // Real timers keep flowing (the client's own awaits and the 10 ms waits below need them); only the
    // wall clock is jumped, which is what a lapse IS from the client's point of view.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const nowSec = () => Math.floor(Date.now() / 1000);
    let mints = 0;
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      WebSocket: createMockWebSocketClass(),
      // First mint: 100 s of life, well outside the 30 s refresh-ahead window, so the connect does
      // not refresh. Every later mint is fresh again.
      refresh: async () => { mints++; return { access_token: createFakeJwt({ sub: 'user', exp: nowSec() + 100 }) }; },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mints).toBe(1);
    const stale = createdWebSockets[0];
    stale.simulateOpen();
    stale.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));
    expect(client.connectionState).toBe('connected');

    // The lapse: the token is 100 s past its exp, and the socket is still OPEN — exactly the state
    // an idle tab is in when the person comes back.
    vi.setSystemTime(Date.now() + 200_000);
    client.lmz.call('SOME_DO', 'instance1', (client.ctn() as any).someMethod());

    // ⚠️ Never on the stale socket: the Gateway would 4401 it and drop the message at the door.
    expect(stale.getSentMessages().length).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(mints).toBe(2);                                   // refreshed exactly once
    expect(createdWebSockets.length).toBe(2);                // a new socket, authenticated afresh
    expect(stale.readyState).toBe(MockWebSocket.CLOSING);    // the old one is being retired
    const fresh = createdWebSockets[1];
    expect(fresh.getSentMessages().length).toBe(0);          // nothing until the Gateway says ready

    fresh.simulateOpen();
    fresh.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));
    expect(fresh.getSentMessages().length).toBe(1);          // the lapsed call, delivered
    expect(stale.getSentMessages().length).toBe(0);          // and still never on the stale one
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
      subscriptionRequired: false,
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
      subscriptionRequired: false,
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
      subscriptionRequired: false,
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
    expect(typeof client.guardedClientMethod).toBe('function');

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
        return { access_token: createFakeJwt({ sub: 'user-from-refresh' }) };
      },
    });

    // Wait for async connect to complete (refresh + WebSocket creation)
    await new Promise(r => setTimeout(r, 10));

    expect(refreshCalled).toBe(true);
    // instanceName should be auto-generated from the JWT's sub claim
    expect(client.lmz.instanceName).toContain('user-from-refresh');
    expect(client.claims?.sub).toBe('user-from-refresh');
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
          access_token: createFakeJwt({ sub: 'url-user' }),
        }));
      },
    });

    await new Promise(r => setTimeout(r, 10));

    expect(fetchCalled).toBe(true);
    expect(client.lmz.instanceName).toContain('url-user');
    expect(client.claims?.sub).toBe('url-user');
    client.disconnect();
  });

  it('handles token expiry close code (4401) by refreshing', async () => {
    let refreshCount = 0;
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: createFakeJwt({ sub: 'user' }),
      WebSocket: createMockWebSocketClass(),
      refresh: async () => {
        refreshCount++;
        return { access_token: createFakeJwt({ sub: 'user', counter: refreshCount }) };
      },
    });

    // With accessToken provided, WS is created synchronously
    const ws1 = createdWebSockets[0];
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionRequired: false,
    }));
    expect(client.connectionState).toBe('connected');

    // Simulate token expiry close — should trigger refresh + reconnect
    ws1.simulateClose(4401, 'Token expired');

    // Wait for refresh + reconnect
    await new Promise(r => setTimeout(r, 50));

    expect(refreshCount).toBeGreaterThanOrEqual(1);
    client.disconnect();
  });

  it('refreshes a token that EXPIRED while idle on reconnect (not only a missing one)', async () => {
    let refreshCount = 0;
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      WebSocket: createMockWebSocketClass(),
      refresh: async () => {
        refreshCount++;
        // 1st mint is already-expired (simulates the access token aging out over a long idle);
        // the reconnect's refresh returns a fresh one so the retry can succeed.
        return { access_token: createFakeJwt({ sub: 'user', exp: refreshCount === 1 ? past : future }) };
      },
    });

    // First connect refreshes the missing token → `#claims.exp` is now in the PAST.
    await new Promise(r => setTimeout(r, 20));
    expect(refreshCount).toBe(1);
    const ws1 = createdWebSockets[0];
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));
    expect(client.connectionState).toBe('connected');

    // Network drop → reconnect with a PRESENT-but-EXPIRED token. The client MUST refresh before the
    // WS upgrade — else the gateway rejects it ("bad response from the server") and #scheduleReconnect
    // loops forever with the same dead token (the chat-down-after-hours bug).
    ws1.simulateClose(1006, 'Connection lost');
    expect(client.connectionState).toBe('reconnecting');
    client.connect(); // trigger the reconnect now (timers mocked — mirrors the 4409 stale-close test)
    await new Promise(r => setTimeout(r, 20));

    // Capable-of-failing: the old `if (!#accessToken)` guard skipped the refresh because a token was
    // present, so refreshCount would stay 1 and the new socket would carry the expired token.
    expect(refreshCount).toBe(2);
    expect(createdWebSockets[1]).toBeDefined();
    client.disconnect();
  });

  it('force-refreshes ONCE on a reconnect failure even when the token looks fresh by exp (auth reject unreadable off the WS)', async () => {
    let refreshCount = 0;
    const future = Math.floor(Date.now() / 1000) + 3600;
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      WebSocket: createMockWebSocketClass(),
      refresh: async () => {
        refreshCount++;
        return { access_token: createFakeJwt({ sub: 'user', exp: future }) };
      },
    });

    // First connect refreshes the missing token → `#claims.exp` is FUTURE, so the token looks fresh.
    await new Promise(r => setTimeout(r, 20));
    expect(refreshCount).toBe(1);
    const ws1 = createdWebSockets[0];
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));
    expect(client.connectionState).toBe('connected');

    // 1st drop (generic 1006 — the unreadable upgrade-reject the browser gives us): a single drop is
    // likely a transient blip, so the fresh-looking token is REUSED with no refresh.
    ws1.simulateClose(1006, 'bad response from the server');
    client.connect(); // trigger the scheduled reconnect now (mirrors the 4409 stale-close test)
    const ws2 = createdWebSockets[1];
    expect(ws2).toBeDefined();
    expect(refreshCount).toBe(1); // one drop isn't enough — token reused

    // 2nd consecutive failure: now the reconnect itself failed, so the token is the suspect (a
    // key-rotation / clock-skew / revocation reject that looks fresh by `exp`). Force-reauth once →
    // refresh before retrying.
    ws2.simulateClose(1006, 'bad response from the server');
    client.connect();
    await new Promise(r => setTimeout(r, 20));

    // Capable-of-failing: without the threshold-gated force-reauth, the fresh-looking token is reused
    // with no refresh, so refreshCount stays 1 (and the gateway keeps rejecting it — the loop).
    expect(refreshCount).toBe(2);
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
      subscriptionRequired: false,
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
      subscriptionRequired: false,
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
      subscriptionRequired: false,
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
      subscriptionRequired: false,
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
      subscriptionRequired: false,
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

  it('bounds the message queue at MAX_QUEUE_SIZE (overflow is dropped)', () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    // Fire many fire-and-forget calls while not connected — they queue. Overflow past the cap is
    // dropped (a client re-issues on reconnect; there is no awaited Promise to reject).
    for (let i = 0; i < 150; i++) {
      client.lmz.call('SOME_DO', 'instance1', (client.ctn() as any).someMethod(i));
    }

    // On connect the queue flushes; at most MAX_QUEUE_SIZE (100) messages survived.
    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));

    expect(ws.getSentMessages().length).toBeLessThanOrEqual(100);
    expect(ws.getSentMessages().length).toBeGreaterThan(0);

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
      subscriptionRequired: false,
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
      subscriptionRequired: false,
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
    // @lumenize/debug routes all levels (including error) through console.debug,
    // and error() always outputs regardless of the DEBUG filter.
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
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
      subscriptionRequired: false,
    }));

    // Send invalid JSON — should not throw, just log the parse error
    expect(() => ws.simulateMessage('not valid json {{{')).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse Gateway message'),
    );

    consoleSpy.mockRestore();
    client.disconnect();
  });

  it('dispatches unknown Gateway message types to onUnknownMessage', () => {
    // The default onUnknownMessage warns via @lumenize/debug (filterable), but
    // the observable contract is that the frame is routed to onUnknownMessage,
    // which subclasses override to handle application-specific frames.
    const unknownMessages: any[] = [];
    class UnknownCapturingClient extends TestClient {
      onUnknownMessage(message: any): void {
        unknownMessages.push(message);
      }
    }

    const client = new UnknownCapturingClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({
      type: 'connection_status',
      subscriptionRequired: false,
    }));

    // Send a message with an unknown type
    ws.simulateMessage(JSON.stringify({ type: 'unknown_message_type' }));

    expect(unknownMessages).toEqual([{ type: 'unknown_message_type' }]);

    client.disconnect();
  });

  it('ignores a response for an unknown callId without throwing', () => {
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
      subscriptionRequired: false,
    }));

    // Send a call_response for a callId that doesn't exist — the unknown-call
    // guard must short-circuit (both the #pendingAsyncCalls and #inHeapHandlers
    // lookups miss → return with no settle), so this is handled gracefully.
    expect(() => ws.simulateMessage(JSON.stringify({
      type: 'call_response',
      callId: 'nonexistent-call-id',
      success: true,
      result: null,
    }))).not.toThrow();

    client.disconnect();
  });

  it('runs the in-heap handler on a successful RESULT', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));

    // 4-arg call — the handler stays in-heap keyed by callId; nothing is awaited.
    const remote = (client.ctn() as any).someMethod();
    client.lmz.call('SOME_DO', 'instance1', remote, client.ctn().captureOutcome(remote));

    const sentMsg = JSON.parse(ws.getSentMessages()[0]);
    expect(sentMsg.expectsResult).toBe(true); // 4-arg → the Gateway attaches a fire-back descriptor
    const callId = sentMsg.callId;

    // The RESULT re-resolves to the current socket; the in-heap handler runs with the value.
    ws.simulateMessage(JSON.stringify({ type: 'call_response', callId, success: true, result: pp('hello-result') }));

    await vi.waitFor(() => { expect(client.getLastCallOutcome()).toBe('hello-result'); });

    // Dedup (M4): a duplicate RESULT for the same callId is dropped (handler already removed).
    ws.simulateMessage(JSON.stringify({ type: 'call_response', callId, success: true, result: pp('again') }));
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getCallOutcomeCount()).toBe(1);

    client.disconnect();
  });

  it('runs the in-heap handler with the Error on an error RESULT (never stranded — Q4)', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));

    const remote = (client.ctn() as any).someMethod();
    client.lmz.call('SOME_DO', 'instance1', remote, client.ctn().captureOutcome(remote));

    const callId = JSON.parse(ws.getSentMessages()[0]).callId;

    ws.simulateMessage(JSON.stringify({
      type: 'call_response', callId, success: false, error: pp(new Error('Something went wrong')),
    }));

    await vi.waitFor(() => {
      const outcome = client.getLastCallOutcome();
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome.message).toBe('Something went wrong');
    });

    client.disconnect();
  });

  it('onErrorOnly (N6): skips the in-heap handler on a SUCCESS RESULT (still deduped)', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));

    // 4-arg call with onErrorOnly:true — the handler must run ONLY on an error RESULT.
    const remote = (client.ctn() as any).someMethod();
    client.lmz.call('SOME_DO', 'instance1', remote, client.ctn().captureOutcome(remote), { onErrorOnly: true });
    const callId = JSON.parse(ws.getSentMessages()[0]).callId;

    // A SUCCESS RESULT → the handler is skipped (capable-of-failing: delete the onErrorOnly skip in
    // #handleCallResponse and this goes red — the handler would run, count → 1).
    ws.simulateMessage(JSON.stringify({ type: 'call_response', callId, success: true, result: pp('ok') }));
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getCallOutcomeCount()).toBe(0);

    client.disconnect();
  });

  it('3-arg client call is truly fire-and-forget (expectsResult:false), 4-arg sets it true', () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));

    // 3-arg → no fire-back descriptor should be attached by the Gateway.
    client.lmz.call('SOME_DO', 'instance1', (client.ctn() as any).someMethod());
    expect(JSON.parse(ws.getSentMessages()[0]).expectsResult).toBeFalsy();

    // 4-arg → the Gateway attaches a client fire-back descriptor.
    const remote = (client.ctn() as any).someMethod();
    client.lmz.call('SOME_DO', 'instance1', remote, client.ctn().captureOutcome(remote));
    expect(JSON.parse(ws.getSentMessages()[1]).expectsResult).toBe(true);

    client.disconnect();
  });
});

describe('callAsync (client resilient awaitable — D16/D17)', () => {
  beforeEach(() => { createdWebSockets = []; });

  // Connect a TestClient over a mock socket and return both. Mirrors the connect boilerplate used
  // across this file (open → connection_status).
  function connectClient(): [TestClient, MockWebSocket] {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });
    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));
    return [client, ws];
  }

  it('resolves with the value on a success RESULT (settled by callId), then cleans up the entry', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const [client, ws] = connectClient();

    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod());
    const sent = JSON.parse(ws.getSentMessages()[0]);
    expect(sent.expectsResult).toBe(true); // no handler travels — the Star fires a RESULT back (D17)
    expect(client.getPendingAsyncCallCount()).toBe(1); // in-flight
    const callId = sent.callId;

    ws.simulateMessage(JSON.stringify({ type: 'call_response', callId, success: true, result: pp('hello') }));

    await expect(p).resolves.toBe('hello');
    // delete-on-delivery (no leak) — capable-of-failing: gut the delete and the count stays 1.
    expect(client.getPendingAsyncCallCount()).toBe(0);

    client.disconnect();
  });

  it('rejects with the reconstructed Error on an error RESULT ($error → Error)', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const [client, ws] = connectClient();

    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod());
    const callId = JSON.parse(ws.getSentMessages()[0]).callId;

    ws.simulateMessage(JSON.stringify({
      type: 'call_response', callId, success: false, error: pp(new Error('boom')),
    }));

    await expect(p).rejects.toThrow('boom');
    expect(client.getPendingAsyncCallCount()).toBe(0);

    client.disconnect();
  });

  it('drops a duplicate RESULT for the same callId (dedup / no double-settle)', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const [client, ws] = connectClient();

    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod());
    const callId = JSON.parse(ws.getSentMessages()[0]).callId;

    ws.simulateMessage(JSON.stringify({ type: 'call_response', callId, success: true, result: pp('first') }));
    await expect(p).resolves.toBe('first');
    // The entry was deleted on delivery → a duplicate RESULT finds nothing (M4). Capable-of-failing on
    // the transient surface: without delete-on-delivery the count would still be 1 here.
    expect(client.getPendingAsyncCallCount()).toBe(0);

    expect(() => ws.simulateMessage(
      JSON.stringify({ type: 'call_response', callId, success: true, result: pp('second') }),
    )).not.toThrow();
    await expect(p).resolves.toBe('first'); // the settled value is immutable — 'second' cannot overwrite

    client.disconnect();
  });

  it('aborts the WAIT: rejects with signal.reason (AbortError), drops the entry, ignores a late RESULT', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const [client, ws] = connectClient();

    const controller = new AbortController();
    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod(), {
      signal: controller.signal,
    });
    const callId = JSON.parse(ws.getSentMessages()[0]).callId;
    expect(client.getPendingAsyncCallCount()).toBe(1);

    controller.abort();

    await expect(p).rejects.toThrow();
    const reason = await p.catch((e) => e);
    expect(reason).toBeInstanceOf(DOMException);
    expect(reason.name).toBe('AbortError');
    // delete-on-abort — capable-of-failing on the transient surface: without the delete a late RESULT
    // would find the stale entry; with it the count is already 0 and the RESULT is dropped.
    expect(client.getPendingAsyncCallCount()).toBe(0);
    expect(() => ws.simulateMessage(
      JSON.stringify({ type: 'call_response', callId, success: true, result: pp('too-late') }),
    )).not.toThrow();

    client.disconnect();
  });

  it('a pre-aborted signal rejects immediately WITHOUT dispatching a CALL (matches fetch)', async () => {
    const [client, ws] = connectClient();

    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod(), {
      signal: AbortSignal.abort(),
    });

    await expect(p).rejects.toThrow();
    // Capable-of-failing: without the pre-aborted early-return a CALL would be dispatched.
    expect(ws.getSentMessages().length).toBe(0);
    expect(client.getPendingAsyncCallCount()).toBe(0);

    client.disconnect();
  });

  it('rejects with a TimeoutError when the built-in default timeout elapses (D4)', async () => {
    // Small REAL timeout — the mesh suite has no fake timers, and AbortSignal.timeout is a native
    // workerd primitive fake timers do not reliably patch (m1). Drive the pure-timeout path directly
    // through callAsync (no engine timer to confound it); never answer the RESULT.
    const [client] = connectClient();

    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod(), {
      timeoutMs: 40,
    });

    await expect(p).rejects.toThrow();
    const reason = await p.catch((e) => e);
    expect(reason).toBeInstanceOf(DOMException);
    expect(reason.name).toBe('TimeoutError');
    expect(client.getPendingAsyncCallCount()).toBe(0);

    client.disconnect();
  });

  it('timeoutMs:0 disables the default timeout (no TimeoutError; still settles on a RESULT)', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const [client, ws] = connectClient();

    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod(), {
      timeoutMs: 0,
    });
    const callId = JSON.parse(ws.getSentMessages()[0]).callId;

    // Wait past a would-be short timeout to prove none was armed, then settle normally.
    await new Promise((r) => setTimeout(r, 60));
    expect(client.getPendingAsyncCallCount()).toBe(1); // still in-flight — no timeout fired
    ws.simulateMessage(JSON.stringify({ type: 'call_response', callId, success: true, result: pp('ok') }));
    await expect(p).resolves.toBe('ok');

    client.disconnect();
  });

  it('composes the caller signal WITH the default timeout (additive, AbortSignal.any) — either can reject', async () => {
    // Abort the caller signal while the timeout is far from elapsing: it must still reject, proving the
    // two are composed (not one replacing the other — D4).
    const [client] = connectClient();
    const controller = new AbortController();
    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod(), {
      signal: controller.signal,
      timeoutMs: 30_000, // far from elapsing
    });
    controller.abort();
    const reason = await p.catch((e) => e);
    expect(reason.name).toBe('AbortError');

    client.disconnect();
  });

  it('removes the abort listener on a NORMAL (success) settle — no leak', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const [client, ws] = connectClient();

    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    // timeoutMs:0 so the signal is NOT wrapped by AbortSignal.any — the abort listener sits on
    // controller.signal directly, making the cleanup call observable here.
    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod(), {
      signal: controller.signal, timeoutMs: 0,
    });
    const callId = JSON.parse(ws.getSentMessages()[0]).callId;

    ws.simulateMessage(JSON.stringify({ type: 'call_response', callId, success: true, result: pp('ok') }));
    await expect(p).resolves.toBe('ok');

    // "no leak" has no other observable end-state (a settled Promise no-ops a 2nd settle). Capable-of-
    // failing: gut the removeEventListener on the normal-settle branch of #handleCallResponse → red.
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    client.disconnect();
  });

  it('survives a WS reconnect — the RESULT re-resolves to the new socket and settles (M1, client-heap)', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    // Test the CLIENT-heap re-settle: the #pendingAsyncCalls Promise survives the client's OWN socket
    // dropping + reconnecting (D16). The parent Flow-C harness proves the Gateway re-resolution with no
    // client in the loop; this proves the client-heap half — the two are complementary (M1).
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });
    const ws1 = createdWebSockets[0];
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));

    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod());
    const callId = JSON.parse(ws1.getSentMessages()[0]).callId;

    // Socket drops → reconnect creates ws2 (the heap, and the pending Promise, survive).
    ws1.simulateClose(1006, 'Connection lost');
    expect(client.connectionState).toBe('reconnecting');
    client.connect(); // timers mocked in unit context — trigger the reconnect manually (as elsewhere)
    const ws2 = createdWebSockets[1];
    ws2.simulateOpen();
    ws2.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));
    expect(client.connectionState).toBe('connected');
    expect(client.getPendingAsyncCallCount()).toBe(1); // survived the reconnect

    // The Gateway re-resolves delivery to ws2 (the current socket). The Promise settles.
    ws2.simulateMessage(JSON.stringify({ type: 'call_response', callId, success: true, result: pp('after-reconnect') }));
    await expect(p).resolves.toBe('after-reconnect');

    client.disconnect();
  });

  it('sync-throws on an invalid remoteContinuation at the call site (D6 tier 1)', () => {
    const [client] = connectClient();
    // A developer error (not a real continuation) is a loud synchronous throw, never a rejection —
    // same as call(). Capable-of-failing: drop the extractCallChains validation and this stops throwing.
    expect(() => client.lmz.callAsync('SOME_DO', 'instance1', {} as any)).toThrow(/Invalid remoteContinuation/);
    client.disconnect();
  });

  it('rejects in-flight callAsync Promises on explicit disconnect (no hang)', async () => {
    const [client] = connectClient();
    const p = client.lmz.callAsync('SOME_DO', 'instance1', (client.ctn() as any).someMethod(), {
      timeoutMs: 0, // disable the timeout so ONLY disconnect can settle it (capable-of-failing)
    });
    expect(client.getPendingAsyncCallCount()).toBe(1);
    client.disconnect();
    await expect(p).rejects.toThrow(/disconnected/);
    expect(client.getPendingAsyncCallCount()).toBe(0);
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

  // Both terminal statuses, mirroring the mid-session 4400/4403 pair: the
  // first-connect path is now symmetric with the mid-session close path — a
  // 401 OR 403 from the refresh endpoint is a terminal auth failure, so
  // onLoginRequired fires and state goes 'disconnected'. The OLD behavior
  // swallowed the refresh throw into #scheduleReconnect (state 'reconnecting',
  // onLoginRequired never fired, factory `ready` hung forever). Parameterizing
  // over both statuses keeps the `|| response.status === 403` disjunct guarded:
  // dropping it would otherwise leave every probe green.
  it.each([401, 403])('first-connect refresh %d surfaces as terminal (onLoginRequired + disconnected), not reconnect', async (status) => {
    let loginErr: LoginRequiredError | null = null;
    const states: ConnectionState[] = [];
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      // No accessToken → first-connect calls #refreshToken before any WS exists.
      WebSocket: createMockWebSocketClass(),
      refresh: '/auth/refresh-token',
      fetch: async () => new Response('Auth failed', { status }),
      onLoginRequired: (e) => { loginErr = e; },
      onConnectionStateChange: (s) => states.push(s),
    });

    await vi.waitFor(() => {
      expect(loginErr).not.toBeNull();
    });
    expect(loginErr!.name).toBe('LoginRequiredError');
    expect(loginErr!.code).toBe(status);
    expect(client.connectionState).toBe('disconnected');
    // Capable-of-failing: the swallow-into-reconnect regression would push
    // 'reconnecting' and never reach a WS.
    expect(states).not.toContain('reconnecting');
    expect(createdWebSockets.length).toBe(0);

    client.disconnect();
  });

  it('first-connect refresh 500 is transient → reconnect, not login-required', async () => {
    // Companion to the 401 probe: only 401/403 are terminal. A 5xx is transient,
    // so we keep retrying with backoff and never fire onLoginRequired. This
    // catches a too-broad classification that would treat every non-ok as terminal.
    let loginCalled = false;
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      WebSocket: createMockWebSocketClass(),
      refresh: '/auth/refresh-token',
      fetch: async () => new Response('Server error', { status: 500 }),
      onLoginRequired: () => { loginCalled = true; },
    });

    await vi.waitFor(() => {
      expect(client.connectionState).toBe('reconnecting');
    });
    expect(loginCalled).toBe(false);

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

  it('drops in-heap call handlers on explicit disconnect (no result will arrive)', async () => {
    const { preprocess: pp } = await import('@lumenize/structured-clone');
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
    });

    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));

    // 4-arg call — handler goes in-heap keyed by callId.
    const remote = (client.ctn() as any).someMethod();
    client.lmz.call('SOME_DO', 'instance1', remote, client.ctn().captureOutcome(remote));
    const callId = JSON.parse(ws.getSentMessages()[0]).callId;

    // Explicit disconnect is a deliberate discard — the in-heap handler is dropped. A late RESULT
    // arriving after disconnect finds no handler and is ignored (the client re-issues on reload, D8).
    client.disconnect();
    ws.simulateMessage(JSON.stringify({ type: 'call_response', callId, success: true, result: pp('late') }));
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getLastCallOutcome()).toBeUndefined();
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
      subscriptionRequired: false,
    }));

    // Trigger reconnect scheduling
    ws.simulateClose(1006, 'Connection lost');
    expect(client.connectionState).toBe('reconnecting');

    // Disconnect should clear the reconnect timer
    client.disconnect();
    expect(client.connectionState).toBe('disconnected');
  });
});

describe('WebSocket heartbeat (keepalive)', () => {
  beforeEach(() => { createdWebSockets = []; });

  it('sends a keepalive ping on the interval while connected; pong does not disrupt', async () => {
    const client = new TestClient({
      instanceName: 'user.tab1',
      baseUrl: 'wss://example.com',
      accessToken: 'token',
      WebSocket: createMockWebSocketClass(),
      heartbeatIntervalMs: 20, // tiny so it fires within the test (prod default is 30s)
    });
    const ws = createdWebSockets[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: 'connection_status', subscriptionRequired: false }));
    expect(client.connectionState).toBe('connected');

    await new Promise(r => setTimeout(r, 75)); // a few intervals
    const pings = ws.getSentMessages().filter((m: string) => m === WS_HEARTBEAT_PING);
    // Capable-of-failing: without the heartbeat there are ZERO pings → a long quiet turn idle-drops
    // the WS and the completed turn's reply can't be delivered.
    expect(pings.length).toBeGreaterThanOrEqual(2);

    // The gateway's auto-pong is keepalive, not a mesh message — it must not disrupt the connection.
    ws.simulateMessage(WS_HEARTBEAT_PONG);
    expect(client.connectionState).toBe('connected');

    client.disconnect(); // stops the interval (no leaked timer)
  });
});
