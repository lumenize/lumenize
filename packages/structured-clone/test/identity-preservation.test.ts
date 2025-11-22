/**
 * Test that @lumenize/structured-clone preserves object identity within a single call
 * This should match native structuredClone() behavior
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse, preprocess, postprocess } from '../src/index';

describe('Identity Preservation - Match Native structuredClone', () => {
  it('Map with object key (separate serialization - identity lost)', async () => {
    const keyObj = { userId: 123, role: 'admin' };
    const originalMap = new Map([[keyObj, 'user data']]);

    // Serialize the map alone
    const clonedMap = parse(stringify(originalMap));

    // Original key won't work (it was never part of this serialization)
    expect(clonedMap.get(keyObj)).toBeUndefined();
    
    // New key won't work either
    expect(clonedMap.get({ userId: 123, role: 'admin' })).toBeUndefined();
    
    // But the reconstructed key will work
    const clonedKeys = Array.from(clonedMap.keys());
    expect(clonedMap.get(clonedKeys[0])).toBe('user data');
  });

  it('Map and key together (SAME call - identity preserved!)', async () => {
    const sharedKey = { id: 456 };
    const data = {
      map: new Map([[sharedKey, 'value']]),
      theKey: sharedKey  // Same key referenced twice
    };

    // Verify original works
    expect(data.map.get(data.theKey)).toBe('value');
    expect(data.theKey === Array.from(data.map.keys())[0]).toBe(true);

    // Serialize together
    const clonedData = parse(stringify(data));

    // ✅ Identity preserved! This should work
    expect(clonedData.map.get(clonedData.theKey)).toBe('value');
    expect(clonedData.theKey === Array.from(clonedData.map.keys())[0]).toBe(true);
  });

  it('Set and value together (SAME call - identity preserved!)', async () => {
    const sharedObj = { id: 789 };
    const setData = {
      set: new Set([sharedObj]),
      theObj: sharedObj
    };

    // Verify original works
    expect(setData.set.has(setData.theObj)).toBe(true);

    // Serialize together
    const clonedSetData = parse(stringify(setData));

    // ✅ Identity preserved! This should work
    expect(clonedSetData.set.has(clonedSetData.theObj)).toBe(true);
    expect(clonedSetData.theObj === Array.from(clonedSetData.set)[0]).toBe(true);
  });

  it('Circular reference with Map', async () => {
    const circularKey = { type: 'key' };
    const circularMap = new Map([[circularKey, 'data']]);
    circularKey.backref = circularMap;  // Circular!

    // Verify original
    expect(circularKey.backref === circularMap).toBe(true);

    // Serialize
    const clonedCircular = parse(stringify(circularMap));
    const clonedCircularKeys = Array.from(clonedCircular.keys());

    // ✅ Circular reference preserved!
    expect(clonedCircularKeys[0].backref === clonedCircular).toBe(true);
  });

  it('preprocess/postprocess layer (SAME call - identity preserved!)', async () => {
    const key = { userId: 999 };
    const data = {
      map: new Map([[key, 'preprocessed data']]),
      theKey: key
    };

    // Use preprocess/postprocess
    const intermediate = preprocess(data);
    const restored = postprocess(intermediate);

    // ✅ Identity preserved!
    expect(restored.map.get(restored.theKey)).toBe('preprocessed data');
    expect(restored.theKey === Array.from(restored.map.keys())[0]).toBe(true);
  });

  it('Multiple preprocess calls (SEPARATE - identity lost)', async () => {
    const key = { userId: 1000 };
    const map = new Map([[key, 'data in map']]);

    // Serialize them separately
    const intermediateMap = preprocess(map);
    const intermediateKey = preprocess(key);

    // Restore them separately
    const restoredMap = postprocess(intermediateMap);
    const restoredKey = postprocess(intermediateKey);

    // ❌ Identity lost - different serialization contexts
    expect(restoredMap.get(restoredKey)).toBeUndefined();
    
    // But the key from the map still works
    const restoredKeys = Array.from(restoredMap.keys());
    expect(restoredMap.get(restoredKeys[0])).toBe('data in map');
    
    // They're different objects
    expect(restoredKey === restoredKeys[0]).toBe(false);
  });

  it('Multiple objects referencing same Map key', async () => {
    const sharedKey = { category: 'admin' };
    const data = {
      map1: new Map([[sharedKey, 'value1']]),
      map2: new Map([[sharedKey, 'value2']]),
      explicitKey: sharedKey
    };

    const cloned = parse(stringify(data));

    // All three should reference the same object
    const key1 = Array.from(cloned.map1.keys())[0];
    const key2 = Array.from(cloned.map2.keys())[0];
    
    expect(key1 === key2).toBe(true);
    expect(key1 === cloned.explicitKey).toBe(true);
    expect(key2 === cloned.explicitKey).toBe(true);

    // All should work for lookups
    expect(cloned.map1.get(cloned.explicitKey)).toBe('value1');
    expect(cloned.map2.get(cloned.explicitKey)).toBe('value2');
  });

  it('Multiple Sets sharing same object value', async () => {
    const sharedValue = { id: 42 };
    const data = {
      set1: new Set([sharedValue]),
      set2: new Set([sharedValue]),
      explicitValue: sharedValue
    };

    const cloned = parse(stringify(data));

    // All three should reference the same object
    const val1 = Array.from(cloned.set1)[0];
    const val2 = Array.from(cloned.set2)[0];
    
    expect(val1 === val2).toBe(true);
    expect(val1 === cloned.explicitValue).toBe(true);
    
    // All should work for membership checks
    expect(cloned.set1.has(cloned.explicitValue)).toBe(true);
    expect(cloned.set2.has(cloned.explicitValue)).toBe(true);
  });
});

