import { describe, test, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { ProxyFetchDO, TestDO } from './test-worker';

describe('ProxyFetchDO Infrastructure', () => {
  test('can instantiate ProxyFetchDO', () => {
    const id = env.PROXY_FETCH_DO.idFromName('test-instance');
    const stub = env.PROXY_FETCH_DO.get(id);
    expect(stub).toBeDefined();
  });

  test('can instantiate TestDO', () => {
    const id = env.TEST_DO.idFromName('test-do');
    const stub = env.TEST_DO.get(id);
    expect(stub).toBeDefined();
  });
});
