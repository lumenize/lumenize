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
# vs Cap'n Web (performance)

This living documentation compares performance characteristics between Lumenize 
RPC and Cap'n Web (Cloudflare's official "last-mile" RPC solution).

The test suite automatically asserts the installed versions of both packages
to ensure documentation always reflects what's actually being tested.

Using this doc-test approach, when either package changes its implementation, 
we'll know immediately because the tests will start failing as soon as we 
upgrade to the latest version.

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
import type { Metrics } from '@lumenize/utils';

import { LumenizeDO, CapnWebRpcTarget } from '../src/index';

/*
## Version Detection

This test asserts the installed version(s) and our release script warns if we 
aren't using the latest so this should always be up to date.
*/

// Import package versions for automatic version tracking
import lumenizeRpcPackage from '../../../../packages/rpc/package.json';
import capnwebPackage from '../../../../node_modules/capnweb/package.json';

it('detects package versions', () => {
  expect(lumenizeRpcPackage.version).toBe('0.10.0');
  expect(capnwebPackage.version).toBe('0.1.0');
});

// =============================================================================
// Create clients - Similar amount of boilerplate
// =============================================================================

// Most of this is for vitest-workers-pool. In production, this would be as 
// simple as:
// ```ts
// const client = createRpcClient<typeof LumenizeDO>('LUMENIZE', 'name');
// ```
function getLumenizeClient(instanceName: string, metrics?: Metrics) {
  return createRpcClient<typeof LumenizeDO>(
    'LUMENIZE',
    instanceName,
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF), { metrics }) }
  );
}

// Similarly, some of this is for vitest-workers-pool. In production, this 
// would be as simple as:
// ```ts
// const url = `wss://test.com/capnweb/capnweb/name`;
// const client = newWebSocketRpcSession<CapnWebRpcTarget>(url);
// ```
function getCapnWebClient(instanceName: string, metrics?: Metrics) {
  const url = `wss://test.com/capnweb/capnweb/${instanceName}`;
  const ws = new (getWebSocketShim(SELF.fetch.bind(SELF), { metrics }))(url);
  return newWebSocketRpcSession<CapnWebRpcTarget>(ws);
}

/*
## Performance Metrics

Let's compare the number of WebSocket messages and upgrade requests for a simple operation.

Both frameworks use WebSockets for RPC communication, but they may differ in:
- Number of WebSocket upgrade requests (connection overhead)
- Number of messages exchanged per RPC call
- Message payload sizes

**Key metrics**:
- `wsUpgradeRequests` - Number of WebSocket connections established
- `wsMessages` - Total number of WebSocket messages sent
- `wsPayloadBytes` - Total bytes transmitted over WebSocket
- Bytes per message - Average payload size efficiency
*/
it('shows metrics when not using promise pipelining', async () => {
  const lumenizeMetrics: Metrics = {};
  const capnwebMetrics: Metrics = {};

  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('metrics-test', lumenizeMetrics);
  await lumenizeClient.increment();
  await lumenizeClient.increment();
  const lumenizeResult = await lumenizeClient.increment();

  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  using capnwebClient = getCapnWebClient('metrics-test', capnwebMetrics);
  await capnwebClient.increment();
  await capnwebClient.increment();
  const capnwebResult = await capnwebClient.increment();

  // Both should produce the same final result
  expect(lumenizeResult).toBe(3);
  expect(capnwebResult).toBe(3);

  // Both create exactly one WebSocket connection
  expect(lumenizeMetrics.wsUpgradeRequests).toBe(1);
  expect(capnwebMetrics.wsUpgradeRequests).toBe(1);

  // --- Round trips (sent messages) ---
  // Lumenize sends 1 message per RPC call
  expect(lumenizeMetrics.wsSentMessages).toBe(3);
  // Cap'n Web sends 3 messages per RPC call
  expect(capnwebMetrics.wsSentMessages).toBe(9);
  
  // --- Round trips (received messages) ---
  // Lumenize receives 1 message per RPC call
  expect(lumenizeMetrics.wsReceivedMessages).toBe(3);
  // Cap'n Web receives 1 message per RPC call (batches responses)
  expect(capnwebMetrics.wsReceivedMessages).toBe(3);
  
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
  
  // --- Bytes per sent message ---
  const lumenizeSentAvg = lumenizeMetrics.wsSentPayloadBytes! / 
                          lumenizeMetrics.wsSentMessages!;
  const capnwebSentAvg = capnwebMetrics.wsSentPayloadBytes! / 
                         capnwebMetrics.wsSentMessages!;
  
  // Batch format has slightly more overhead per message (wrapper array)
  expect(lumenizeSentAvg).toBeCloseTo(248, -1);  // ±5 bytes/msg
  expect(capnwebSentAvg).toBeCloseTo(21.7, 0);   // ±0.5 bytes/msg
});

/*
## Promise Pipelining

Promise pipelining allows multiple RPC calls to be sent without waiting
for each response. This can significantly reduce round trips when making
multiple calls in sequence.

**Implementation Status:**

- **Lumenize**: ✅ Implements promise pipelining with message batching (v0.10.2+).
  Multiple concurrent RPC calls are automatically batched into a single WebSocket
  message using `queueMicrotask()`, achieving 1 round trip for 3 calls.

- **Cap'n Web**: Implements full promise pipelining with message batching
  (1 round trip for 3 calls). This is one of Cap'n Web's key optimizations.

**How Lumenize Batching Works:**
When you make concurrent RPC calls (without awaiting each one), Lumenize queues
them and uses `queueMicrotask()` to batch all operations made in the same tick
into a single WebSocket message. The server processes all operations and returns
all results in a single response message.
*/
it('shows metrics when using promise pipelining', async () => {
  const lumenizeMetrics: Metrics = {};
  const capnwebMetrics: Metrics = {};

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

  // Both create exactly one WebSocket connection (Lumenize fixed in v0.10.1)
  expect(lumenizeMetrics.wsUpgradeRequests).toBe(1);
  expect(capnwebMetrics.wsUpgradeRequests).toBe(1);

  // --- Message batching comparison ---
  
  // Lumenize batches all concurrent calls into one message
  expect(lumenizeMetrics.wsSentMessages).toBe(1);
  expect(lumenizeMetrics.wsReceivedMessages).toBe(1);
  
  // Cap'n Web batches calls (Cap'n Proto protocol overhead + batched responses)
  expect(capnwebMetrics.wsSentMessages).toBe(5);  // Protocol handshake + calls
  expect(capnwebMetrics.wsReceivedMessages).toBe(1);  // Batched response
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