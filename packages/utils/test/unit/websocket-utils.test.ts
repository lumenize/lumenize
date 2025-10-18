import { describe, it, expect } from 'vitest';
import { isWebSocketUpgrade } from '../../src/websocket-utils';

describe('isWebSocketUpgrade', () => {
  it('should return true for valid WebSocket upgrade request', () => {
    const request = new Request('http://localhost:8787/ws', {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'upgrade'
      }
    });
    
    expect(isWebSocketUpgrade(request)).toBe(true);
  });

  it('should return true for case-insensitive WebSocket upgrade request', () => {
    const request = new Request('http://localhost:8787/ws', {
      method: 'GET',
      headers: {
        'Upgrade': 'WebSocket',
        'Connection': 'Upgrade'
      }
    });
    
    expect(isWebSocketUpgrade(request)).toBe(true);
  });

  it('should return true when Connection header contains upgrade along with other values', () => {
    const request = new Request('http://localhost:8787/ws', {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'keep-alive, upgrade'
      }
    });
    
    expect(isWebSocketUpgrade(request)).toBe(true);
  });

  it('should return false for non-GET method', () => {
    const request = new Request('http://localhost:8787/ws', {
      method: 'POST',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'upgrade'
      }
    });
    
    expect(isWebSocketUpgrade(request)).toBe(false);
  });

  it('should return false when Upgrade header is missing', () => {
    const request = new Request('http://localhost:8787/ws', {
      method: 'GET',
      headers: {
        'Connection': 'upgrade'
      }
    });
    
    expect(isWebSocketUpgrade(request)).toBe(false);
  });

  it('should return false when Connection header is missing', () => {
    const request = new Request('http://localhost:8787/ws', {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket'
      }
    });
    
    expect(isWebSocketUpgrade(request)).toBe(false);
  });

  it('should return false when Upgrade header is not websocket', () => {
    const request = new Request('http://localhost:8787/ws', {
      method: 'GET',
      headers: {
        'Upgrade': 'http2',
        'Connection': 'upgrade'
      }
    });
    
    expect(isWebSocketUpgrade(request)).toBe(false);
  });

  it('should return false when Connection header does not contain upgrade', () => {
    const request = new Request('http://localhost:8787/ws', {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'keep-alive'
      }
    });
    
    expect(isWebSocketUpgrade(request)).toBe(false);
  });

  it('should return false for regular HTTP request', () => {
    const request = new Request('http://localhost:8787/api/data', {
      method: 'GET'
    });
    
    expect(isWebSocketUpgrade(request)).toBe(false);
  });
});
