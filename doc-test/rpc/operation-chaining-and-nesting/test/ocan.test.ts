// DOC-TEST FILE: This file generates documentation via @lumenize/doc-testing
// - Block comments (/* */) become Markdown in the docs
// - Code between block comments becomes code blocks in the docs
// - Single-line comments (//) before the first block comment (like this one)
//   do not show up in the generated doc
// - Single-line comments (//) after that are included in the generated doc
// - Use @import directives to include external files
// - Tests must pass - they validate the documentation
// - Keep code blocks within 80 columns to prevent horizontal scrolling
// - Keep it brief - this is documentation, not exhaustive testing
//   - Use one expect() to illustrate behavior
//   - Only add more expects if the boundaries/edge cases are the point
// - See: /tooling/doc-testing/README.md

/*
# How It Works

## Operation Chaining and Nesting (OCAN)

Cloudflare uses terms like "promise pipelining" and "batching" for Cap'n Web 
optimizations. We know Lumenize RPC has some things in common, like a thenable 
Proxy, and maybe what we are doing could also fall under those terms, but we 
use **Operation Chaining and Nesting (OCAN)** to describe what Lumenize RPC is 
doing under the covers.
*/

/*
## What is OCAN?

OCAN has three complementary aspects:

1. **Operation Chaining**: Chain method calls on returned values without 
   awaiting intermediate results
   ```typescript
   client.setValue('key', 'value').uppercaseValue(...)
   ```

2. **Operation Nesting**: Use unawaited operations as arguments to other 
   operations
   ```typescript
   client.combineValues(client.getValue('a'), client.getValue('b'))
   ```

3. **Automatic Batching**: Multiple operations triggered in the same microtask 
   are automatically batched into a single request
   ```typescript
   const [a, b, c] = await Promise.all([
     client.getValue('x'),
     client.getValue('y'),
     client.getValue('z')
   ]);
   ```

Lumenize RPC builds an **operation chain** that describes the sequence and 
dependencies of your operations, then executes them in one round trip.

Let's peek under the covers to see how OCAN structures are built.
*/

/*
### Imports
*/
import { it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { 
  createRpcClient,
  createWebSocketTransport,
  setInspectMode,
  getLastBatchRequest 
} from '@lumenize/rpc';
import { getWebSocketShim } from '@lumenize/utils';
import { DataService } from '../src/index';

/*
### Version(s)

This test asserts the installed version(s) and our release script warns if we 
aren't using the latest version published to npm, so this living documentation 
should always be up to date.
*/
import lumenizeRpcPackage from '../../../../packages/rpc/package.json';
it('detects package version', () => {
  expect(lumenizeRpcPackage.version).toBe('0.14.0');
});

/*
### Operation Chaining Example

Each method call adds an operation to the chain:
*/
it('demonstrates operation chaining', async () => {
  using client = createRpcClient<typeof DataService>({
    transport: createWebSocketTransport(
      'DATA_SERVICE',
      'test-chaining',
      { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
    )
  });

  setInspectMode(true);
  
  // Build a chain by calling methods on client without awaiting
  // Each method returns a Proxy, allowing you to "cache" operation chains
  const afterSetValue = client.setValue('greeting', 'hello');
  const afterUppercase = afterSetValue.uppercaseValue();
  const result = await afterUppercase;  // await triggers the round trip
  
  const batchRequest = getLastBatchRequest();
  setInspectMode(false);
  
  // The operation chain shows the sequence of operations
  // (batch[0] because automatic batching could send multiple chains)
  expect(batchRequest?.batch[0].operations).toMatchObject([
    { type: 'get', key: 'setValue' },
    { type: 'apply', args: ['greeting', 'hello'] },
    { type: 'get', key: 'uppercaseValue' },
    { type: 'apply', args: [] }
  ]);
  
  // Verify the result
  expect(result).toBe('HELLO');
});

/*
**"Proxy speak"**: The operations you see above 
are essentially "Proxy speak" - they correspond to JavaScript 
[Proxy handler traps](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy#handler_functions). 
The [`get` trap](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/get) 
captures property access (like `client.setValue`), while the 
[`apply` trap](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/apply) 
captures function calls (like `setValue('greeting', 'hello')`). Lumenize RPC 
uses a Proxy to intercept these operations and build the OCAN structure you see above.

**The beauty of a thenable Proxy**: Because the Proxy is thenable, we know the 
exact moment you use `await` - that's what triggers the round trip. Until then, 
each method call returns a new Proxy, allowing you to "cache" operation chains 
and build them incrementally. When you finally `await`, the client sends the 
complete structure in a single round trip.

**Server-side execution**: When `lumenizeRpcDO` receives this OCAN structure, 
it walks through the operations in sequence, executing each `get` (property 
access) and `apply` (function call) against your Durable Object. For nested 
operations, it recursively resolves the nested chains first, then uses their 
results as arguments. This means complex multi-step operations execute entirely 
on the server side, with only one network round trip.

### De✨light✨ful DX (DDX) vs optimization

The fact that you can see exactly what it's doing under the covers by 
showing the actual data structure that's going over the wire is a great 
example of how Lumenize prioritizes DDX over everything else.

The [byte count for the above payload is 4x-5x larger than the equivalent we measured for Cap'n Web](/docs/rpc/capn-web-comparison-performance#payload-byte-count-small-payloads). We 
could eliminate that delta by using an integer code for the operation and 1-2 
character keys. '__isNestedOperation' shown below could have been '_n'.

However, DDX doesn't just apply to our users. It applies to our own 
development. Also, we have seen that this level of explicitness and exposure 
of internal mechanics and data structures (behind an "inspect mode" flag) 
empowers our AI coding LLMs to figure it out as well. It's surprising how 
much meaning LLMs discern from your how things are labeled.
*/

/*
### Operation Nesting Example

When you pass unawaited operations as arguments, they become nested in the 
OCAN structure:
*/
it('demonstrates operation nesting', async () => {
  using client = createRpcClient<typeof DataService>({
    transport: createWebSocketTransport(
      'DATA_SERVICE',
      'test-nesting',
      { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
    )
  });

  // Set up some test data first
  await client.setValue('first', 'hello');
  await client.setValue('second', 'world');
  
  setInspectMode(true);
  
  // Combine two values - note we're NOT awaiting the getValue() calls!
  const result = await client.combineValues(
    client.getValue('first'),
    client.getValue('second')
  );
  
  const batchRequest = getLastBatchRequest();
  setInspectMode(false);
  
  // The nested operations appear as nested operation chains in the args
  // (batch[0] because this is a single operation - see batching example below)
  expect(batchRequest?.batch[0].operations).toMatchObject([
    { type: 'get', key: 'combineValues' },
    { 
      type: 'apply', 
      args: [
        // First arg is a nested operation chain
        {
          __isNestedOperation: true,
          __operationChain: [
            { type: 'get', key: 'getValue' },
            { type: 'apply', args: ['first'] }
          ]
        },
        // Second arg is another nested operation chain
        {
          __isNestedOperation: true,
          __operationChain: [
            { type: 'get', key: 'getValue' },
            { type: 'apply', args: ['second'] }
          ]
        }
      ]
    }
  ]);
  
  // Verify the result
  expect(result).toBe('hello + world');
});

/*
### Automatic Batching Example

When you trigger multiple operations in the same microtask, they're 
automatically batched into a single request:
*/
it('demonstrates automatic batching', async () => {
  using client = createRpcClient<typeof DataService>({
    transport: createWebSocketTransport(
      'DATA_SERVICE',
      'test-batching',
      { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
    )
  });

  // Set up test data
  await client.setValue('first', 'hello');
  await client.setValue('second', 'world');
  await client.setValue('third', 'foo');
  
  setInspectMode(true);
  
  // Trigger multiple operations in the same microtask (don't await yet)
  const p1 = client.getValue('first');
  const p2 = client.getValue('second');
  const p3 = client.getValue('third');
  
  // Now await them all
  const [result1, result2, result3] = await Promise.all([p1, p2, p3]);
  
  const batchRequest = getLastBatchRequest();
  setInspectMode(false);
  
  // All three operations are batched together in one request
  expect(batchRequest?.batch).toHaveLength(3);
  
  // First operation chain
  expect(batchRequest?.batch[0].operations).toMatchObject([
    { type: 'get', key: 'getValue' },
    { type: 'apply', args: ['first'] }
  ]);
  
  // Second operation chain
  expect(batchRequest?.batch[1].operations).toMatchObject([
    { type: 'get', key: 'getValue' },
    { type: 'apply', args: ['second'] }
  ]);
  
  // Third operation chain
  expect(batchRequest?.batch[2].operations).toMatchObject([
    { type: 'get', key: 'getValue' },
    { type: 'apply', args: ['third'] }
  ]);
  
  // Verify all results
  expect(result1).toBe('hello');
  expect(result2).toBe('world');
  expect(result3).toBe('foo');
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

@import {typescript} "../src/index.ts" [src/index.ts]

### wrangler.jsonc

@import {json} "../wrangler.jsonc" [wrangler.jsonc]

### vitest.config.js

@import {javascript} "../vitest.config.js" [vitest.config.js]
*/
