/**
 * Test that @lumenize/rpc preserves object identity for Map/Set keys/values
 * within a single RPC call, matching native structuredClone and Workers RPC behavior
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createRpcClient, createHttpTransport, createWebSocketTransport, lumenizeRpcDO } from '../src/index';
import { getWebSocketShim } from '@lumenize/utils';
import { DurableObject } from 'cloudflare:workers';

/**
 * Test DO with methods that accept and return Maps/Sets with object keys/values
 */
class MapSetTestDO extends DurableObject {
  // Return a map with an object key
  getMapWithKey() {
    const key = { userId: 123, role: 'admin' };
    const map = new Map([[key, 'user data']]);
    return { map, key };  // Return both together
  }

  // Accept a map and key, try to access the value
  accessMapValue(map: Map<any, any>, key: any) {
    return {
      canAccess: map.get(key) !== undefined,
      value: map.get(key),
      hasKey: map.has(key),
    };
  }

  // Return a set with an object value
  getSetWithValue() {
    const value = { id: 456, name: 'Alice' };
    const set = new Set([value]);
    return { set, value };  // Return both together
  }

  // Accept a set and value, check membership
  checkSetMembership(set: Set<any>, value: any) {
    return {
      hasMember: set.has(value),
      size: set.size,
    };
  }

  // Complex scenario: multiple maps sharing keys
  getSharedKeyMaps() {
    const sharedKey = { category: 'admin' };
    return {
      map1: new Map([[sharedKey, 'value1']]),
      map2: new Map([[sharedKey, 'value2']]),
      theKey: sharedKey,
    };
  }

  // Accept the shared key structure and verify identity
  verifySharedKeys(data: { map1: Map<any, any>, map2: Map<any, any>, theKey: any }) {
    return {
      map1HasKey: data.map1.get(data.theKey) !== undefined,
      map2HasKey: data.map2.get(data.theKey) !== undefined,
      map1Value: data.map1.get(data.theKey),
      map2Value: data.map2.get(data.theKey),
      keysAreIdentical: Array.from(data.map1.keys())[0] === Array.from(data.map2.keys())[0],
    };
  }

}

const MapSetTestDOWithRpc = lumenizeRpcDO(MapSetTestDO);
export { MapSetTestDOWithRpc };

export default {
  async fetch() {
    return new Response('Map/Set identity test worker');
  },
};

// Run tests with both transports
const TRANSPORTS = ['websocket', 'http'] as const;

for (const transportType of TRANSPORTS) {
  describe(`Map/Set Identity Preservation - ${transportType.toUpperCase()}`, () => {
    let client: any;

    beforeEach(async () => {
      const id = (SELF as any).MAPSET_TEST_DO.idFromName('test-identity');
      
      if (transportType === 'websocket') {
        const transport = createWebSocketTransport('mapset-test-do', id.toString(), {
          baseUrl: 'https://fake-host.com',
          prefix: '__rpc',
          WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
        });
        client = createRpcClient({ transport });
      } else {
        const transport = createHttpTransport('mapset-test-do', id.toString(), {
          baseUrl: 'https://fake-host.com',
          prefix: '__rpc',
          fetch: SELF.fetch.bind(SELF),
        });
        client = createRpcClient({ transport });
      }
    });

    it('preserves Map key identity when returned together', async () => {
      const result = await client.getMapWithKey();
      
      expect(result.map).toBeInstanceOf(Map);
      expect(result.map.size).toBe(1);
      
      // The key should work for accessing the map
      const value = result.map.get(result.key);
      expect(value).toBe('user data');
      
      // Verify identity is preserved
      const keys = Array.from(result.map.keys());
      expect(result.key === keys[0]).toBe(true);
    });

    it('preserves Map key identity when sent together to DO', async () => {
      // Get map and key from DO
      const { map, key } = await client.getMapWithKey();
      
      // Send them back together in another call
      const result = await client.accessMapValue(map, key);
      
      expect(result.canAccess).toBe(true);
      expect(result.value).toBe('user data');
      expect(result.hasKey).toBe(true);
    });

    it('preserves Set value identity when returned together', async () => {
      const result = await client.getSetWithValue();
      
      expect(result.set).toBeInstanceOf(Set);
      expect(result.set.size).toBe(1);
      
      // The value should work for membership check
      expect(result.set.has(result.value)).toBe(true);
      
      // Verify identity is preserved
      const values = Array.from(result.set);
      expect(result.value === values[0]).toBe(true);
    });

    it('preserves Set value identity when sent together to DO', async () => {
      // Get set and value from DO
      const { set, value } = await client.getSetWithValue();
      
      // Send them back together in another call
      const result = await client.checkSetMembership(set, value);
      
      expect(result.hasMember).toBe(true);
      expect(result.size).toBe(1);
    });

    it('preserves shared key identity across multiple Maps', async () => {
      const data = await client.getSharedKeyMaps();
      
      // All three should reference the same object
      const key1 = Array.from(data.map1.keys())[0];
      const key2 = Array.from(data.map2.keys())[0];
      
      expect(key1 === key2).toBe(true);
      expect(key1 === data.theKey).toBe(true);
      
      // Should be able to access both maps with the shared key
      expect(data.map1.get(data.theKey)).toBe('value1');
      expect(data.map2.get(data.theKey)).toBe('value2');
    });

    it('preserves shared key identity when sent back to DO', async () => {
      // Get shared key structure
      const data = await client.getSharedKeyMaps();
      
      // Send it back to verify
      const result = await client.verifySharedKeys(data);
      
      expect(result.map1HasKey).toBe(true);
      expect(result.map2HasKey).toBe(true);
      expect(result.map1Value).toBe('value1');
      expect(result.map2Value).toBe('value2');
      expect(result.keysAreIdentical).toBe(true);
    });

    it('loses identity when key created on client side', async () => {
      const { map } = await client.getMapWithKey();
      
      // Create a new key with same structure
      const newKey = { userId: 123, role: 'admin' };
      
      // This should NOT work - different object
      expect(map.get(newKey)).toBeUndefined();
      
      // But the original key from the map still works
      const originalKey = Array.from(map.keys())[0];
      expect(map.get(originalKey)).toBe('user data');
    });
  });
}

