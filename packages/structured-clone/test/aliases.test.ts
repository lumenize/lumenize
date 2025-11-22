/**
 * Alias tests - same object referenced via different paths (no cycles)
 * 
 * Cycles are already well-tested in core.test.ts (A→B→A patterns).
 * This file focuses on alias scenarios where the same object appears
 * at different paths without forming cycles.
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse } from '../src/index.js';

describe('Object Aliases', () => {
  it('handles multiple paths to same object (true aliases)', async () => {
    const shared = {
      id: 999,
      data: 'shared-value'
    };
    
    const obj = {
      a: { ref: shared },
      b: { ref: shared },
      c: shared, // Direct reference
      list: [shared, shared] // Multiple times in array
    };
    
    const result = parse(await stringify(obj));
    
    // All references should point to the same object
    expect(result.a.ref).toBe(result.b.ref);
    expect(result.a.ref).toBe(result.c);
    expect(result.a.ref).toBe(result.list[0]);
    expect(result.a.ref).toBe(result.list[1]);
    
    // Verify the shared object has correct properties
    expect(result.a.ref.id).toBe(999);
    expect(result.a.ref.data).toBe('shared-value');
    
    // Modifying one should affect all (they're the same object)
    result.a.ref.id = 888;
    expect(result.b.ref.id).toBe(888);
    expect(result.c.id).toBe(888);
    expect(result.list[0].id).toBe(888);
    expect(result.list[1].id).toBe(888);
  });

  it('handles shared subtree aliases', async () => {
    const shared = {
      config: {
        theme: 'dark',
        language: 'en',
        settings: {
          notifications: true,
          sound: false
        }
      },
      metadata: {
        version: '1.0.0',
        timestamp: new Date('2024-01-01')
      }
    };
    
    const obj = {
      user1: {
        profile: shared,
        preferences: shared.config
      },
      user2: {
        profile: shared,
        preferences: shared.config
      },
      system: {
        defaultConfig: shared.config
      }
    };
    
    const result = parse(await stringify(obj));
    
    // All users should share the same profile object
    expect(result.user1.profile).toBe(result.user2.profile);
    
    // All should share the same config object
    expect(result.user1.preferences).toBe(result.user2.preferences);
    expect(result.user1.preferences).toBe(result.system.defaultConfig);
    
    // Modifying shared config should affect all
    result.user1.preferences.theme = 'light';
    expect(result.user2.preferences.theme).toBe('light');
    expect(result.system.defaultConfig.theme).toBe('light');
    
    // Verify nested shared subtree
    expect(result.user1.profile.config).toBe(result.user1.preferences);
  });

  it('handles aliases at different nesting levels', async () => {
    const shared = { id: 42, value: 'shared' };
    
    const obj = {
      level1: {
        level2: {
          deep: shared
        },
        direct: shared
      },
      topLevel: shared
    };
    
    const result = parse(await stringify(obj));
    
    // All paths should reference the same object
    expect(result.level1.level2.deep).toBe(result.level1.direct);
    expect(result.level1.level2.deep).toBe(result.topLevel);
    
    // Modify via one path, verify all see the change
    result.level1.level2.deep.id = 100;
    expect(result.level1.direct.id).toBe(100);
    expect(result.topLevel.id).toBe(100);
  });

  it('handles aliases with arrays containing same object multiple times', async () => {
    const shared = { tag: 'shared', count: 0 };
    
    const obj = {
      items: [shared, shared, shared],
      metadata: {
        first: shared,
        last: shared
      }
    };
    
    const result = parse(await stringify(obj));
    
    // All array entries should be the same object
    expect(result.items[0]).toBe(result.items[1]);
    expect(result.items[1]).toBe(result.items[2]);
    expect(result.items[0]).toBe(result.metadata.first);
    expect(result.items[0]).toBe(result.metadata.last);
    
    // Modify via one reference
    result.items[0].count = 5;
    expect(result.items[1].count).toBe(5);
    expect(result.items[2].count).toBe(5);
    expect(result.metadata.first.count).toBe(5);
    expect(result.metadata.last.count).toBe(5);
  });
});

describe('Map/Set Aliases', () => {
  it('handles same object as Map values', async () => {
    const shared = { id: 1, data: 'shared' };
    
    const map = new Map<string, { id?: number; data?: string; other?: string }>([
      ['key1', shared],
      ['key2', shared],
      ['key3', { other: 'value' }]
    ]);
    
    const result = parse(await stringify(map));
    
    // Same object should be aliased
    expect(result.get('key1')).toBe(result.get('key2'));
    expect(result.get('key1')).not.toBe(result.get('key3'));
    
    // Modify via one key
    result.get('key1').id = 999;
    expect(result.get('key2').id).toBe(999);
  });

  it('handles same object as Map keys', async () => {
    const keyObj = { id: 'key', type: 'object' };
    
    const map = new Map();
    map.set(keyObj, 'first');
    map.set(keyObj, 'updated'); // Same key object
    
    const result = parse(await stringify(map));
    
    // Should have one entry with updated value
    expect(result.size).toBe(1);
    const keys = Array.from(result.keys());
    expect(keys.length).toBe(1);
    expect(result.get(keys[0])).toBe('updated');
  });

  it('handles same object in Set', async () => {
    const shared = { id: 1, value: 'shared' };
    
    const set = new Set([shared, shared, { other: true }]);
    
    const result = parse(await stringify(set));
    
    // Should have 2 unique items (shared appears twice but is one object)
    expect(result.size).toBe(2);
    
    const values = Array.from(result);
    // Find the shared object
    const sharedValue = values.find((v: any) => v && v.id === 1) as { id: number; value: string } | undefined;
    expect(sharedValue).toBeDefined();
    expect(sharedValue!.id).toBe(1);
  });

  it('handles complex alias scenario with Map containing shared objects', async () => {
    const shared = { config: { theme: 'dark' } };
    
    const map = new Map<string, { settings?: { theme: string }; config?: { theme: string } }>([
      ['user1', { settings: shared.config }],
      ['user2', { settings: shared.config }],
      ['shared', shared]
    ]);
    
    const result = parse(await stringify(map));
    
    // All should reference same config
    expect(result.get('user1').settings).toBe(result.get('user2').settings);
    expect(result.get('user1').settings).toBe(result.get('shared').config);
    
    // Modify shared config
    result.get('user1').settings.theme = 'light';
    expect(result.get('user2').settings.theme).toBe('light');
    expect(result.get('shared').config.theme).toBe('light');
  });
});

describe('Error Aliases', () => {
  it('handles shared Error cause', async () => {
    const rootCause = new Error('Root cause') as any;
    rootCause.code = 'ROOT_ERROR';
    
    const error1 = new Error('First error', { cause: rootCause });
    const error2 = new Error('Second error', { cause: rootCause });
    
    const obj = {
      errors: [error1, error2],
      root: rootCause
    };
    
    const result = parse(await stringify(obj));
    
    // Both errors should share the same cause
    expect(result.errors[0].cause).toBe(result.errors[1].cause);
    expect(result.errors[0].cause).toBe(result.root);
    
    // Modify shared cause
    result.errors[0].cause.code = 'UPDATED';
    expect(result.errors[1].cause.code).toBe('UPDATED');
    expect(result.root.code).toBe('UPDATED');
  });

  it('handles Error with custom properties that are aliased', async () => {
    const sharedMetadata = { source: 'api', timestamp: Date.now() };
    
    const error1 = new Error('Error 1');
    (error1 as any).metadata = sharedMetadata;
    
    const error2 = new Error('Error 2');
    (error2 as any).metadata = sharedMetadata;
    
    const obj = {
      errors: [error1, error2],
      metadata: sharedMetadata
    };
    
    const result = parse(await stringify(obj));
    
    // All should share the same metadata object
    expect(result.errors[0].metadata).toBe(result.errors[1].metadata);
    expect(result.errors[0].metadata).toBe(result.metadata);
    
    // Modify shared metadata
    result.errors[0].metadata.source = 'updated';
    expect(result.errors[1].metadata.source).toBe('updated');
    expect(result.metadata.source).toBe('updated');
  });
});

describe('Web API Aliases', () => {
  it('handles shared URL objects', async () => {
    const sharedUrl = new URL('https://api.example.com/v1/users');
    
    const obj = {
      endpoint: sharedUrl,
      config: {
        baseUrl: sharedUrl,
        apiUrl: sharedUrl
      }
    };
    
    const result = parse(await stringify(obj));
    
    // All should reference the same URL
    expect(result.endpoint).toBe(result.config.baseUrl);
    expect(result.endpoint).toBe(result.config.apiUrl);
    
    // Modify via one reference (should affect all since they're the same object)
    result.endpoint.searchParams.set('page', '1');
    expect(result.config.baseUrl.searchParams.get('page')).toBe('1');
    expect(result.config.apiUrl.searchParams.get('page')).toBe('1');
  });

  it('handles shared Headers objects', async () => {
    const sharedHeaders = new Headers({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer token123'
    });
    
    const obj = {
      request: {
        headers: sharedHeaders
      },
      response: {
        headers: sharedHeaders
      },
      defaultHeaders: sharedHeaders
    };
    
    const result = parse(await stringify(obj));
    
    // All should reference the same Headers object
    expect(result.request.headers).toBe(result.response.headers);
    expect(result.request.headers).toBe(result.defaultHeaders);
    
    // Modify via one reference
    result.request.headers.set('X-Custom', 'value');
    expect(result.response.headers.get('X-Custom')).toBe('value');
    expect(result.defaultHeaders.get('X-Custom')).toBe('value');
  });
});

describe('Complex Alias Scenarios', () => {
  it('handles large shared subtree with multiple alias points', async () => {
    const sharedSubtree = {
      config: {
        api: {
          endpoint: 'https://api.example.com',
          timeout: 5000
        },
        ui: {
          theme: 'dark',
          language: 'en'
        }
      },
      metadata: {
        version: '1.0.0',
        build: '12345'
      }
    };
    
    const obj = {
      user1: {
        settings: sharedSubtree.config,
        meta: sharedSubtree.metadata
      },
      user2: {
        settings: sharedSubtree.config,
        meta: sharedSubtree.metadata
      },
      system: {
        defaultApi: sharedSubtree.config.api,
        defaultUi: sharedSubtree.config.ui,
        versionInfo: sharedSubtree.metadata
      },
      global: {
        subtree: sharedSubtree
      }
    };
    
    const result = parse(await stringify(obj));
    
    // Verify all alias relationships
    expect(result.user1.settings).toBe(result.user2.settings);
    expect(result.user1.settings).toBe(result.global.subtree.config);
    expect(result.system.defaultApi).toBe(result.user1.settings.api);
    expect(result.system.defaultUi).toBe(result.user1.settings.ui);
    expect(result.user1.meta).toBe(result.system.versionInfo);
    
    // Modify via deep path
    result.system.defaultApi.timeout = 10000;
    expect(result.user1.settings.api.timeout).toBe(10000);
    expect(result.user2.settings.api.timeout).toBe(10000);
    expect(result.global.subtree.config.api.timeout).toBe(10000);
  });

  it('handles aliases mixed with cycles', async () => {
    const shared = { id: 1, data: 'shared' };
    
    const cyclic1: any = { name: 'obj1' };
    const cyclic2: any = { name: 'obj2' };
    cyclic1.ref = cyclic2;
    cyclic2.ref = cyclic1; // Cycle: obj1 → obj2 → obj1
    
    const obj = {
      shared: shared,
      cyclic: cyclic1,
      alsoShared: shared,
      alsoCyclic: cyclic1 // Alias to cyclic structure
    };
    
    const result = parse(await stringify(obj));
    
    // Verify aliases
    expect(result.shared).toBe(result.alsoShared);
    
    // Verify cycle
    expect(result.cyclic).toBe(result.alsoCyclic);
    expect(result.cyclic.ref.ref).toBe(result.cyclic); // Cycle preserved
    
    // Verify shared object
    result.shared.id = 999;
    expect(result.alsoShared.id).toBe(999);
  });

  it('handles aliases in nested Map/Set structures', async () => {
    const shared = { config: { value: 42 } };
    
    const outerMap = new Map<string, Map<string, { value: number }> | Set<{ value: number }>>([
      ['map1', new Map([['key', shared.config]])],
      ['map2', new Map([['key', shared.config]])],
      ['set1', new Set([shared.config])],
      ['set2', new Set([shared.config])]
    ]);
    
    const result = parse(await stringify(outerMap)) as Map<string, Map<string, { value: number }> | Set<{ value: number }>>;
    
    // All should reference the same config
    const map1Config = (result.get('map1') as Map<string, { value: number }>).get('key')!;
    const map2Config = (result.get('map2') as Map<string, { value: number }>).get('key')!;
    const set1Config = Array.from(result.get('set1') as Set<{ value: number }>)[0];
    const set2Config = Array.from(result.get('set2') as Set<{ value: number }>)[0];
    
    expect(map1Config).toBe(map2Config);
    expect(map1Config).toBe(set1Config);
    expect(map1Config).toBe(set2Config);
    
    // Modify via one path
    map1Config.value = 100;
    expect(map2Config.value).toBe(100);
    expect(set1Config.value).toBe(100);
    expect(set2Config.value).toBe(100);
  });
});

describe('Performance - Large Aliased Structures', () => {
  it('handles large shared subtree efficiently', async () => {
    // Create a large shared object
    const largeShared: any = {
      data: Array.from({ length: 1000 }, (_, i) => ({ id: i, value: `item-${i}` })),
      metadata: {
        created: new Date(),
        tags: Array.from({ length: 100 }, (_, i) => `tag-${i}`)
      }
    };
    
    // Reference it many times
    const obj: any = {};
    for (let i = 0; i < 100; i++) {
      obj[`ref${i}`] = largeShared;
    }
    
    const start = performance.now();
    const result = parse(await stringify(obj));
    const duration = performance.now() - start;
    
    // All references should point to the same object
    expect(result.ref0).toBe(result.ref99);
    expect(result.ref0).toBe(result.ref50);
    
    // Verify shared data
    expect(result.ref0.data.length).toBe(1000);
    expect(result.ref0.metadata.tags.length).toBe(100);
    
    // Should complete reasonably quickly (shared data stored once, not duplicated)
    expect(duration).toBeLessThan(1000); // Should be < 1 second
  });
});

