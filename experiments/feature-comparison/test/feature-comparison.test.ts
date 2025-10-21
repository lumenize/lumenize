/*
# Feature Comparison: Lumenize RPC vs Cap'n Web

This living documentation compares how Lumenize RPC and Cap'n Web (Cloudflare's 
official RPC solution) handle various features and patterns. Many sections
demonstrates both approaches side-by-side with focus on developer experience (DX) 
differences.

Further down, we show features that Cap'n Web has but Lumenize RPC does not, and
after that, we show features that Lumenize RPC has that Cap'n Web does not.

## References

- Cap'n Web blog post: https://blog.cloudflare.com/capnweb-javascript-rpc-library/
- Cap'n Web GitHub: https://github.com/cloudflare/capnweb
- Lumenize RPC docs: https://lumenize.com/docs/rpc/introduction
*/

import { it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim } from '@lumenize/rpc';
import { newWebSocketRpcSession } from 'capnweb';

import { LumenizeDO, CapnWebRpcTarget } from '../src/index';

/*
## Feature: Simple method call

Both have about the same amount of boilerplate for a simple method call
*/
it('demonstrates a simple method call', async () => {
  // ============================================================================
  // Lumenize RPC
  // ============================================================================
  await using lumenizeClient = createRpcClient<typeof LumenizeDO>(
    'LUMENIZE',
    'method-call',
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );
  expect(await lumenizeClient.increment()).toBe(1);

  // ============================================================================
  // Cap'n Web
  // ============================================================================
  const capnwebUrl = 'wss://test.com/capnweb/capnweb/method-call';
  const capnwebWs = new (getWebSocketShim(SELF.fetch.bind(SELF)))(capnwebUrl);
  await using capnwebClient = newWebSocketRpcSession<CapnWebRpcTarget>(capnwebWs);
  expect(await capnwebClient.increment()).toBe(1);
});

/*
## Feature: Error handling and stack traces

**Lumenize RPC**:
- ✅ Preserves error message, name, and stack trace
- ✅ Re-throws on client side with full context
- ✅ Stack trace shows original server-side location

**Cap'n Web**:
- ✅ Error message is preserved
- ❌ Stack trace shows RPC machinery, not original throw location
*/
it('demonstrates error handling', async () => {
  // ============================================================================
  // Lumenize RPC
  // ============================================================================
  await using lumenizeClient = createRpcClient<typeof LumenizeDO>(
    'LUMENIZE',
    'error-test',
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );

  try {
    await lumenizeClient.throwError();
    expect.fail('Should have thrown an error');
  } catch (error: any) {
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Intentional error from Lumenize DO');
    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('throwError');
  }

  // ============================================================================
  // Cap'n Web
  // ============================================================================
  const capnwebUrl = 'wss://test.com/capnweb/capnweb/error-test';
  const capnwebWs = new (getWebSocketShim(SELF.fetch.bind(SELF)))(capnwebUrl);
  await using capnwebClient = newWebSocketRpcSession<CapnWebRpcTarget>(capnwebWs);

  try {
    await capnwebClient.throwError();
    expect.fail('Should have thrown an error');
  } catch (error: any) {
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Intentional error from Cap\'n Web RpcTarget');
    expect(error.stack).toBeDefined();
    // Stack shows RPC internals, not the original throwError() location
    expect(error.stack).not.toContain('throwError');
  }
});

/*
## Feature: RPC Client Access to `ctx` and `env`

**Lumenize RPC**:
- ✅ **Full client access**: `client.ctx.storage.kv.put('key', 'value')`
- ✅ **Full client access to env**: `client.env.SOME_BINDING.getByName()`
- ✅ No custom methods needed for storage/state access

**Cap'n Web**:
- ❌ **No client access to `ctx`** - Must write custom methods
- ❌ **No client access to `env`** - Must write custom methods
- ⚠️ Every storage operation requires a custom DO method
*/
it('demonstrates RPC client access to ctx and env', async () => {
  // ============================================================================
  // Lumenize RPC
  // ============================================================================
  await using lumenizeClient = createRpcClient<typeof LumenizeDO>(
    'LUMENIZE',
    'ctx-access',
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );

  // ✅ Lumenize RPC: Direct client access to ctx.storage!
  await lumenizeClient.ctx.storage.put('direct-key', 'direct-value');
  const directValue = await lumenizeClient.ctx.storage.get('direct-key');
  expect(directValue).toBe('direct-value');
  
  // ✅ Access to env and hopping to another instance
  const anotherInstance = await lumenizeClient.env.LUMENIZE.getByName('another-instance');
  expect(anotherInstance.name).toBe('another-instance');
  
  // ✅ You can still call custom methods if you want
  expect(await lumenizeClient.increment()).toBe(1);

  // ============================================================================
  // Cap'n Web
  // ============================================================================
  const capnwebUrl = 'wss://test.com/capnweb/capnweb/ctx-access';
  const capnwebWs = new (getWebSocketShim(SELF.fetch.bind(SELF)))(capnwebUrl);
  await using capnwebClient = newWebSocketRpcSession<CapnWebRpcTarget>(capnwebWs);

  // ❌ Trying to use ctx.storage will fail
  const capnCtx: any = capnwebClient.ctx;
  await expect(async () => {
    await capnCtx.storage.put('direct-key', 'direct-value');
    const directValue = await capnCtx.storage.get('direct-key');
    expect(directValue).toBe('direct-value');
  }).rejects.toThrow();

  // ❌ Trying to use env will also fail
  const capnEnv = (capnwebClient as any).env;
  await expect(async () => {
    const anotherInstance = await capnEnv.CAPNWEB.getByName('another-instance');
    expect(anotherInstance.name).toBe('another-instance');
  }).rejects.toThrow();
  
  // You MUST write a custom method like increment() to access storage
  expect(await capnwebClient.increment()).toBe(1);
});

/*
## Installation

```bash npm2yarn
npm install --save-dev vitest@3.2
npm install --save-dev @vitest/coverage-istanbul@3.2
npm install --save-dev @cloudflare/vitest-pool-workers
npm install --save-dev @lumenize/rpc
npm install --save-dev @lumenize/utils
npm install --save-dev capnweb
```

## Configuration Files

### src/index.ts

Worker, DurableObjects and RpcTargets

@import {typescript} "../src/index.ts" [src/index.ts]

### wrangler.jsonc

@import {json} "../wrangler.jsonc" [wrangler.jsonc]

### vitest.config.js

@import {javascript} "../vitest.config.js" [vitest.config.js]

### tsconfig.json

@import {json} "../tsconfig.json" [tsconfig.json]

## Try it out

To run these examples:
```bash
vitest --run
```

To see test coverage:
```bash
vitest --run --coverage
```
*/