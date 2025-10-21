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

// =============================================================================
// Create clients - similar amount of boilerplate
// =============================================================================

function getLumenizeClient(instanceName: string) {
  return createRpcClient<typeof LumenizeDO>(
    'LUMENIZE',
    instanceName,
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );
}

function getCapnWebClient(instanceName: string) {
  const url = `wss://test.com/capnweb/capnweb/${instanceName}`;
  const ws = new (getWebSocketShim(SELF.fetch.bind(SELF)))(url);
  return newWebSocketRpcSession<CapnWebRpcTarget>(ws);
}

/*
## Feature: Simple method call

Both have a similar amount of boilerplate for a simple method call
*/
it('demonstrates a simple method call', async () => {
  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  await using lumenizeClient = getLumenizeClient('method-call');
  expect(await lumenizeClient.increment()).toBe(1);

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  await using capnwebClient = getCapnWebClient('method-call');
  expect(await capnwebClient.increment()).toBe(1);
});

/*
## Feature: Error handling and stack traces

**Lumenize RPC**:
- ✅ Re-throws on client side with full context (message, stack, etc.)
- ✅ Stack trace shows original server-side location

**Cap'n Web**:
- ✅ Throws on client side with only message preserved
- ❌ Stack trace shows RPC machinery, not original throw location
*/
it('demonstrates error handling', async () => {
  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  await using lumenizeClient = getLumenizeClient('error');

  await expect(lumenizeClient.throwError())
    .rejects.toThrow('Intentional error from Lumenize DO');

  // Stack trace includes the original throwError() location
  try {
    await lumenizeClient.throwError();
    expect.fail('should not reach this point');
  } catch (e: any) {
    expect(e.stack).toContain('throwError');
  }

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  await using capnwebClient = getCapnWebClient('error');

  await expect(capnwebClient.throwError())
    .rejects.toThrow('Intentional error from Cap\'n Web RpcTarget');

  // Stack trace shows only RPC internals, not throwError()
  try {
    await capnwebClient.throwError();
    expect.fail('should not reach this point');
  } catch (e: any) {
    expect(e.stack).not.toContain('throwError');
  }
});

/*
## Feature: Returning complex objects like Request

**Lumenize RPC**:
- ⚠️ Serializes Request objects, losing prototype but preserving data
- ✅ Clients receive plain objects with Request properties

**Cap'n Web**:
- ❌ Cannot serialize Request objects at all
- ❌ Throws "Cannot serialize value: [object Request]"
*/
it('demonstrates returning a Request object', async () => {
  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  await using lumenizeClient = getLumenizeClient('request-return');

  const lumenizeRequest = await lumenizeClient.getRequest();
  // ⚠️ Not a Request instance after serialization
  expect(lumenizeRequest).not.toBeInstanceOf(Request);
  // ✅ But the data is preserved
  expect(lumenizeRequest.url).toBe('https://example.com/test');
  expect(lumenizeRequest.method).toBe('POST');

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  await using capnwebClient = getCapnWebClient('request-return');

  // ❌ Cap'n Web throws when trying to serialize Request
  await expect(capnwebClient.getRequest()).rejects.toThrow();
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
  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  await using lumenizeClient = getLumenizeClient('ctx-access');

  // ✅ Lumenize RPC: Direct client access to ctx.storage!
  await lumenizeClient.ctx.storage.put('direct-key', 'direct-value');
  const directValue = await lumenizeClient.ctx.storage.get('direct-key');
  expect(directValue).toBe('direct-value');
  
  // ✅ Access to env and hopping to another instance
  const anotherInstance = await lumenizeClient.env.LUMENIZE.getByName(
    'another-instance'
  );
  expect(anotherInstance.name).toBe('another-instance');
  
  // ✅ You can still call custom methods if you want
  expect(await lumenizeClient.increment()).toBe(1);

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  await using capnwebClient = getCapnWebClient('ctx-access');

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