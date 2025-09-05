import { describe, test, it, expect } from 'vitest';
import {
  DurableObjectState,
  SELF,
  env,
  runInDurableObject as cf_runInDurableObject,
  createExecutionContext as cf_createExecutionContext,
// @ts-expect-error - cloudflare:test module types are not consistently recognized by VS Code
} from 'cloudflare:test';
import { MyDO } from './test-harness';

describe('Comprehensive Entity Subscription Lifecycle', () => {
  it('should ping/pong', async () => {
    const response = await SELF.fetch('https://example.com/ping');
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe('pong');
  });

  it('should work in cf_runInDurableObject', async () => {
    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    const response = await cf_runInDurableObject(stub, async (instance: MyDO, ctx: DurableObjectState) => {
      const request = new Request("https://example.com/increment");
      const response = await instance.fetch(request);
      expect(await ctx.storage.get<number>("count")).toBe(1);
      return response;
    });
    expect(await response.text()).toBe("1");
  });

  it('should error in cf_runInDurableObject', async () => {

  });

});
  