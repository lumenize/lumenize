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

Lumenize RPC is built on what we call **Operation Chaining and Nesting (OCAN)** 
- a powerful pattern for composing multiple RPC operations efficiently. 

Cloudflare uses terms like "promise pipelining" and "batching" for Cap'n Web 
optimizations. We know Lumenize RPC has some things in common, like a thenable 
Proxy, and maybe what we are doing could also fall under those terms, but we 
use OCAN to describe what Lumenize RPC is doing on the covers.
*/

/*
## What is OCAN?

OCAN has two complementary aspects:

1. **Operation Chaining**: Chain method calls on returned values without 
   awaiting intermediate results
   ```typescript
   client.setValue('key', 'value').processValue(...)
   ```

2. **Operation Nesting**: Use unawaited operations as arguments to other 
   operations
   ```typescript
   client.combineValues(client.getValue('a'), client.getValue('b'))
   ```

Both patterns work because Lumenize RPC builds an **operation chain** that 
describes the sequence and dependencies of your operations, then executes them 
in one round trip.

Let's peek under the hood to see how operation chains are structured.
*/

/*
### Imports
*/
import { it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { 
  createRpcClient, 
  getWebSocketShim,
  setInspectMode,
  getLastOperationChain 
} from '@lumenize/rpc';
import { DataService } from '../src/index';

/*
### Version(s)

This test asserts the installed version(s) and our release script warns if we 
aren't using the latest version published to npm, so this living documentation 
should always be up to date.
*/
import lumenizeRpcPackage from '../../../../packages/rpc/package.json';
it('detects package version', () => {
  expect(lumenizeRpcPackage.version).toBe('0.10.0');
});

/*
### Operation Chaining Example

Each method call adds an operation to the chain:
*/
it('demonstrates operation chaining', async () => {
  using client = createRpcClient<typeof DataService>(
    'DATA_SERVICE',
    'test-chaining',
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );

  // Enable inspect mode to capture the operation chain
  setInspectMode(true);
  
  // Build a chain by calling methods on client without awaiting
  const result = await client.setValue('greeting', 'hello').processValue();
  
  // Get the captured operation chain structure
  const batchRequest = getLastOperationChain();
  
  // Disable inspect mode
  setInspectMode(false);
  
  // The operation chain shows the sequence of operations
  expect(batchRequest?.batch[0].operations).toMatchObject([
    { type: 'get', key: 'setValue' },
    { type: 'apply', args: ['greeting', 'hello'] },
    { type: 'get', key: 'processValue' },
    { type: 'apply', args: [] }
  ]);
  
  // Verify the result (execution happened normally despite inspect mode)
  expect(result).toBe('HELLO');
});

/*
### Operation Nesting Example

When you pass unawaited operations as arguments, they become nested in the 
operation chain:
*/
it('demonstrates operation nesting', async () => {
  using client = createRpcClient<typeof DataService>(
    'DATA_SERVICE',
    'test-nesting',
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );

  // Set up some test data first
  await client.setValue('first', 'hello');
  await client.setValue('second', 'world');
  
  // Enable inspect mode to capture the operation chain
  setInspectMode(true);
  
  // Combine two values - note we're NOT awaiting the getValue() calls!
  const result = await client.combineValues(
    client.getValue('first') as any,
    client.getValue('second') as any
  );
  
  // Get the captured operation chain structure
  const batchRequest = getLastOperationChain();
  
  // Disable inspect mode
  setInspectMode(false);
  
  // The nested operations appear as nested operation chains in the args
  expect(batchRequest?.batch[0].operations).toMatchObject([
    { type: 'get', key: 'combineValues' },
    { 
      type: 'apply', 
      args: [
        // First arg is a nested operation chain
        {
          __isPipelinedOperation: true,
          __operationChain: [
            { type: 'get', key: 'getValue' },
            { type: 'apply', args: ['first'] }
          ]
        },
        // Second arg is another nested operation chain
        {
          __isPipelinedOperation: true,
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
## The Power of OCAN

These operation chains are sent to the server as a single request, where the 
server can:
- Execute dependent operations in sequence
- Optimize execution (parallelization where possible)
- Return only the final result

This eliminates round-trip latency for dependent operations while maintaining 
clean, intuitive code.

## Installation and Setup

@import {typescript} "../src/index.ts" [src/index.ts]

@import {json} "../wrangler.jsonc" [wrangler.jsonc]

@import {javascript} "../vitest.config.js" [vitest.config.js]
*/
