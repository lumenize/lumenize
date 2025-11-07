/**
 * Quick experiment to test Map/Set with object keys behavior
 * Tests both DO KV storage and Workers RPC
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { DurableObject } from 'cloudflare:workers';

// Test DO for storage experiments - must extend DurableObject for RPC
export class StorageTestDO extends DurableObject {
  async testMapWithObjectKeys() {
    // Create a map with object key
    const keyObj = { userId: 123, role: 'admin' };
    const map = new Map([[keyObj, 'user data']]);

    // Store it
    this.ctx.storage.kv.put('test-map', map);

    // Retrieve it
    const retrieved = this.ctx.storage.kv.get('test-map') as Map<any, any>;

    // Try to access with original key object
    const withOriginal = retrieved.get(keyObj);

    // Try to access with new structurally-equal object
    const withNew = retrieved.get({ userId: 123, role: 'admin' });

    // Try to access with reconstructed key
    const keys = Array.from(retrieved.keys());
    const withReconstructed = retrieved.get(keys[0]);

    return {
      withOriginal: withOriginal ?? 'undefined',
      withNew: withNew ?? 'undefined',
      withReconstructed: withReconstructed ?? 'undefined',
      keyStructure: keys[0],
    };
  }

  async testSetWithObjectValues() {
    // Create a set with object value
    const obj = { id: 1, name: 'Alice' };
    const set = new Set([obj]);

    // Store it
    this.ctx.storage.kv.put('test-set', set);

    // Retrieve it
    const retrieved = this.ctx.storage.kv.get('test-set') as Set<any>;

    // Check membership with original
    const hasOriginal = retrieved.has(obj);

    // Check membership with new structurally-equal object
    const hasNew = retrieved.has({ id: 1, name: 'Alice' });

    // Get the reconstructed value
    const values = Array.from(retrieved);
    const hasReconstructed = retrieved.has(values[0]);

    return {
      hasOriginal,
      hasNew,
      hasReconstructed,
      valueStructure: values[0],
    };
  }
}

// Test DO for RPC experiments - must extend DurableObject for RPC
export class RpcTestDO extends DurableObject {
  // Return a map with object key
  async getMapWithObjectKey() {
    const keyObj = { userId: 456, role: 'user' };
    const map = new Map([[keyObj, 'rpc user data']]);
    return map;
  }

  // Accept a map and try to access it
  async accessMapValue(map: Map<any, any>, keyToFind: any) {
    // Try with provided key
    const withProvided = map.get(keyToFind);

    // Try with new structurally-equal key
    const withNew = map.get({ userId: 456, role: 'user' });

    // Try with reconstructed key
    const keys = Array.from(map.keys());
    const withReconstructed = keys.length > 0 ? map.get(keys[0]) : 'no keys';

    return {
      withProvided: withProvided ?? 'undefined',
      withNew: withNew ?? 'undefined',
      withReconstructed: withReconstructed ?? 'undefined',
      keyStructure: keys[0],
    };
  }

  // Return a set with object value
  async getSetWithObjectValue() {
    const obj = { id: 2, name: 'Bob' };
    const set = new Set([obj]);
    return set;
  }

  // Accept a set and check membership
  async checkSetMembership(set: Set<any>, valueToFind: any) {
    // Try with provided value
    const hasProvided = set.has(valueToFind);

    // Try with new structurally-equal value
    const hasNew = set.has({ id: 2, name: 'Bob' });

    // Check reconstructed value
    const values = Array.from(set);
    const hasReconstructed = values.length > 0 ? set.has(values[0]) : false;

    return {
      hasProvided,
      hasNew,
      hasReconstructed,
      valueStructure: values[0],
    };
  }
}

export default {
  async fetch(request: Request, env: any) {
    return new Response('Test worker');
  },
};

// Tests
describe('DO KV Storage - Map with Object Keys', () => {
  it('tests object key identity after storage round-trip', async () => {
    const id = env.STORAGE_TEST_DO.idFromName('test-storage');
    const stub = env.STORAGE_TEST_DO.get(id);
    const result = await stub.testMapWithObjectKeys();

    console.log('\n=== DO Storage Map Results ===');
    console.log('withOriginal:', result.withOriginal);
    console.log('withNew:', result.withNew);
    console.log('withReconstructed:', result.withReconstructed);
    console.log('keyStructure:', result.keyStructure);
    
    // Document findings
    expect(result.keyStructure).toBeDefined();
    expect(result.keyStructure).toHaveProperty('userId', 123);
    expect(result.keyStructure).toHaveProperty('role', 'admin');
  });

  it('tests object value identity in Set after storage round-trip', async () => {
    const id = env.STORAGE_TEST_DO.idFromName('test-storage');
    const stub = env.STORAGE_TEST_DO.get(id);
    const result = await stub.testSetWithObjectValues();

    console.log('\n=== DO Storage Set Results ===');
    console.log('hasOriginal:', result.hasOriginal);
    console.log('hasNew:', result.hasNew);
    console.log('hasReconstructed:', result.hasReconstructed);
    console.log('valueStructure:', result.valueStructure);
    
    // Document findings
    expect(result.valueStructure).toBeDefined();
    expect(result.valueStructure).toHaveProperty('id', 1);
    expect(result.valueStructure).toHaveProperty('name', 'Alice');
  });
});

describe('Workers RPC - Map with Object Keys', () => {
  it('tests object key identity through RPC', async () => {
    const id = env.RPC_TEST_DO.idFromName('test-rpc');
    const stub = env.RPC_TEST_DO.get(id);
    
    // Get a map from the DO
    const map = await stub.getMapWithObjectKey();
    
    console.log('\n=== RPC Map Results ===');
    console.log('Map type:', map.constructor.name);
    console.log('Map size:', map.size);

    // Try to access using the key from the map
    const keys = Array.from(map.keys());
    console.log('Keys:', keys);
    const keyObj = keys[0];

    // Send the map and key back to check access
    const result = await stub.accessMapValue(map, keyObj);

    console.log('withProvided:', result.withProvided);
    console.log('withNew:', result.withNew);
    console.log('withReconstructed:', result.withReconstructed);
    console.log('keyStructure:', result.keyStructure);

    // Document findings
    expect(result.keyStructure).toBeDefined();
  });

  it('tests object value identity in Set through RPC', async () => {
    const id = env.RPC_TEST_DO.idFromName('test-rpc');
    const stub = env.RPC_TEST_DO.get(id);
    
    // Get a set from the DO
    const set = await stub.getSetWithObjectValue();

    console.log('\n=== RPC Set Results ===');
    console.log('Set type:', set.constructor.name);
    console.log('Set size:', set.size);

    // Try to check membership
    const values = Array.from(set);
    console.log('Values:', values);
    const valueObj = values[0];

    // Send the set and value back to check membership
    const result = await stub.checkSetMembership(set, valueObj);

    console.log('hasProvided:', result.hasProvided);
    console.log('hasNew:', result.hasNew);
    console.log('hasReconstructed:', result.hasReconstructed);
    console.log('valueStructure:', result.valueStructure);

    // Document findings
    expect(result.valueStructure).toBeDefined();
  });
});
