import { describe, it, expect } from 'vitest';
import { Browser } from '../../src/browser';

/** Flush all pending microtasks */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Context', () => {
  // Use a mock fetch for all tests
  const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const request = new Request(input);
    return new Response(`ok:${request.url}`, {
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    });
  };

  describe('sessionStorage', () => {
    it('should provide per-context sessionStorage', () => {
      const browser = new Browser(mockFetch);
      const ctx = browser.context('https://example.com');

      ctx.sessionStorage.setItem('key', 'value');
      expect(ctx.sessionStorage.getItem('key')).toBe('value');
    });

    it('should isolate sessionStorage across contexts', () => {
      const browser = new Browser(mockFetch);
      const ctx1 = browser.context('https://example.com');
      const ctx2 = browser.context('https://example.com');

      ctx1.sessionStorage.setItem('key', 'from-ctx1');
      expect(ctx2.sessionStorage.getItem('key')).toBeNull();
    });

    it('should isolate sessionStorage across different origins', () => {
      const browser = new Browser(mockFetch);
      const ctx1 = browser.context('https://example.com');
      const ctx2 = browser.context('https://other.com');

      ctx1.sessionStorage.setItem('key', 'value');
      expect(ctx2.sessionStorage.getItem('key')).toBeNull();
    });
  });

  describe('BroadcastChannel', () => {
    it('should allow cross-context messaging within same origin', async () => {
      const browser = new Browser(mockFetch);
      const ctx1 = browser.context('https://example.com');
      const ctx2 = browser.context('https://example.com');

      const received: unknown[] = [];
      const ch1 = new ctx1.BroadcastChannel('sync');
      const ch2 = new ctx2.BroadcastChannel('sync');

      ch2.onmessage = (event: MessageEvent) => received.push(event.data);

      ch1.postMessage('hello from ctx1');
      await flush();

      expect(received).toEqual(['hello from ctx1']);

      ch1.close();
      ch2.close();
    });

    it('should isolate BroadcastChannel across different origins', async () => {
      const browser = new Browser(mockFetch);
      const ctx1 = browser.context('https://example.com');
      const ctx2 = browser.context('https://other.com');

      const received: unknown[] = [];
      const ch1 = new ctx1.BroadcastChannel('sync');
      const ch2 = new ctx2.BroadcastChannel('sync');

      ch2.onmessage = (event: MessageEvent) => received.push(event.data);

      ch1.postMessage('should not arrive');
      await flush();

      expect(received).toEqual([]);

      ch1.close();
      ch2.close();
    });
  });

  describe('close()', () => {
    it('should clear sessionStorage on close', () => {
      const browser = new Browser(mockFetch);
      const ctx = browser.context('https://example.com');
      ctx.sessionStorage.setItem('key', 'value');

      ctx.close();
      expect(ctx.sessionStorage.getItem('key')).toBeNull();
    });

    it('should close all open BroadcastChannels on close', async () => {
      const browser = new Browser(mockFetch);
      const ctx1 = browser.context('https://example.com');
      const ctx2 = browser.context('https://example.com');

      const received: unknown[] = [];
      const ch1 = new ctx1.BroadcastChannel('test');
      const ch2 = new ctx2.BroadcastChannel('test');
      ch2.onmessage = (event: MessageEvent) => received.push(event.data);

      // Close ctx1 — its channels should be cleaned up
      ctx1.close();

      // ch2 sending to ch1 should not deliver (ch1's channels closed)
      ch2.postMessage('should not arrive');
      await flush();

      expect(received).toEqual([]);

      ch2.close();
    });
  });

  describe('backward compatibility', () => {
    it('should support destructuring { fetch, WebSocket }', async () => {
      const browser = new Browser(mockFetch);
      const { fetch: ctxFetch, WebSocket: CtxWebSocket } = browser.context('https://example.com');

      expect(typeof ctxFetch).toBe('function');
      expect(typeof CtxWebSocket).toBe('function');

      // fetch should work
      const response = await ctxFetch('https://example.com/test');
      const text = await response.text();
      expect(text).toBe('ok:https://example.com/test');
    });

    it('should expose lastPreflight', () => {
      const browser = new Browser(mockFetch);
      const ctx = browser.context('https://example.com');
      expect(ctx.lastPreflight).toBeNull();
    });
  });
});

describe('duplicateContext', () => {
  const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  };

  it('should clone sessionStorage', () => {
    const browser = new Browser(mockFetch);
    const ctx1 = browser.context('https://example.com');
    ctx1.sessionStorage.setItem('lmz_tab', 'abc12345');
    ctx1.sessionStorage.setItem('other', 'data');

    const ctx2 = browser.duplicateContext(ctx1);

    expect(ctx2.sessionStorage.getItem('lmz_tab')).toBe('abc12345');
    expect(ctx2.sessionStorage.getItem('other')).toBe('data');
  });

  it('should create independent sessionStorage (mutations do not propagate)', () => {
    const browser = new Browser(mockFetch);
    const ctx1 = browser.context('https://example.com');
    ctx1.sessionStorage.setItem('lmz_tab', 'abc12345');

    const ctx2 = browser.duplicateContext(ctx1);
    ctx2.sessionStorage.setItem('lmz_tab', 'new-value');

    // Original unchanged
    expect(ctx1.sessionStorage.getItem('lmz_tab')).toBe('abc12345');
    expect(ctx2.sessionStorage.getItem('lmz_tab')).toBe('new-value');
  });

  it('should share BroadcastChannel namespace with original', async () => {
    const browser = new Browser(mockFetch);
    const ctx1 = browser.context('https://example.com');
    const ctx2 = browser.duplicateContext(ctx1);

    const received: unknown[] = [];
    const ch1 = new ctx1.BroadcastChannel('test');
    const ch2 = new ctx2.BroadcastChannel('test');

    ch1.onmessage = (event: MessageEvent) => received.push(event.data);

    ch2.postMessage('from duplicate');
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toEqual(['from duplicate']);

    ch1.close();
    ch2.close();
  });

  it('should support the full duplicate-tab detection pattern', async () => {
    const browser = new Browser(mockFetch);

    // Tab 1: set tabId and listen for probes
    const tab1 = browser.context('https://example.com');
    tab1.sessionStorage.setItem('lmz_tab', 'tab-original');

    const tab1Channel = new tab1.BroadcastChannel('tab-original');
    tab1Channel.onmessage = (event: MessageEvent) => {
      if (event.data === 'probe') {
        tab1Channel.postMessage('in-use');
      }
    };

    // Tab 2: duplicate of tab1 (simulating browser tab duplication)
    const tab2 = browser.duplicateContext(tab1);
    const storedTabId = tab2.sessionStorage.getItem('lmz_tab');
    expect(storedTabId).toBe('tab-original'); // Cloned from tab1

    // Tab 2 probes to check if the tabId is already in use
    const isInUse = await new Promise<boolean>((resolve) => {
      const probeChannel = new tab2.BroadcastChannel(storedTabId!);
      const timeout = setTimeout(() => {
        probeChannel.close();
        resolve(false);
      }, 50);

      probeChannel.onmessage = (event: MessageEvent) => {
        if (event.data === 'in-use') {
          clearTimeout(timeout);
          probeChannel.close();
          resolve(true);
        }
      };

      probeChannel.postMessage('probe');
    });

    expect(isInUse).toBe(true);

    // Tab 2 detects collision, regenerates tabId
    tab2.sessionStorage.setItem('lmz_tab', 'tab-duplicate');
    expect(tab2.sessionStorage.getItem('lmz_tab')).toBe('tab-duplicate');
    expect(tab1.sessionStorage.getItem('lmz_tab')).toBe('tab-original');

    tab1Channel.close();
    tab1.close();
    tab2.close();
  });
});
