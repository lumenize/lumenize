/**
 * Pedagogical examples for Map and Set behavior documentation
 * Teaching-focused examples showing identity preservation and boundaries
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse } from '../../src/index.js';

describe('Primitive Keys Work as Expected', () => {
  it('handles string, number, and boolean keys', async () => {
    // Sender side
    // @ts-expect-error — heterogeneous Map keys; docs show idiomatic JS
    const map = new Map([
      ["user123", { name: "Alice" }],
      [42, { count: 100 }],
      [true, { active: true }]
    ]);
    
    const serialized = stringify(map);
    
    // Receiver side
    const restored = parse(serialized);
    
    expect(restored.get("user123")).toEqual({ name: "Alice" });
    expect(restored.get(42)).toEqual({ count: 100 });
    expect(restored.get(true)).toEqual({ active: true });
  });
});

describe('Object Keys - Reconstructed but Different Identity', () => {
  it('reconstructs object keys with all properties', async () => {
    // Sender side
    const keyObj = { userId: 123, role: "admin" };
    const map = new Map([[keyObj, "user data"]]);
    
    const serialized = stringify(map);
    
    // Receiver side
    const restored = parse(serialized);
    
    // The key is fully reconstructed...
    const keys = Array.from(restored.keys());
    expect(keys[0]).toEqual({ userId: 123, role: "admin" });

    // All properties are preserved...
    // @ts-expect-error — keys are untyped after deserialization
    expect(keys[0].userId).toBe(123);
    // @ts-expect-error — keys are untyped after deserialization
    expect(keys[0].role).toBe("admin");
    
    // BUT it's a new object with different identity...
    const newKey = { userId: 123, role: "admin" };
    expect(restored.get(newKey)).toBeUndefined();
    
    // You must use the reconstructed key object:
    expect(restored.get(keys[0])).toBe("user data");
  });
});

describe('Finding Object Keys After Deserialization', () => {
  it('searches by property match', async () => {
    // Sender side
    const user1Key = { userId: 123, type: "user" };
    const user2Key = { userId: 456, type: "user" };
    const adminKey = { userId: 789, type: "admin" };
    
    const map = new Map([
      [user1Key, { name: "Alice", email: "alice@example.com" }],
      [user2Key, { name: "Bob", email: "bob@example.com" }],
      [adminKey, { name: "Admin", email: "admin@example.com" }]
    ]);
    
    const serialized = stringify(map);
    
    // Receiver side
    const restored = parse(serialized);
    
    // Find the key for userId 456
    const targetKey = Array.from(restored.keys()).find(
      // @ts-ignore — keys are untyped after deserialization
      key => key.userId === 456
    );
    
    if (targetKey) {
      expect(restored.get(targetKey)).toEqual({
        name: "Bob",
        email: "bob@example.com"
      });
    }
  });

  it('stores keys separately', async () => {
    // Sender side
    const keyObj = { userId: 123, role: "admin" };
    
    const data = {
      map: new Map([[keyObj, "user data"]]),
      keyToLookup: keyObj  // ✅ Share the key explicitly!
    };
    
    const serialized = stringify(data);
    
    // Receiver side
    const restored = parse(serialized);
    
    // Now you can access the map using the shared key!
    expect(restored.map.get(restored.keyToLookup)).toBe("user data");
    
    // The key references are preserved:
    expect(restored.keyToLookup === Array.from(restored.map.keys())[0]).toBe(true);
  });
});

describe('Set Behavior with Objects', () => {
  it('handles primitive and object values', async () => {
    // Primitive values work fine
    const set = new Set(["apple", "banana", 123]);
    const restored = parse(stringify(set));
    expect(restored.has("apple")).toBe(true);
    // ...
    
    // Object values: can't use new objects, must search or store reference
    const obj = { id: 1, name: "Alice" };
    const data = { set: new Set([obj]), aliceRef: obj };
    const restored2 = parse(stringify(data));
    expect(restored2.set.has(restored2.aliceRef)).toBe(true);
  });
});

describe('Aliases and Identity Preservation', () => {
  it('preserves shared object references', async () => {
    const sharedKey = { category: "users" };
    const map1 = new Map([[sharedKey, "data1"]]);
    const map2 = new Map([[sharedKey, "data2"]]);
    const data = { map1, map2, theKey: sharedKey };
    
    const restored = parse(stringify(data));
    
    // All references point to the same reconstructed object!
    expect(restored.map1.get(restored.theKey)).toBe("data1");
    expect(restored.map2.get(restored.theKey)).toBe("data2");
    
    const key1 = Array.from(restored.map1.keys())[0];
    const key2 = Array.from(restored.map2.keys())[0];
    expect(key1 === key2 && key1 === restored.theKey).toBe(true);
  });
});

