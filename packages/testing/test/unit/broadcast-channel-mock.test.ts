import { describe, it, expect, vi } from 'vitest';
import {
  BroadcastChannelMock,
  createBroadcastChannelConstructor,
  type BroadcastChannelRegistry,
} from '../../src/broadcast-channel-mock';

function createRegistry(): BroadcastChannelRegistry {
  return new Map();
}

/** Flush all pending microtasks */
async function flush(): Promise<void> {
  // Two rounds to ensure all microtask chains complete
  await Promise.resolve();
  await Promise.resolve();
}

describe('BroadcastChannelMock', () => {
  describe('basic messaging', () => {
    it('should deliver messages to other channels with the same name', async () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      const ch2 = new BroadcastChannelMock('test', registry);

      const received: unknown[] = [];
      ch2.onmessage = (event) => received.push(event.data);

      ch1.postMessage('hello');
      await flush();

      expect(received).toEqual(['hello']);
    });

    it('should NOT deliver messages to the posting instance', async () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);

      const received: unknown[] = [];
      ch1.onmessage = (event) => received.push(event.data);

      ch1.postMessage('hello');
      await flush();

      expect(received).toEqual([]);
    });

    it('should deliver to multiple listeners', async () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      const ch2 = new BroadcastChannelMock('test', registry);
      const ch3 = new BroadcastChannelMock('test', registry);

      const received2: unknown[] = [];
      const received3: unknown[] = [];
      ch2.onmessage = (event) => received2.push(event.data);
      ch3.onmessage = (event) => received3.push(event.data);

      ch1.postMessage('broadcast');
      await flush();

      expect(received2).toEqual(['broadcast']);
      expect(received3).toEqual(['broadcast']);
    });

    it('should NOT deliver to channels with different names', async () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('channel-a', registry);
      const ch2 = new BroadcastChannelMock('channel-b', registry);

      const received: unknown[] = [];
      ch2.onmessage = (event) => received.push(event.data);

      ch1.postMessage('hello');
      await flush();

      expect(received).toEqual([]);
    });

    it('should deliver messages asynchronously', async () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      const ch2 = new BroadcastChannelMock('test', registry);

      const order: string[] = [];
      ch2.onmessage = () => order.push('received');

      ch1.postMessage('hello');
      order.push('after-post');

      // Message should NOT have been delivered yet (it's async)
      expect(order).toEqual(['after-post']);

      await flush();

      // Now it should be delivered
      expect(order).toEqual(['after-post', 'received']);
    });

    it('should pass complex data types', async () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      const ch2 = new BroadcastChannelMock('test', registry);

      const received: unknown[] = [];
      ch2.onmessage = (event) => received.push(event.data);

      const data = { type: 'probe', payload: [1, 2, 3] };
      ch1.postMessage(data);
      await flush();

      expect(received).toEqual([data]);
    });
  });

  describe('close()', () => {
    it('should stop receiving messages after close', async () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      const ch2 = new BroadcastChannelMock('test', registry);

      const received: unknown[] = [];
      ch2.onmessage = (event) => received.push(event.data);

      ch2.close();
      ch1.postMessage('hello');
      await flush();

      expect(received).toEqual([]);
    });

    it('should throw when posting after close', () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      ch1.close();

      expect(() => ch1.postMessage('hello')).toThrow('Channel is closed');
    });

    it('should be idempotent', () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      ch1.close();
      ch1.close(); // Should not throw
    });

    it('should clean up registry when last channel closes', () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      const ch2 = new BroadcastChannelMock('test', registry);

      expect(registry.has('test')).toBe(true);

      ch1.close();
      expect(registry.has('test')).toBe(true); // ch2 still open

      ch2.close();
      expect(registry.has('test')).toBe(false); // All closed, cleaned up
    });

    it('should not deliver if channel closes between post and delivery', async () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      const ch2 = new BroadcastChannelMock('test', registry);

      const received: unknown[] = [];
      ch2.onmessage = (event) => received.push(event.data);

      ch1.postMessage('hello');
      // Close before microtask fires
      ch2.close();
      await flush();

      expect(received).toEqual([]);
    });
  });

  describe('addEventListener', () => {
    it('should work with addEventListener', async () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      const ch2 = new BroadcastChannelMock('test', registry);

      const received: unknown[] = [];
      ch2.addEventListener('message', ((event: MessageEvent) => {
        received.push(event.data);
      }) as EventListener);

      ch1.postMessage('via-listener');
      await flush();

      expect(received).toEqual(['via-listener']);
    });

    it('should fire both onmessage and addEventListener handlers', async () => {
      const registry = createRegistry();
      const ch1 = new BroadcastChannelMock('test', registry);
      const ch2 = new BroadcastChannelMock('test', registry);

      const order: string[] = [];
      ch2.onmessage = () => order.push('onmessage');
      ch2.addEventListener('message', () => order.push('listener'));

      ch1.postMessage('hello');
      await flush();

      expect(order).toEqual(['onmessage', 'listener']);
    });
  });

  describe('name property', () => {
    it('should expose the channel name', () => {
      const registry = createRegistry();
      const ch = new BroadcastChannelMock('my-channel', registry);
      expect(ch.name).toBe('my-channel');
    });
  });

  describe('createBroadcastChannelConstructor', () => {
    it('should create a constructor bound to a shared registry', async () => {
      const registry = createRegistry();
      const BroadcastChannel = createBroadcastChannelConstructor(registry);

      const ch1 = new BroadcastChannel('test');
      const ch2 = new BroadcastChannel('test');

      const received: unknown[] = [];
      ch2.onmessage = (event: MessageEvent) => received.push(event.data);

      ch1.postMessage('bound');
      await flush();

      expect(received).toEqual(['bound']);
    });

    it('should allow cross-context communication via shared registry', async () => {
      // Simulates two "tabs" sharing a registry (same origin)
      const sharedRegistry = createRegistry();
      const Tab1BroadcastChannel = createBroadcastChannelConstructor(sharedRegistry);
      const Tab2BroadcastChannel = createBroadcastChannelConstructor(sharedRegistry);

      const ch1 = new Tab1BroadcastChannel('sync');
      const ch2 = new Tab2BroadcastChannel('sync');

      const received: unknown[] = [];
      ch1.onmessage = (event: MessageEvent) => received.push(event.data);

      ch2.postMessage('from-tab2');
      await flush();

      expect(received).toEqual(['from-tab2']);
    });

    it('should isolate separate registries (different origins)', async () => {
      const registry1 = createRegistry();
      const registry2 = createRegistry();
      const BC1 = createBroadcastChannelConstructor(registry1);
      const BC2 = createBroadcastChannelConstructor(registry2);

      const ch1 = new BC1('test');
      const ch2 = new BC2('test');

      const received: unknown[] = [];
      ch2.onmessage = (event: MessageEvent) => received.push(event.data);

      ch1.postMessage('isolated');
      await flush();

      expect(received).toEqual([]); // Different registries = different origins
    });
  });

  describe('duplicate-tab detection pattern', () => {
    it('should support the BroadcastChannel probe pattern for duplicate tab detection', async () => {
      const registry = createRegistry();

      // Tab 1 opens a channel and listens for probes
      const tab1Channel = new BroadcastChannelMock('tab-id-abc', registry);
      tab1Channel.onmessage = (event) => {
        if (event.data === 'probe') {
          tab1Channel.postMessage('in-use');
        }
      };

      // Tab 2 (duplicate) probes to check if the tabId is in use
      const isInUse = await new Promise<boolean>((resolve) => {
        const probeChannel = new BroadcastChannelMock('tab-id-abc', registry);
        const timeout = setTimeout(() => {
          probeChannel.close();
          resolve(false);
        }, 50);

        probeChannel.onmessage = (event) => {
          if (event.data === 'in-use') {
            clearTimeout(timeout);
            probeChannel.close();
            resolve(true);
          }
        };

        probeChannel.postMessage('probe');
      });

      expect(isInUse).toBe(true);

      tab1Channel.close();
    });

    it('should detect tabId as available when no other tab responds', async () => {
      const registry = createRegistry();

      // No tab1 — nobody is listening
      const isInUse = await new Promise<boolean>((resolve) => {
        const probeChannel = new BroadcastChannelMock('unused-tab-id', registry);
        const timeout = setTimeout(() => {
          probeChannel.close();
          resolve(false);
        }, 50);

        probeChannel.onmessage = (event) => {
          if (event.data === 'in-use') {
            clearTimeout(timeout);
            probeChannel.close();
            resolve(true);
          }
        };

        probeChannel.postMessage('probe');
      });

      expect(isInUse).toBe(false);
    });
  });
});
