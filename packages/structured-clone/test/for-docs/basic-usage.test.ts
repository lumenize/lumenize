/**
 * Pedagogical examples for basic usage documentation
 * Clear variable names, simple assertions, teaching-focused
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse } from '../../src/index.js';

describe('Basic Serialization', () => {
  it('serializes and deserializes simple objects', async () => {
    const user = {
      name: 'Alice',
      age: 30,
      active: true
    };
    
    const serialized = await stringify(user);
    const restored = parse(serialized);
    
    expect(restored).toEqual(user);
  });

  it('handles arrays and nested structures', async () => {
    const data = {
      users: ['Alice', 'Bob', 'Charlie'],
      metadata: {
        count: 3,
        timestamp: Date.now()
      }
    };
    
    const restored = parse(await stringify(data));
    
    expect(restored.users).toEqual(['Alice', 'Bob', 'Charlie']);
    expect(restored.metadata.count).toBe(3);
  });
});

describe('Complex Types', () => {
  it('preserves Dates', async () => {
    const event = {
      title: 'Meeting',
      scheduledFor: new Date('2025-06-15T10:00:00Z')
    };
    
    const restored = parse(await stringify(event));
    
    expect(restored.scheduledFor).toBeInstanceOf(Date);
    expect(restored.scheduledFor.toISOString()).toBe('2025-06-15T10:00:00.000Z');
  });

  it('preserves Maps and Sets', async () => {
    const cache = new Map([
      ['key1', 'value1'],
      ['key2', 'value2']
    ]);
    const tags = new Set(['javascript', 'typescript', 'cloudflare']);
    
    const data = { cache, tags };
    const restored = parse(await stringify(data));
    
    expect(restored.cache).toBeInstanceOf(Map);
    expect(restored.cache.get('key1')).toBe('value1');
    expect(restored.tags).toBeInstanceOf(Set);
    expect(restored.tags.has('typescript')).toBe(true);
  });
});

describe('Special Numbers', () => {
  it('handles NaN and Infinity', async () => {
    const stats = {
      average: NaN,
      maximum: Infinity,
      minimum: -Infinity
    };
    
    const restored = parse(await stringify(stats));
    
    expect(restored.average).toBeNaN();
    expect(restored.maximum).toBe(Infinity);
    expect(restored.minimum).toBe(-Infinity);
  });
});

describe('Circular References', () => {
  it('handles circular object references', async () => {
    const node: any = {
      id: 1,
      data: 'root'
    };
    node.self = node;
    
    const restored: any = parse(await stringify(node));
    
    expect(restored.id).toBe(1);
    expect(restored.self).toBe(restored);
  });
});

