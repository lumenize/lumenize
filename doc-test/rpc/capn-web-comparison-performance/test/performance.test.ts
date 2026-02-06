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

**Bottom line**: The perceivable performance differences between Cap'n Web and 
Lumenize RPC are essentially zero (receipts below).

## Round trip count completely determines performance

We have [experimentally determined](https://github.com/lumenize/lumenize/blob/main/experiments/performance-comparisons/test/performance.test.ts) that the time of a round trip between a Worker/DO launched with `wrangler dev` and a vitest-workers-pool connecting to it over localhost is as follows:
- Cap'n Web: 0.156ms
- Lumenize RPC: 0.171ms
- **Delta**: 0.015ms

The round trip time (RTT) to Cloudflare edge network from a US East location is 
rarely better than ~20ms. If you incure that extra 0.015ms on top of a single round trip, that works out to 0.075%. So, the difference between the two implementations is completely obscured by a single round trip.

On the other hand, if Lumenize RPC or Cap'n Web required 2 round trips while that other required only 1, it would be 100% difference in performance.

**In every case we show below, both require only a single RPC round trip for 
all use cases by making use of
[OCAN](/docs/rpc/operation-chaining-and-nesting) 
(Operation Chaining and Nesting).**

## Full load throughput over localhost

Not that it matters much, but the same experiment determined that the max fully loaded throughput was as follows: 
- Cap'n Web exposed DO: 6414 ops/sec
- Lumenize RPC exposed DO: 5858 ops/sec
- **Delta**: 1.09x

We say, "it doesn't matter much" because DOs are designed to be scaled out not up. If you have a DO approaching its max limit, you probably don't have fine enough granularity in what work you are sending to each DO. More importantly, these are micro-benchmarks with stupid simple methods being called. The real work your methods perform will be much more determinative of max throughput.

As other documents in this comparison show, Lumenize RPC has signficant advantages that more than compensate for these small performance differences.
*/

/*
## Imports
*/
import { it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport, createHttpTransport } from '@lumenize/rpc';
import { getWebSocketShim } from '@lumenize/testing';
import { newWebSocketRpcSession } from 'capnweb';
import type { Metrics } from '@lumenize/testing';
import { Browser } from '@lumenize/testing';

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
  expect(lumenizeRpcPackage.version).toBe('0.17.0');
  expect(capnwebPackage.version).toBe('0.1.0');
});

/*
## Creating Clients
*/

function getLumenizeClient(instanceName: string, metrics?: Metrics) {
  return createRpcClient<typeof LumenizeDO>({
    transport: createWebSocketTransport('LUMENIZE', instanceName,
      { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF), { metrics }) }
    )
  });
}

function getCapnWebClient(instanceName: string, metrics?: Metrics) {
  const url = `wss://test.com/capnweb/capnweb/${instanceName}`;
  const ws = new (getWebSocketShim(SELF.fetch.bind(SELF), { metrics }))(url);
  return newWebSocketRpcSession<CapnWebRpcTarget>(ws);
}

function getLumenizeHttpClient(instanceName: string, metrics: Metrics) {
  const browser = new Browser(SELF.fetch.bind(SELF), { metrics });
  return createRpcClient<typeof LumenizeDO>({
    transport: createHttpTransport(
      'LUMENIZE',
      instanceName,
      { fetch: browser.fetch }
    )
  });
}

/*
## Metrics Setup
*/

let lumenizeMetrics: Metrics = {};
let capnwebMetrics: Metrics = {};

/*
## Automatic Batching

Automatic batching allows multiple RPC calls to be sent together without waiting
for each response. This can significantly reduce round trips when making
multiple calls in sequence, and as we said, round trip count determines
essentially the entire performance story with a "remote" procedure calling
system.

**Key insight:** For this simple case, there is no difference between Cap'n Web 
and Lumenize RPC with respect to RPC round trip count. Cap'n Web is much more
chatty on the outgoing message count (5 for Cap'n Web vs 1 for Lumenize RPC).

However, that's a distinction without a difference when using WebSockets which 
will push them all out over the wire rapidly one after the other. The only 
metrics here that matter are the received message counts (representing RPC 
round trips) and the count of WebSocket upgrade requests (representing the 
one-time connection cost).

**Cap'n Web and Lumenize RPC both need 1 RPC round trip (wsReceivedMessages) 
plus the initial connection (wsUpgradeRequests).**
*/
it('compares round trips when using automatic batching', async () => {
  // ==========================================================================
  // Lumenize RPC - automatic batching
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('pipeline', lumenizeMetrics);
  lumenizeClient.increment();  // Returns promise, not awaited
  lumenizeClient.increment();  // Returns promise, not awaited
  const lumenizeResult = await lumenizeClient.increment(); // Await final result

  // ==========================================================================
  // Cap'n Web - automatic batching
  // ==========================================================================
  using capnwebClient = getCapnWebClient('pipeline', capnwebMetrics);
  capnwebClient.increment();  // Returns promise, not awaited
  capnwebClient.increment();  // Returns promise, not awaited
  const capnwebResult = await capnwebClient.increment();  // Await final result

  // Both should produce the same final result
  expect(lumenizeResult).toBe(3);
  expect(capnwebResult).toBe(3);

  // --- Connection cost (one-time) ---
  // Both create exactly one WebSocket connection
  expect(lumenizeMetrics.wsUpgradeRequests).toBe(1);
  expect(capnwebMetrics.wsUpgradeRequests).toBe(1);

  // --- RPC round trips (per-batch cost) ---
  
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
## Payload byte count (small payloads)

Let's compare the byte counts for the payloads for the above calls.

**Key insight:** For this simple case, the bytes needed to achieve
[Lumenize RPC's greater type support](/docs/rpc/capn-web-comparison-basics-and-types#supported-types)
(cycles/aliases, Set, Map, etc.) and more 
[human-readable OCAN](/docs/rpc/operation-chaining-and-nesting)
results in it needing 4.6x the byte count.

However, just like Cap'n Web's 5x messages sent count disadvantage in the test 
above, this is also a distinction without much of a difference. The latency
impact of this 577 byte difference at even a very slow connection of say 10Mb/s 
is 0.46ms (0.00046 seconds) and more importantly, the payloads are so small
that all we are measuring is framing.

More importantly, we have intentionally decided not to optimize this payload 
byte count, because we [value de✨light✨ful DX (DDX)](/docs/rpc/operation-chaining-and-nesting#delightful-dx-ddx-vs-optimization)
everything else.
*/
it('compares byte count (small payloads)', async () => {
  // --- Payload bytes sent ----
  // Outgoing - Lumenize sends more bytes vs Cap'n Web's encoding
  expect(lumenizeMetrics.wsSentPayloadBytes).toBeCloseTo(460, -1);
  expect(capnwebMetrics.wsSentPayloadBytes).toBeCloseTo(145, -1);
  
  // --- Payload bytes received ---
  // Incomming - Cap'n Web is much more compact
  expect(lumenizeMetrics.wsReceivedPayloadBytes).toBeCloseTo(277, -1);
  expect(capnwebMetrics.wsReceivedPayloadBytes).toBeCloseTo(15, -1);
});

/*
## Payload byte count (larger payloads)

The previous test showed a 4.6x higher byte count for Lumenize RPC, but that's 
almost all framing overhead on tiny payloads. Let's test with a more realistic 
payload size - a 10KB string, which is not very large and would travel 
over a very slow 10Mb/s in ~8ms.

**Key insight:** With actual data payloads, the framing overhead becomes
negligible. Lumenize RPC is only 1.6% larger which translates to an additional
0.27ms (0.00027 seconds) of latency over a very slow 10Mb/s connection.
*/
it('compares byte count with 10KB payload', async () => {
  // Create a 10KB string (10,240 characters)
  const largeString = 'x'.repeat(10240);
  
  // Reset metrics for this test
  const lumenizeLgMetrics: Metrics = {};
  const capnwebLgMetrics: Metrics = {};
  
  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  using lumenizeClient = getLumenizeClient('large-payload', lumenizeLgMetrics);
  await lumenizeClient.echo(largeString);
  
  // ==========================================================================
  // Cap'n Web
  // ==========================================================================
  using capnwebClient = getCapnWebClient('large-payload', capnwebLgMetrics);
  await (capnwebClient as any).echo(largeString);
  
  // Calculate total bytes (sent + received)
  const lumenizeTotal = 
    lumenizeLgMetrics.wsSentPayloadBytes + 
    lumenizeLgMetrics.wsReceivedPayloadBytes;
  const capnwebTotal = 
    capnwebLgMetrics.wsSentPayloadBytes + 
    capnwebLgMetrics.wsReceivedPayloadBytes;
  
  // Ratio: 1.016 (Lumenize 1.6% larger)
  const totalRatio = lumenizeTotal / capnwebTotal;
  expect(totalRatio).toBeCloseTo(1.016, 2);
});

/*
## HTTP Batching

Here we demonstrate that Lumenize RPC passively batches over HTTP so it needs
only one HTTP round trip per batch.

The Cap'n Web `newHttpBatchRpcSession()` is not shown in this doc-test.
We may verify this experimentally at a later date, but for now we assume it 
uses exactly one HTTP round trip, like Lumenize RPC.

**Key insight:** Both Lumenize RPC and Cap'n Web use exactly one HTTP round 
trip for batched operations.
*/
it('demonstrates HTTP batching in Lumenize RPC', async () => {
  const metrics: Metrics = {};
  
  // ==========================================================================
  // Lumenize RPC - HTTP transport (same DO as WebSocket examples above)
  // ==========================================================================
  using client = getLumenizeHttpClient('http-batch-demo', metrics);
  
  // Fire 3 operations - automatically batched into 1 HTTP request
  client.increment();
  client.increment();
  const result = await client.increment();
  
  expect(result).toBe(3);
  
  // All 3 operations sent in exactly 1 HTTP request
  expect(metrics.roundTrips).toBe(1);
});

/*
## Operation Nesting

Operation nesting allows using the result of an unawaited call as a 
parameter to another call. This creates dependent operations that can still be 
done with a single RPC round trip.

Both Cap'n Web and Lumenize RPC have this capability, allowing complex 
dependent operations to execute efficiently.

**Key insight:** Both systems handle all three dependent calls in exactly one 
RPC round trip (wsReceivedMessages) by substituting promise values on the 
server side, plus the one-time connection cost (wsUpgradeRequests).
*/
it('compares promise pipelining performance', async () => {
  const lmMetrics: Metrics = {};
  const cwMetrics: Metrics = {};
  
  // ========================================================================
  // Lumenize RPC
  // ========================================================================
  using lmClient = getLumenizeClient('geometric-progression', lmMetrics);
  
  // Geometric progression using operation nesting:
  const lm1 = lmClient.increment();           // increment() → 1
  const lm2 = lmClient.increment(lm1);        // increment(1) → 2
  const lmResult = await lmClient.increment(lm2);  // increment(2) → 4
  
  // ========================================================================
  // Cap'n Web
  // ========================================================================
  using cwClient = getCapnWebClient('geometric-progression', cwMetrics);
  
  // Geometric progression using promise pipelining:
  const cw1 = cwClient.increment();           // increment() → 1
  const cw2 = cwClient.increment(cw1);        // increment(1) → 2
  const cwResult = await cwClient.increment(cw2);  // increment(2) → 4
  
  // Both produce same result (geometric progression: 1 → 2 → 4)
  expect(lmResult).toBe(4);
  expect(cwResult).toBe(4);
  
  // --- Connection cost (one-time) ---
  // Both create exactly one WebSocket connection
  expect(lmMetrics.wsUpgradeRequests).toBe(1);
  expect(cwMetrics.wsUpgradeRequests).toBe(1);
  
  // --- RPC round trips (per-batch cost) ---
  // All 3 dependent operations sent in exactly 1 RPC round trip for both!
  expect(lmMetrics.wsReceivedMessages).toBe(1);
  expect(cwMetrics.wsReceivedMessages).toBe(1);
});

/*
## Operation Nesting (nested syntax)

Operation nesting also works with nested call syntax.

In this case, both the inner and outer calls receive 10 as their argument, 
resulting in: 0 + 10 = 10, then 10 + 10 = 20.

This works with both WebSocket and HTTP transports.
*/
it('compares promise pipelining with nested syntax', async () => {
  const httpMetrics: Metrics = {};
  const lmMetrics: Metrics = {};
  const cwMetrics: Metrics = {};
  
  // ========================================================================
  // Lumenize RPC - nested operation calls (HTTP)
  // ========================================================================
  using httpClient = getLumenizeHttpClient('nested-http', httpMetrics);
  const httpResult = await httpClient.increment(httpClient.increment(10));
  
  // ========================================================================
  // Lumenize RPC - nested operation calls (WebSocket)
  // ========================================================================
  using lmClient = getLumenizeClient('nested-syntax', lmMetrics);
  const lmResult = await lmClient.increment(lmClient.increment(10));
  
  // ========================================================================
  // Cap'n Web - nested promise pipelining (WebSocket)
  // ========================================================================
  using cwClient = getCapnWebClient('nested-syntax', cwMetrics);
  const cwResult = await cwClient.increment(cwClient.increment(10));
  
  // All three produce same result: increment(10) → 10, increment(10) → 20
  expect(httpResult).toBe(20);
  expect(lmResult).toBe(20);
  expect(cwResult).toBe(20);
  
  // HTTP client handles nested calls in exactly 1 HTTP round trip
  expect(httpMetrics.roundTrips).toBe(1);
  
  // WebSocket clients handle nested calls in exactly 1 RPC round trip
  expect(lmMetrics.wsReceivedMessages).toBe(1);
  expect(cwMetrics.wsReceivedMessages).toBe(1);
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