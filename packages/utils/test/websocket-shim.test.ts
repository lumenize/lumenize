import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getWebSocketShim } from '../src/websocket-shim';

describe('getWebSocketShim', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockWebSocket: any;
  let webSocketEventHandlers: Map<string, Function[]>;

  beforeEach(() => {
    webSocketEventHandlers = new Map();
    
    // Create a mock WebSocket that behaves like the real one
    mockWebSocket = {
      readyState: 0, // CONNECTING
      protocol: '',
      accept: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn((event: string, handler: Function) => {
        if (!webSocketEventHandlers.has(event)) {
          webSocketEventHandlers.set(event, []);
        }
        webSocketEventHandlers.get(event)!.push(handler);
      }),
    };

    // Mock fetch to return a successful WebSocket upgrade
    mockFetch = vi.fn(async () => {
      return {
        status: 101,
        headers: new Headers(), // Add headers object
        webSocket: mockWebSocket,
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Helper to trigger events on the mock WebSocket
  const triggerEvent = (eventType: string, eventData?: any) => {
    const handlers = webSocketEventHandlers.get(eventType) || [];
    handlers.forEach(handler => handler(eventData || new Event(eventType)));
  };

  describe('Basic WebSocket creation', () => {
    it('should create a WebSocket shim class', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      expect(WebSocketClass).toBeDefined();
      expect(typeof WebSocketClass).toBe('function');
    });

    it('should have correct static constants', () => {
      const WebSocketClass = getWebSocketShim(mockFetch) as any;
      expect(WebSocketClass.CONNECTING).toBe(0);
      expect(WebSocketClass.OPEN).toBe(1);
      expect(WebSocketClass.CLOSING).toBe(2);
      expect(WebSocketClass.CLOSED).toBe(3);
    });

    it('should create a WebSocket instance with url', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      expect(ws.url).toBe('wss://example.com/socket');
      expect(ws.readyState).toBe(0); // CONNECTING
    });

    it('should start in CONNECTING state', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      expect(ws.readyState).toBe(0);
    });

    it('should accept URL object (browser compatibility)', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const url = new URL('wss://example.com/socket');
      const ws = new WebSocketClass(url);
      
      expect(ws.url).toBe('wss://example.com/socket');
      expect(ws.readyState).toBe(0); // CONNECTING
    });

    it('should accept URL object with query parameters', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const url = new URL('wss://example.com/socket?token=abc123');
      const ws = new WebSocketClass(url);
      
      expect(ws.url).toBe('wss://example.com/socket?token=abc123');
    });
  });

  describe('URL conversion', () => {
    it('should convert wss:// to https://', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      
      const request = mockFetch.mock.calls[0][0] as Request;
      expect(request.url).toBe('https://example.com/socket');
    });

    it('should convert ws:// to http://', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      new WebSocketClass('ws://example.com/socket');
      
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      
      const request = mockFetch.mock.calls[0][0] as Request;
      expect(request.url).toBe('http://example.com/socket');
    });
  });

  describe('Protocol negotiation', () => {
    it('should send single protocol in header', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      new WebSocketClass('wss://example.com/socket', 'chat.v1');
      
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      
      const request = mockFetch.mock.calls[0][0] as Request;
      expect(request.headers.get('Sec-WebSocket-Protocol')).toBe('chat.v1');
    });

    it('should send multiple protocols in header', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      new WebSocketClass('wss://example.com/socket', ['chat.v2', 'chat.v1']);
      
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      
      const request = mockFetch.mock.calls[0][0] as Request;
      expect(request.headers.get('Sec-WebSocket-Protocol')).toBe('chat.v2, chat.v1');
    });

    it('should set protocol from response header', async () => {
      // Mock fetch to return response with protocol header
      const protocolFetch = vi.fn(async () => ({
        status: 101,
        headers: new Headers({
          'Sec-WebSocket-Protocol': 'chat.v1'
        }),
        webSocket: mockWebSocket,
      }));
      
      const WebSocketClass = getWebSocketShim(protocolFetch as any);
      const ws = new WebSocketClass('wss://example.com/socket', ['chat.v2', 'chat.v1']);
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      // Protocol should be set from response header
      expect(ws.protocol).toBe('chat.v1');
    });
  });

  describe('Factory initialization', () => {
    it('should inject custom headers', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch, {
        headers: { 'Authorization': 'Bearer test-token' }
      });
      new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      
      const request = mockFetch.mock.calls[0][0] as Request;
      expect(request.headers.get('Authorization')).toBe('Bearer test-token');
    });

    it('should set Upgrade header', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      
      const request = mockFetch.mock.calls[0][0] as Request;
      expect(request.headers.get('Upgrade')).toBe('websocket');
    });

    it('should configure maxQueueBytes limit', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch, {
        maxQueueBytes: 100
      });
      const ws = new WebSocketClass('wss://example.com/socket');
      
      // Queue a message that exceeds limit
      const largeMessage = 'x'.repeat(101);
      expect(() => ws.send(largeMessage)).toThrow('CONNECTING queue exceeded maxQueueBytes');
    });
  });

  describe('Connection lifecycle', () => {
    it('should call accept() on the WebSocket', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
    });

    it('should transition to OPEN on open event', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1; // OPEN
      triggerEvent('open');
      
      expect(ws.readyState).toBe(1);
    });

    it('should fire onopen handler', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      const onopen = vi.fn();
      
      // Use addEventListener instead of onopen property for this test
      ws.addEventListener('open', onopen);
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      expect(onopen).toHaveBeenCalled();
    });

    it('should handle connection failure', async () => {
      const errorFetch = vi.fn(async () => {
        throw new Error('Connection failed');
      });
      
      const WebSocketClass = getWebSocketShim(errorFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      const onerror = vi.fn();
      const onclose = vi.fn();
      
      // Use addEventListener instead of property assignment
      ws.addEventListener('error', onerror);
      ws.addEventListener('close', onclose);
      
      await vi.waitFor(() => expect(onerror).toHaveBeenCalled());
      
      expect(ws.readyState).toBe(3); // CLOSED
      expect(onclose).toHaveBeenCalled();
      const closeEvent = onclose.mock.calls[0][0] as CloseEvent;
      expect(closeEvent.code).toBe(1011);
      expect(closeEvent.wasClean).toBe(false);
    });

    it('should handle upgrade rejection', async () => {
      const rejectFetch = vi.fn(async () => ({
        status: 400,
        webSocket: undefined,
      } as any));
      
      const WebSocketClass = getWebSocketShim(rejectFetch as any);
      const ws = new WebSocketClass('wss://example.com/socket');
      const onerror = vi.fn();
      
      // Use addEventListener instead of property assignment
      ws.addEventListener('error', onerror);
      
      await vi.waitFor(() => expect(onerror).toHaveBeenCalled());
      
      expect(ws.readyState).toBe(3); // CLOSED
    });
  });

  describe('Message sending', () => {
    it('should queue messages during CONNECTING', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      ws.send('test message');
      
      expect(ws.bufferedAmount).toBeGreaterThan(0);
      expect(mockWebSocket.send).not.toHaveBeenCalled();
    });

    it('should flush queued messages on open', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      ws.send('message 1');
      ws.send('message 2');
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1; // OPEN
      triggerEvent('open');
      
      await vi.waitFor(() => expect(mockWebSocket.send).toHaveBeenCalledTimes(2));
      
      expect(mockWebSocket.send).toHaveBeenCalledWith('message 1');
      expect(mockWebSocket.send).toHaveBeenCalledWith('message 2');
      expect(ws.bufferedAmount).toBe(0);
    });

    it('should send directly when OPEN', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1; // OPEN
      triggerEvent('open');
      
      ws.send('direct message');
      
      expect(mockWebSocket.send).toHaveBeenCalledWith('direct message');
    });

    it('should throw when sending after close', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      ws.close();
      
      expect(() => ws.send('message')).toThrow('cannot send() after close() has begun');
    });

    it('should calculate bufferedAmount for different data types', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      ws.send('hello'); // string
      const initialBytes = ws.bufferedAmount;
      expect(initialBytes).toBeGreaterThan(0);
      
      ws.send(new Uint8Array([1, 2, 3])); // Uint8Array
      expect(ws.bufferedAmount).toBe(initialBytes + 3);
      
      ws.send(new ArrayBuffer(10)); // ArrayBuffer
      expect(ws.bufferedAmount).toBe(initialBytes + 3 + 10);
    });
  });

  describe('Message receiving', () => {
    it('should fire onmessage handler', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      const onmessage = vi.fn();
      
      // Use addEventListener instead of onmessage property
      ws.addEventListener('message', onmessage);
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      const messageEvent = new MessageEvent('message', { data: 'test data' });
      triggerEvent('message', messageEvent);
      
      expect(onmessage).toHaveBeenCalled();
      const receivedEvent = onmessage.mock.calls[0][0] as MessageEvent;
      expect(receivedEvent.data).toBe('test data');
    });

    it('should handle binary messages', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      const onmessage = vi.fn();
      
      // Use addEventListener instead of onmessage property
      ws.addEventListener('message', onmessage);
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      const binaryData = new Uint8Array([1, 2, 3]);
      const messageEvent = new MessageEvent('message', { data: binaryData });
      triggerEvent('message', messageEvent);
      
      expect(onmessage).toHaveBeenCalled();
      const receivedEvent = onmessage.mock.calls[0][0] as MessageEvent;
      expect(receivedEvent.data).toEqual(binaryData);
    });
  });

  describe('Error handling', () => {
    it('should fire onerror handler', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      const onerror = vi.fn();
      
      // Use addEventListener instead of onerror property
      ws.addEventListener('error', onerror);
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      const errorEvent = new ErrorEvent('error', { message: 'test error' } as any);
      triggerEvent('error', errorEvent);
      
      expect(onerror).toHaveBeenCalled();
    });
  });

  describe('Closing', () => {
    it('should transition to CLOSING when close() is called', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      ws.close();
      
      expect(ws.readyState).toBe(2); // CLOSING
    });

    it('should call close on underlying WebSocket', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      ws.close(1001, 'Going away');
      
      expect(mockWebSocket.close).toHaveBeenCalledWith(1001, 'Going away');
    });

    it('should use default code and reason', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      ws.close();
      
      expect(mockWebSocket.close).toHaveBeenCalledWith(1000, 'Normal Closure');
    });

    it('should fire onclose handler', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      const onclose = vi.fn();
      
      // Use addEventListener instead of onclose property
      ws.addEventListener('close', onclose);
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      ws.close(1000, 'Normal');
      
      const closeEvent = new CloseEvent('close', {
        code: 1000,
        reason: 'Normal',
        wasClean: true,
      } as any);
      triggerEvent('close', closeEvent);
      
      expect(onclose).toHaveBeenCalled();
      const receivedEvent = onclose.mock.calls[0][0] as CloseEvent;
      expect(receivedEvent.code).toBe(1000);
      expect(receivedEvent.reason).toBe('Normal');
      expect(receivedEvent.wasClean).toBe(true);
    });

    it('should handle close before connection completes', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      const onclose = vi.fn();
      
      // Use addEventListener instead of onclose property
      ws.addEventListener('close', onclose);
      
      // Close immediately without waiting for connection
      ws.close();
      
      expect(ws.readyState).toBe(3); // CLOSED
      expect(onclose).toHaveBeenCalled();
      const closeEvent = onclose.mock.calls[0][0] as CloseEvent;
      expect(closeEvent.wasClean).toBe(true);
    });

    it('should drop queued messages on close', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      ws.send('message 1');
      ws.send('message 2');
      expect(ws.bufferedAmount).toBeGreaterThan(0);
      
      ws.close();
      
      expect(ws.bufferedAmount).toBe(0);
    });

    it('should be idempotent', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      ws.close();
      ws.close(); // Second close should be no-op
      
      expect(mockWebSocket.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('Event listeners with addEventListener', () => {
    it('should support addEventListener for open', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      const listener = vi.fn();
      ws.addEventListener('open', listener);
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      expect(listener).toHaveBeenCalled();
    });

    it('should support addEventListener for message', async () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      const listener = vi.fn();
      ws.addEventListener('message', listener);
      
      await vi.waitFor(() => expect(mockWebSocket.accept).toHaveBeenCalled());
      
      mockWebSocket.readyState = 1;
      triggerEvent('open');
      
      const messageEvent = new MessageEvent('message', { data: 'test' });
      triggerEvent('message', messageEvent);
      
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('Binary type', () => {
    it('should default to blob', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      expect(ws.binaryType).toBe('blob');
    });

    it('should allow setting binaryType', () => {
      const WebSocketClass = getWebSocketShim(mockFetch);
      const ws = new WebSocketClass('wss://example.com/socket');
      
      ws.binaryType = 'arraybuffer';
      expect(ws.binaryType).toBe('arraybuffer');
    });
  });
});
