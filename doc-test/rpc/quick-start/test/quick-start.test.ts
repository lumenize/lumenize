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
# Quick Start

Here's what minimal use of Lumenize RPC looks like.
*/

/*
## Imports
*/
import { it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { 
  createRpcClient, 
  createWebSocketTransport, 
  createHttpTransport 
} from '@lumenize/rpc';
import { getWebSocketShim } from '@lumenize/utils';

/*
## Version(s)

This test asserts the installed version(s) and our release script warns if we 
aren't using the latest version published to npm, so this living documentation 
should always be up to date.
*/
import lumenizeRpcPackage from '../../../../packages/rpc/package.json';
it('detects package version', () => {
  expect(lumenizeRpcPackage.version).toBe('0.15.0');
});

/*
## Basic Usage (test/quick-start.test.ts)
*/

import { Counter } from '../src/index';

function getLumenizeClient(instanceName: string) {
  // You can type the client so TypeScript type checking works
  return createRpcClient<typeof Counter>({
    transport: createWebSocketTransport(
      'COUNTER', // or 'counter' if you want pretty URLs
      instanceName,
      // Since we're doc-testing in a vitest-pool-worker env, we need to
      // provide this WebSocketClass, but you wouldn't in production
      { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
    )
  });
}

it('shows basic usage of Lumenize RPC', async () => {
  // Use `using` for automatic resource cleanup and WebSocket connection close
  // when `client` leaves scope.
  using client = getLumenizeClient('basics');

  // Call increment
  const result = await client.increment();
  expect(result).toBe(1);

  // All types supported by Workers RPC work plus a few more
  const map = new Map<string, number>([['a', 1], ['b', 2]]);
  const echoResult = await client.echo(map);
  expect(echoResult).toEqual(map);

  // Access instance variables
  expect(await client.instanceVariable).toBe('my instance variable');
});

/*
## HTTP Transport

Lumenize RPC supports both WebSocket and HTTP transports. HTTP is simpler and
stateless - each round trip is a separate HTTP request. WebSocket maintains a
persistent connection for lower latency.
*/

it('shows HTTP transport usage', async () => {
  using client = createRpcClient<typeof Counter>({
    transport: createHttpTransport('COUNTER', 'http-basics',
      // Since we're doc-testing in a vitest-pool-worker env, we need to
      // provide this fetch, but you wouldn't in production
      { fetch: SELF.fetch.bind(SELF) }
    )
  });
  
  const result = await client.increment();
  expect(result).toBe(1);
});

/*
## Direct Access to `ctx` (DurableObjectState)

Other than JavaScript private "#" members, everything is usable over
the RPC connection even ctx and env. For example of using env to hop from
one DO to another once "inside" with RPC, see: [Hop Between DOs Using `env`](/docs/rpc/capn-web-comparison-just-works#hop-between-dos-using-env)

Notice how we don't await the first call to ctx.storage.kv.put. That starts
a batch which won't round trip until it sees `await` in the next line.

Also notice how we are using await on the call to the non-`async` storage
operation. This is required to trigger the round trip even though if you
were actually inside the DO, you wouldn't need to `await` this call.
*/
it('shows remote access to ctx (DurableObjectState)', async () => {
  using client = getLumenizeClient('ctx-access');
  
  client.ctx.storage.kv.put('key', 'value');  // not `await`ing builds a batch
  const result = await client.ctx.storage.kv.get('key');  // must `await`
  expect(result).toBe('value');
});

/*
## Chaining

We showed batching in the last example, but chaining is also supported with the
same single round trip performance benefits.
*/
it('shows chaining', async () => {
  using client = getLumenizeClient('chaining');
  
  const storage = client.ctx.storage; 
  storage.kv.put('key', 'value');
  const result = await storage.kv.get('key');
  expect(result).toBe('value');
});

/*
## Nesting

You can even make the result of one call be the input to another - again,
all in one round trip.
*/
it('shows nesting', async () => {
  using client = getLumenizeClient('nesting');

  const result = await client.increment(
    client.echo(10)
  )
  expect(result).toBe(10);  // 0 + 10 = 10
});

/*
For a deeper dive on how we do chaining, nesting, and batching in a single 
round trip, see: [How It Works](/docs/rpc/operation-chaining-and-nesting).
*/

/*
## Installation

First let's install some tools

```bash npm2yarn
npm install --save-dev vitest@3.2
npm install --save-dev @vitest/coverage-istanbul@3.2
npm install --save-dev @cloudflare/vitest-pool-workers
npm install --save-dev @lumenize/rpc
npm install --save-dev @lumenize/utils
```

## src/index.ts

Next add this Worker and Durable Object:

@import {typescript} "../src/index.ts" [src/index.ts]

## wrangler.jsonc

Your `wrangler` config should look something like this:

@import {json} "../wrangler.jsonc" [wrangler.jsonc]

## vitest.config.js

Then add to your `vite` config, if applicable, or create a `vitest` config that 
looks something like this:

@import {javascript} "../vitest.config.js" [vitest.config.js]

## Try it out

To run it as a vitest:
```bash
vitest --run
```

You can even see how much of the code is covered by this "test":
```bash
vitest --run --coverage
```
*/
