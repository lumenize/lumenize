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

It was produced using the latest versions as of 2025-10-22:
- Cap'n Web v0.1.0
- Lumenize RPC v0.10.0

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
  expect(lumenizeMetrics.wsSentPayloadBytes).toBeCloseTo(639, -1);
  expect(capnwebMetrics.wsSentPayloadBytes).toBeCloseTo(195, -1);
  
  // --- Payload bytes received ---
  // Response sizes - Cap'n Web is much more compact
  expect(lumenizeMetrics.wsReceivedPayloadBytes).toBeCloseTo(381, -1);
  expect(capnwebMetrics.wsReceivedPayloadBytes).toBeCloseTo(45, -1);
  
  // --- Bytes per sent message ---
  const lumenizeSentAvg = lumenizeMetrics.wsSentPayloadBytes! / 
                          lumenizeMetrics.wsSentMessages!;
  const capnwebSentAvg = capnwebMetrics.wsSentPayloadBytes! / 
                         capnwebMetrics.wsSentMessages!;
  
  expect(lumenizeSentAvg).toBeCloseTo(213, -1);  // ±5 bytes/msg
  expect(capnwebSentAvg).toBeCloseTo(21.7, 0);   // ±0.5 bytes/msg
});

/*
## Promise Pipelining

Promise pipelining allows multiple RPC calls to be sent without waiting
for each response. This significantly reduces round trips when making
multiple calls in sequence.
*/
it('shows metrics when using promise pipelining', async () => {
  const lumenizeMetrics: Metrics = {};
  const capnwebMetrics: Metrics = {};

  // ==========================================================================
  // Lumenize RPC - with promise pipelining
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('pipeline-test', lumenizeMetrics);
  lumenizeClient.increment();
  lumenizeClient.increment();
  const lumenizeResult = await lumenizeClient.increment();

  // ==========================================================================
  // Cap'n Web - with promise pipelining
  // ==========================================================================
  using capnwebClient = getCapnWebClient('pipeline-test', capnwebMetrics);
  capnwebClient.increment();
  capnwebClient.increment();
  const capnwebResult = await capnwebClient.increment();

  // Both should produce the same final result
  expect(lumenizeResult).toBe(3);
  expect(capnwebResult).toBe(3);

  // Both create exactly one WebSocket connection
  expect(lumenizeMetrics.wsUpgradeRequests).toBe(1);
  expect(capnwebMetrics.wsUpgradeRequests).toBe(1);

  // --- Round trips (sent messages) with pipelining ---
  // Lumenize still sends separately (implementation detail)
  expect(lumenizeMetrics.wsSentMessages).toBe(3);
  // Cap'n Web sends 5 messages with pipelining
  expect(capnwebMetrics.wsSentMessages).toBe(5);
  
  // --- Round trips (received messages) with pipelining ---
  // Lumenize still receives separately (implementation detail)
  expect(lumenizeMetrics.wsReceivedMessages).toBe(3);
  // Cap'n Web batches all responses into 1 message
  expect(capnwebMetrics.wsReceivedMessages).toBe(1);
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