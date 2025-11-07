/**
 * Debug test to understand Map/Set identity issue
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, createHttpTransport, lumenizeRpcDO } from '../src/index';
import { DurableObject } from 'cloudflare:workers';

class DebugDO extends DurableObject {
  getMapWithKey() {
    const key = { userId: 123 };
    const map = new Map([[key, 'value']]);
    const result = { map, key };
    
    console.log('SERVER: Creating result');
    console.log('SERVER: map.get(key):', map.get(key));
    console.log('SERVER: key === map keys[0]:', key === Array.from(map.keys())[0]);
    
    return result;
  }
}

const DebugDOWithRpc = lumenizeRpcDO(DebugDO);
export { DebugDOWithRpc };

export default {
  async fetch() {
    return new Response('Debug worker');
  },
};

describe('Debug Map Identity', () => {
  it('debugs what happens to identity', async () => {
    const id = (SELF as any).DEBUG_DO.idFromName('debug');
    const transport = createHttpTransport('debug-do', id.toString(), {
      baseUrl: 'https://fake-host.com',
      prefix: '__rpc',
      fetch: SELF.fetch.bind(SELF),
    });
    const client = createRpcClient({ transport });
    
    const result = await (client as any).getMapWithKey();
    
    console.log('\nCLIENT: Received result');
    console.log('CLIENT: map type:', result.map.constructor.name);
    console.log('CLIENT: key type:', typeof result.key, result.key);
    console.log('CLIENT: map.get(key):', result.map.get(result.key));
    console.log('CLIENT: key === map keys[0]:', result.key === Array.from(result.map.keys())[0]);
    
    const keys = Array.from(result.map.keys());
    console.log('CLIENT: Map keys:', keys);
    console.log('CLIENT: result.key:', result.key);
    console.log('CLIENT: Are they ===:', result.key === keys[0]);
    
    expect(result.map.get(result.key)).toBe('value');
  });
});

