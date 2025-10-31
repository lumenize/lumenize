/**
 * Transport Factory Configuration Tests
 * 
 * Tests that transport factories handle various configuration options correctly.
 * These tests cover the default value branches in transport-factories.ts.
 */

import { describe, it, expect } from 'vitest';
import { createHttpTransport, createWebSocketTransport } from '../src/index';

describe('Transport Factories', () => {
  describe('createHttpTransport', () => {
    it('should create transport with default config', () => {
      const transport = createHttpTransport('TEST_DO', 'instance-1');
      expect(transport).toBeDefined();
      expect(transport.setKeepAlive).toBeDefined();
    });

    it('should create transport with explicit baseUrl', () => {
      const transport = createHttpTransport('TEST_DO', 'instance-1', {
        baseUrl: 'https://custom.example.com'
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with explicit prefix', () => {
      const transport = createHttpTransport('TEST_DO', 'instance-1', {
        prefix: '/custom-rpc'
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with explicit timeout', () => {
      const transport = createHttpTransport('TEST_DO', 'instance-1', {
        timeout: 60000
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with custom fetch', () => {
      const customFetch = async () => new Response('{}');
      const transport = createHttpTransport('TEST_DO', 'instance-1', {
        fetch: customFetch
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with custom headers', () => {
      const transport = createHttpTransport('TEST_DO', 'instance-1', {
        headers: { 'X-Custom': 'value' }
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with all options', () => {
      const customFetch = async () => new Response('{}');
      const transport = createHttpTransport('TEST_DO', 'instance-1', {
        baseUrl: 'https://custom.example.com',
        prefix: '/custom-rpc',
        timeout: 60000,
        fetch: customFetch,
        headers: { 'X-Custom': 'value' }
      });
      expect(transport).toBeDefined();
    });
  });

  describe('createWebSocketTransport', () => {
    // Mock WebSocket class for tests
    class MockWebSocket {
      url: string;
      readyState = 0; // CONNECTING
      onopen: any = null;
      onclose: any = null;
      onerror: any = null;
      onmessage: any = null;

      constructor(url: string) {
        this.url = url;
      }

      send() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    }

    it('should create transport with default config', () => {
      const transport = createWebSocketTransport('TEST_DO', 'instance-1', {
        WebSocketClass: MockWebSocket as any
      });
      expect(transport).toBeDefined();
      expect(transport.setKeepAlive).toBeDefined();
      expect(transport.setDownstreamHandler).toBeDefined();
    });

    it('should create transport with explicit baseUrl', () => {
      const transport = createWebSocketTransport('TEST_DO', 'instance-1', {
        baseUrl: 'https://custom.example.com',
        WebSocketClass: MockWebSocket as any
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with explicit prefix', () => {
      const transport = createWebSocketTransport('TEST_DO', 'instance-1', {
        prefix: '/custom-rpc',
        WebSocketClass: MockWebSocket as any
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with explicit timeout', () => {
      const transport = createWebSocketTransport('TEST_DO', 'instance-1', {
        timeout: 60000,
        WebSocketClass: MockWebSocket as any
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with clientId', () => {
      const transport = createWebSocketTransport('TEST_DO', 'instance-1', {
        clientId: 'client-123',
        WebSocketClass: MockWebSocket as any
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with additionalProtocols', () => {
      const transport = createWebSocketTransport('TEST_DO', 'instance-1', {
        additionalProtocols: ['protocol1', 'protocol2'],
        WebSocketClass: MockWebSocket as any
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with onDownstream handler', () => {
      const transport = createWebSocketTransport('TEST_DO', 'instance-1', {
        onDownstream: () => {},
        WebSocketClass: MockWebSocket as any
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with onClose handler', () => {
      const transport = createWebSocketTransport('TEST_DO', 'instance-1', {
        onClose: () => {},
        WebSocketClass: MockWebSocket as any
      });
      expect(transport).toBeDefined();
    });

    it('should create transport with all options', () => {
      const transport = createWebSocketTransport('TEST_DO', 'instance-1', {
        baseUrl: 'https://custom.example.com',
        prefix: '/custom-rpc',
        timeout: 60000,
        WebSocketClass: MockWebSocket as any,
        clientId: 'client-123',
        additionalProtocols: ['protocol1'],
        onDownstream: () => {},
        onClose: () => {},
      });
      expect(transport).toBeDefined();
    });
  });
});

