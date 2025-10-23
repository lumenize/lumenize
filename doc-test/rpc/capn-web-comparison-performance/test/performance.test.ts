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
# vs Cap'n Web (performance)

This living documentation compares performance characteristics between Lumenize 
RPC and Cap'n Web (Cloudflare's official "last-mile" RPC solution).

## References

- Cap'n Web blog post: https://blog.cloudflare.com/capnweb-javascript-rpc-library/
- Cap'n Web GitHub: https://github.com/cloudflare/capnweb
- Lumenize RPC docs: https://lumenize.com/docs/rpc/introduction
*/

/*
## Imports
*/
import { it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim } from '@lumenize/rpc';
import { newWebSocketRpcSession } from 'capnweb';
import type { Metrics } from '@lumenize/utils';

import { LumenizeDO, CapnWebRpcTarget } from '../src/index';

/*
## Version(s)

This test asserts the installed version(s) and our release script warns if we 
aren't using the latest version published to npm, so this living documentation 
should always be up to date.

Using this doc-test approach, when either package changes its implementation, 
we'll know immediately because the tests will start failing.
*/
import lumenizeRpcPackage from '../../../../packages/rpc/package.json';
import capnwebPackage from '../../../../node_modules/capnweb/package.json';
it('detects package versions', () => {
  expect(lumenizeRpcPackage.version).toBe('0.10.0');
  expect(capnwebPackage.version).toBe('0.1.0');
});

// =============================================================================
// Create clients
// =============================================================================

function getLumenizeClient(instanceName: string, metrics?: Metrics) {
  return createRpcClient<typeof LumenizeDO>(
    'LUMENIZE',
    instanceName,
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF), { metrics }) }
  );
}

function getCapnWebClient(instanceName: string, metrics?: Metrics) {
  const url = `wss://test.com/capnweb/capnweb/${instanceName}`;
  const ws = new (getWebSocketShim(SELF.fetch.bind(SELF), { metrics }))(url);
  return newWebSocketRpcSession<CapnWebRpcTarget>(ws);
}

// =============================================================================
// Setup metrics - we'll use these in multiple tests below
// =============================================================================

let lumenizeMetrics: Metrics = {};
let capnwebMetrics: Metrics = {};

/*
## Promise Pipelining

Promise pipelining allows multiple RPC calls to be sent without waiting
for each response. This can significantly reduce round trips when making
multiple calls in sequence, and as we said, round trip count determines
essentially the entire performance story with a "remote" procedure calling
system.

**Key insight:** For this simple case, there is no difference between Cap'n Web 
and Lumenize RPC with respect to round trip count. Cap'n Web is much more
chatty on the outgoing message count (5 for Cap'n Web vs 1 for Lumenize RPC).

However, that's a distinction without a difference when using WebSockets which 
will push them all out over the wire simultaneously. The only metrics here that 
matter are the received message counts and the count of WebSocket upgrade 
requests, which do represent another round trip.

**Cap'n Web and Lumenize RPC have identical round trip counts (2 each).**
*/
it('compares round trips when using promise pipelining', async () => {
  // ==========================================================================
  // Lumenize RPC - with promise pipelining pattern
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('pipeline-test', lumenizeMetrics);
  lumenizeClient.increment();  // Returns promise, not awaited
  lumenizeClient.increment();  // Returns promise, not awaited
  const lumenizeResult = await lumenizeClient.increment();  // Await final result

  // ==========================================================================
  // Cap'n Web - with promise pipelining pattern
  // ==========================================================================
  using capnwebClient = getCapnWebClient('pipeline-test', capnwebMetrics);
  capnwebClient.increment();  // Returns promise, not awaited
  capnwebClient.increment();  // Returns promise, not awaited
  const capnwebResult = await capnwebClient.increment();  // Await final result

  // Both should produce the same final result
  expect(lumenizeResult).toBe(3);
  expect(capnwebResult).toBe(3);

  // Both create exactly one WebSocket connection
  expect(lumenizeMetrics.wsUpgradeRequests).toBe(1);
  expect(capnwebMetrics.wsUpgradeRequests).toBe(1);

  // --- Message batching comparison ---
  
  // Lumenize batches all calls into one message and gets back one message
  expect(lumenizeMetrics.wsSentMessages).toBe(1);
  expect(lumenizeMetrics.wsReceivedMessages).toBe(1);
  
  // Cap'n Web sends information about each call plus some handshake in 
  // seperate messages, but that doesn't matter because it too only needs one 
  // response message.
  expect(capnwebMetrics.wsSentMessages).toBe(5);  // Handshake + calls
  expect(capnwebMetrics.wsReceivedMessages).toBe(1);  // Batched response
});

/*
## Payload byte count

Let's compare the byte counts for the payloads for the above calls.

**Key insight:** For this simple case, the bytes needed to achieve
[Lumenize RPC's greater type support]() (cycles/aliases, Set, Map, etc.)
results in it needing 5x the byte count.

However, just like Cap'n Web's 5x message count disadvange in the test above, 
this is also a distinction without much of a difference.

**Cap'n Web and Lumenize RPC have identical round trip counts (2 each).**
*/
it('shows metrics when not using promise pipelining', async () => {
  // --- Payload bytes sent ----
  // Lumenize sends more bytes because it uses JSON-RPC
  // vs Cap'n Web's binary Cap'n Proto protocol
  // Note: Batch format adds wrapper overhead but enables pipelining
  expect(lumenizeMetrics.wsSentPayloadBytes).toBeCloseTo(744, -1);
  expect(capnwebMetrics.wsSentPayloadBytes).toBeCloseTo(195, -1);
  
  // --- Payload bytes received ---
  // Response sizes - Cap'n Web is much more compact
  // Note: Batch format adds wrapper overhead but enables pipelining
  expect(lumenizeMetrics.wsReceivedPayloadBytes).toBeCloseTo(483, -1);
  expect(capnwebMetrics.wsReceivedPayloadBytes).toBeCloseTo(45, -1);
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