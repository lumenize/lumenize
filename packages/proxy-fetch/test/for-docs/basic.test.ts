import { test, expect, vi } from 'vitest';
// @ts-expect-error - cloudflare:test types not available at compile time
import { env } from 'cloudflare:test';

test('handler gets called back when fetch succeeds', async () => {
  // Get the DO instance
  const id = env.MY_DO.idFromName('doc-test-1');
  const stub = env.MY_DO.get(id);

  // Call the business process
  const reqId = await stub.myBusinessProcess();
  
  expect(reqId).toBeDefined();
  expect(typeof reqId).toBe('string');

  // Wait for the callback to be delivered
  await vi.waitFor(async () => {
    const callbackReceived = await stub.getCallbackReceived();
    expect(callbackReceived).toBe(reqId);
  }, { timeout: 3000 });
});
