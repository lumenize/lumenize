// DOC-TEST FILE: This file generates documentation via @lumenize/doc-testing
// - Block comments (/* */) become Markdown in the docs
// - Code between block comments becomes code blocks in the docs
// - Single-line comments (//) stay in source only (not in docs)
// - Use @import directives to include external files
// - Tests must pass - they validate the documentation
// - Keep code blocks within 80 columns to prevent horizontal scrolling
// - Keep it brief - this is documentation, not exhaustive testing
//   - Use one expect() to illustrate behavior
//   - Only add more expects if the boundaries/edge cases are the point
// - See: /tooling/doc-testing/README.md

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
## Supported Types

Both frameworks support structured-cloneable types, but with differences:

| Type | Lumenize RPC | Cap'n Web | Notes |
|------|--------------|-----------|-------|
| **Primitives** | | | |
| undefined | ✅ | ✅ | |
| null | ✅ | ✅ | |
| **Special Numbers** | | | |
| NaN | ✅ | ❌ | Cap'n Web returns null |
| Infinity | ✅ | ❌ | Cap'n Web returns null |
| -Infinity | ✅ | ❌ | Cap'n Web returns null |
| **Built-in Types** | | | |
| BigInt | ✅ | ✅ | |
| Date | ✅ | ✅ | |
| RegExp | ✅ | ❌ | Cannot serialize |
| Map | ✅ | ❌ | Cannot serialize |
| Set | ✅ | ❌ | Cannot serialize |
| ArrayBuffer | ✅ | ❌ | Cannot serialize |
| TypedArray | ✅ | ✅ | Uint8Array works |
| **Errors** | | | |
| Error (thrown) | ✅ | ⚠️ | Cap'n Web: loses type, remote stack |
| Error (value) | ✅ | ⚠️ | Cap'n Web: loses type, remote stack |
| **Circular References** | ✅ | ❌ | Cap'n Web throws error |
| **Web API Types** | | | |
| Request | ✅ | ❌ | Cannot serialize |
| Response | ✅ | ❌ | Cannot serialize |
| Headers | ✅ | ❌ | Cannot serialize |
| URL | ✅ | ❌ | Cannot serialize |
| ReadableStream | ❌ | ❌ | Not yet supported |
| WritableStream | ❌ | ❌ | Not yet supported |

For comprehensive type support testing, see the [behavior test suite](https://github.com/lumenize-systems/lumenize/blob/main/packages/rpc/test/shared/behavior-tests.ts).
*/

/*
## Feature: Error handling (thrown)

**Lumenize RPC**: Preserves name, message, and remote stack trace  
**Cap'n Web**: Preserves message only, loses name and remote stack
*/
it('demonstrates error throwing', async () => {
  // Lumenize RPC - full error context preserved
  await using lumenizeClient = getLumenizeClient('error-throw');
  try {
    await lumenizeClient.throwError();
    expect.fail('should not reach');
  } catch (e: any) {
    expect(e.message).toContain('Intentional error');
    expect(e.stack).toContain('throwError'); // Actual remote stack
  }

  // Cap'n Web - only message preserved
  await using capnwebClient = getCapnWebClient('error-throw');
  try {
    await capnwebClient.throwError();
    expect.fail('should not reach');
  } catch (e: any) {
    expect(e.message).toContain('Intentional error');
    expect(e.stack).not.toContain('throwError'); // Local RPC internals
  }
});

/*
## Feature: Error as value

**Lumenize RPC**: Error type (name), message, and stack all preserved  
**Cap'n Web**: Loses error type (name), stack shows RPC internals not origin
**Both**: Loses prototype, but name can be used as a substitue for Lumenize
*/
it('demonstrates error as value', async () => {
  class CustomError extends Error {}
  const testError = new CustomError('Test error');

  // Lumenize RPC - full Error preservation
  await using lumenizeClient = getLumenizeClient('error-value');
  const lumenizeResult = await lumenizeClient.echo(testError);
  expect(lumenizeResult.message).toBe('Test error');
  expect(lumenizeResult).toBeInstanceOf(Error);
  // Prototype not preserved
  expect(lumenizeResult).not.toBeInstanceOf(CustomError);
  // But name is automatically set and preserved
  expect(lumenizeResult.name).toBe('CustomError');
  // Original stack preserved
  expect(lumenizeResult.stack).toContain('feature-comparison.test.ts');

  // Cap'n Web - Loses error type and original stack
  await using capnwebClient = getCapnWebClient('error-value');
  const capnwebResult = await capnwebClient.echo(testError);
  expect(capnwebResult.message).toBe('Test error');
  expect(capnwebResult).toBeInstanceOf(Error);
  expect(capnwebResult.name).toBe('Error'); // Lost CustomError type
  expect(capnwebResult.stack).toContain('_Evaluator'); // RPC stack
});

/*
## Feature: Circular references

**Lumenize RPC**: Handles circular references correctly  
**Cap'n Web**: Throws "DataCloneError: The object could not be cloned"
*/
it('demonstrates circular references', async () => {
  const circular: any = { name: 'root' };
  circular.self = circular;

  // Lumenize RPC - handles circular references
  await using lumenizeClient = getLumenizeClient('circular');
  const lumenizeResult = await lumenizeClient.echo(circular);
  expect(lumenizeResult.name).toBe('root');
  expect(lumenizeResult.self).toBe(lumenizeResult);

  // Cap'n Web - throws on circular references
  await using capnwebClient = getCapnWebClient('circular');
  let capnwebThrew = false;
  try {
    await capnwebClient.echo(circular);
  } catch (e) {
    capnwebThrew = true;
  }
  expect(capnwebThrew).toBe(true);
});

/*
## Feature: Web API types (Request, Response, Headers, URL)

**Lumenize RPC**: Web API types work (Request shown as example)  
**Cap'n Web**: Cannot serialize any Web API types  
**Both**: ReadableStream not yet supported
*/
it('demonstrates Web API Request support', async () => {
  const testRequest = new Request('https://example.com/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue('test');
      controller.close();
    }
  });

  // Lumenize RPC - Request fully preserved
  await using lumenizeClient = getLumenizeClient('request');
  const lumenizeResult = await lumenizeClient.echo(testRequest);
  expect(lumenizeResult).toBeInstanceOf(Request);
  expect(lumenizeResult.url).toBe('https://example.com/test');
  expect(lumenizeResult.method).toBe('POST');
  
  // ReadableStream not yet supported
  await expect(async () => {
    await lumenizeClient.echo(stream);
  }).rejects.toThrow();

  // Cap'n Web - cannot serialize Request
  await using capnwebClient = getCapnWebClient('request');
  let capnwebThrew = false;
  try {
    await capnwebClient.echo(testRequest);
  } catch (e) {
    capnwebThrew = true;
  }
  expect(capnwebThrew).toBe(true);
  
  // ReadableStream not yet supported
  await expect(async () => {
    await capnwebClient.echo(stream);
  }).rejects.toThrow();
});

/*
## Feature: Standard types (primitives and built-ins)

**Lumenize RPC**: All standard types preserved correctly  
**Cap'n Web**: Special numbers (NaN, Infinity, -Infinity) become null
*/
it('demonstrates standard type support', async () => {
  await using lumenizeClient = getLumenizeClient('types');
  await using capnwebClient = getCapnWebClient('types');
  const bigInt = 12345678901234567890n;

  // Lumenize RPC - all types work
  expect(await lumenizeClient.echo(undefined)).toBeUndefined();
  expect(await lumenizeClient.echo(null)).toBeNull();
  expect(Number.isNaN(await lumenizeClient.echo(NaN))).toBe(true);
  expect(await lumenizeClient.echo(Infinity)).toBe(Infinity);
  expect(await lumenizeClient.echo(-Infinity)).toBe(-Infinity);
  expect(await lumenizeClient.echo(bigInt)).toBe(bigInt);

  // Cap'n Web - special numbers become null
  expect(await capnwebClient.echo(undefined)).toBeUndefined();
  expect(await capnwebClient.echo(null)).toBeNull();
  expect(Number.isNaN(await capnwebClient.echo(NaN))).toBe(false);
  expect(await capnwebClient.echo(Infinity)).not.toBe(Infinity);
  expect(await capnwebClient.echo(-Infinity)).not.toBe(-Infinity);
  expect(await capnwebClient.echo(bigInt)).toBe(bigInt);
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