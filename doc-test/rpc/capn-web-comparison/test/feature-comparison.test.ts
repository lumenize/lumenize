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
# vs Cap'n Web (basics and types)

This living documentation compares how Lumenize RPC and Cap'n Web (Cloudflare's
official "last-mile" RPC solution) handle basic usage and supported types.

It was produced using the latest versions as of 2025-10-22:
- Cap'n Web v0.1.0
- Lumenize RPC v0.10.0

Using this doc-test approach, when either package adds capability, we'll
know immediately because the tests will start failing as soon as we upgrade
to the latest version.

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
// Create clients - Similar amount of boilerplate
// =============================================================================

// Most of this is for vitest-workers-pool. In production, this would be as 
// simple as:
// ```ts
// const client = createRpcClient<typeof LumenizeDO>('LUMENIZE', 'name');
// ```
function getLumenizeClient(instanceName: string) {
  return createRpcClient<typeof LumenizeDO>(
    'LUMENIZE',
    instanceName,
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );
}

// Similarly, some of this is for vitest-workers-pool. In production, this 
// would be as simple as:
// ```ts
// const url = `wss://test.com/capnweb/capnweb/name`;
// const client = newWebSocketRpcSession<CapnWebRpcTarget>(url);
// ```
function getCapnWebClient(instanceName: string) {
  const url = `wss://test.com/capnweb/capnweb/${instanceName}`;
  const ws = new (getWebSocketShim(SELF.fetch.bind(SELF)))(url);
  return newWebSocketRpcSession<CapnWebRpcTarget>(ws);
}

/*
## Simple method call

Simple method calls are exactly the same.
*/
it('demonstrates a simple method call', async () => {
  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('method-call');
  expect(await lumenizeClient.increment()).toBe(1);

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  using capnwebClient = getCapnWebClient('method-call');
  expect(await capnwebClient.increment()).toBe(1);
});

/*
## RPC Client Access to `ctx` and `env`

It may be possible to access properties like `ctx` and `env` via 
Cap'n Web, but we couldn't find any documentation or examples showing how,
and trying the obvious approaches didn't work. If anyone knows whether and how 
this can be done with Cap'n Web, please let us know and we'll immediately 
update this document. 

If our understanding is correct, this is the biggest usage difference between 
Cap'n Web and Lumenize RPC.

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
  using lumenizeClient = getLumenizeClient('ctx-access');

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
  using capnwebClient = getCapnWebClient('ctx-access');

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
  
  // ⚠️ You MUST write a custom method like increment() to access storage
  expect(await capnwebClient.increment()).toBe(1);
});

/*
## Supported Types

This table shows DO Storage support first (the foundation), then how each RPC 
framework measures up to that standard.

**Key insight**: Lumenize RPC supports everything that Durable Object storage 
(SQLite engine) supports, plus a few additional types. Cap'n Web's limited 
type support is a significant foot-gun. If that improves over time, we'll 
update this table.

| Type | DO Storage | Lumenize RPC | Cap'n Web | Notes |
|------|------------|--------------|-----------|-------|
| **Primitives** | | | | |
| undefined | ✅ | ✅ | ✅ | |
| null | ✅ | ✅ | ✅ | |
| **Special Numbers** | | | | |
| NaN | ✅ | ✅ | ❌ | Cap'n Web returns null |
| Infinity | ✅ | ✅ | ❌ | Cap'n Web returns null |
| -Infinity | ✅ | ✅ | ❌ | Cap'n Web returns null |
| **Built-in Types** | | | | |
| BigInt | ✅ | ✅ | ✅ | |
| Date | ✅ | ✅ | ✅ | |
| RegExp | ✅ | ✅ | ❌ | |
| Map | ✅ | ✅ | ❌ | |
| Set | ✅ | ✅ | ❌ | |
| ArrayBuffer | ✅ | ✅ | ❌ | |
| Uint8Array | ✅ | ✅ | ✅ | |
| **Errors** | | | | |
| Error (thrown) | N/A | ✅ | ⚠️ | Cap'n Web loses name and remote stack |
| Error (value) | ⚠️ | ✅ | ⚠️ | Cap'n Web loses name and remote stack |
| **Circular References** | ✅ | ✅ | ❌ | Cap'n Web throws error |
| **Web API Types** | | | | |
| Request | ❌ | ✅ | ❌ | |
| Response | ❌ | ✅ | ❌ | |
| Headers | ✅ | ✅ | ❌ | |
| URL | ❌ | ✅ | ❌ | |
| ReadableStream | ❌ | ❌ | ❌ | Cap'n Web: "may be added" |
| WritableStream | ❌ | ❌ | ❌ | Lumenize: "just use WebSockets" |

For comprehensive type support testing, see the [behavior test suite](https://github.com/lumenize/lumenize/blob/main/packages/rpc/test/shared/behavior-tests.ts).
*/

/*
## Error handling (thrown)

A significant DX concern is getting useful information from thrown Errors.

Lumenize RPC doesn't reconstitute custom Error types over the wire,
but it automatically sets the name property to the custom Error type's 
identifier and sends the server-side stack trace for use on the client side.

Cap'n Web preserves the server-side message, but the name is lost
and the stack trace shows Cap'n Web internals on the client side.

**Lumenize RPC**: ✅ Preserves name, message, and remote stack trace  
**Cap'n Web**: ⚠️ Preserves message only, loses name and remote stack
*/
it('demonstrates error throwing', async () => {
  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('error-throw');
  try {
    await lumenizeClient.throwError();
    expect.fail('should not reach');
  } catch (e: any) {
    expect(e.message).toContain('Intentional error'); // ✅
    expect(e.stack).toContain('throwError'); // ✅ Actual remote stack
  }

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  using capnwebClient = getCapnWebClient('error-throw');
  try {
    await capnwebClient.throwError();
    expect.fail('should not reach');
  } catch (e: any) {
    expect(e.message).toContain('Intentional error'); // ✅
    expect(e.stack).not.toContain('throwError'); // ❌ Local RPC internals
  }
});

/*
## Error as value

**Lumenize RPC**: ✅ Error type (name), message, and stack all preserved  
**Cap'n Web**: ❌ Loses error type (name), stack shows RPC internals not origin  
**Both**: ⚠️ Loses prototype, but name can be used as a substitute for Lumenize
*/
it('demonstrates error as value', async () => {
  class CustomError extends Error {}
  const testError = new CustomError('Test error');

  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('error-value');
  const lumenizeResult = await lumenizeClient.echo(testError);
  expect(lumenizeResult.message).toBe('Test error'); // ✅
  expect(lumenizeResult).toBeInstanceOf(Error); // ✅
  expect(lumenizeResult).not.toBeInstanceOf(CustomError); // ❌
  // ✅ But name is automatically set and preserved
  expect(lumenizeResult.name).toBe('CustomError');
  // ✅ Original stack preserved
  expect(lumenizeResult.stack).toContain('feature-comparison.test.ts');

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  using capnwebClient = getCapnWebClient('error-value');
  // @ts-ignore Typescript thinks next line has an infinite recursion problem
  const capnwebResult = await capnwebClient.echo(testError);
  expect(capnwebResult.message).toBe('Test error'); // ✅
  expect(capnwebResult).toBeInstanceOf(Error); // ✅
  expect(capnwebResult).not.toBeInstanceOf(CustomError); // ❌
  expect(capnwebResult.name).not.toBe('CustomError'); // ❌ Lost CustomError name
  expect(capnwebResult.stack).toContain('_Evaluator'); // ❌ RPC internals
});

/*
## Circular references and aliases

**Lumenize RPC**: ✅ Handles circular references correctly  
**Cap'n Web**: ❌ Throws "DataCloneError: The object could not be cloned"

Most disappointing to us at Lumenize regarding supported types is that Cap'n 
Web does not and will not ever support cyclic values or aliases. Our core 
product uses directed acyclic graphs (DAG) with heavy use of aliases. 
Refactoring to a nodes + edges data structure is not workable for us.

We have often considered moving our intra-Cloudflare transport to Workers RPC,
but those discussions have stopped because of this statement from the 
Workers RPC documentation:

> Workers RPC supports sending values that contain aliases and cycles. This can actually cause problems, so we actually **plan to remove this feature from Workers RPC** (with a compatibility flag, of course) [emphasis added].
*/
it('demonstrates circular references', async () => {
  const circular: any = { name: 'root' };
  circular.self = circular;

  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('circular');
  const lumenizeResult = await lumenizeClient.echo(circular);
  expect(lumenizeResult).toEqual(circular); // ✅

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  using capnwebClient = getCapnWebClient('circular');
  let capnwebThrew = false;
  try {
    await capnwebClient.echo(circular);
  } catch (e) {
    capnwebThrew = true;
  }
  expect(capnwebThrew).toBe(true); // ❌
});

/*
## Web API types (Request, Response, Headers, URL)

The main use case for this capability is offloading external HTTP fetches 
from a Durable Object (where you're billed on wall clock time) to a Worker 
(where you're billed on CPU time). We have on our roadmap to release
`@lumenize/proxy-fetch`, a package that implements this offloading pattern.

This use case is one of the most common sources of repeated questions on the
#durable-objects Discord channel.

**Lumenize RPC**: ✅ Web API types work including body content  
**Cap'n Web**: ❌ Cannot serialize any Web API types
*/
it('demonstrates Web API Request support', async () => {
  const testRequest = new Request('https://example.com/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: 'test payload' })
  });

  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('request');
  const lumenizeResult = await lumenizeClient.echo(testRequest);
  expect(lumenizeResult).toBeInstanceOf(Request); // ✅
  expect(lumenizeResult.url).toBe('https://example.com/test'); // ✅
  expect(lumenizeResult.method).toBe('POST'); // ✅
  expect(await lumenizeResult.json()).toEqual({ data: 'test payload' }); // ✅

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  using capnwebClient = getCapnWebClient('request');
  let capnwebThrew = false;
  try {
    await capnwebClient.echo(testRequest);
  } catch (e) {
    capnwebThrew = true;
  }
  expect(capnwebThrew).toBe(true); // ❌
});

/*
## Standard types (primitives and built-ins)

**Lumenize RPC**: ✅ All standard types preserved correctly  
**Cap'n Web**: ⚠️ Special numbers (NaN, Infinity, -Infinity) become null
*/
it('demonstrates standard type support', async () => {
  const bigInt = 12345678901234567890n;

  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('types');
  expect(await lumenizeClient.echo(undefined)).toBeUndefined(); // ✅
  expect(await lumenizeClient.echo(null)).toBeNull(); // ✅
  expect(Number.isNaN(await lumenizeClient.echo(NaN))).toBe(true); // ✅
  expect(await lumenizeClient.echo(Infinity)).toBe(Infinity); // ✅
  expect(await lumenizeClient.echo(-Infinity)).toBe(-Infinity); // ✅
  expect(await lumenizeClient.echo(bigInt)).toBe(bigInt); // ✅

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  using capnwebClient = getCapnWebClient('types');
  expect(await capnwebClient.echo(undefined)).toBeUndefined(); // ✅
  expect(await capnwebClient.echo(null)).toBeNull(); // ✅
  expect(Number.isNaN(await capnwebClient.echo(NaN))).not.toBe(true); // ❌
  expect(await capnwebClient.echo(Infinity)).not.toBe(Infinity); // ❌
  expect(await capnwebClient.echo(-Infinity)).not.toBe(-Infinity); // ❌
  expect(await capnwebClient.echo(bigInt)).toBe(bigInt); // ✅
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