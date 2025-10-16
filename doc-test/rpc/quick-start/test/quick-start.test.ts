/*
# Quick-start
*/

/*
## Basic Usage

*/
import { it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import {
  createRpcClient,
  RpcAccessible,
  getWebSocketShim
} from '@lumenize/rpc';

import { Counter } from '../src/index';
type Counter = RpcAccessible<InstanceType<typeof Counter>>;

it('shows basic usage of Lumenize RPC', async () => {
  await using client = createRpcClient<Counter>({
    doBindingName: 'COUNTER',  // or 'counter' if you want pretty URLs
    WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)),
    doInstanceNameOrId: 'test-counter',
  });

  // Test increment
  const result1 = await client.increment();
  expect(result1).toBe(1);

  // Test again
  const result2 = await client.increment();
  expect(result2).toBe(2);

  // Verify value in storage
  const value = await client.ctx.storage.kv.get('count');  // await always required
  expect(value).toBe(2);
});

/*
To run the example above, put it in a folder `/test` and perform the following 
setup.

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

Let's say you have this Worker and Durable Object:

@import {typescript} "../src/index.ts" [src/index.ts]

## test/wrangler.jsonc

You `wrangler` config should look something like this:

@import {json} "../wrangler.jsonc" [wrangler.jsonc]

## vitest.config.js

Then add to your `vite` config, if applicable, or create a `vitest` config that 
looks something like this:

@import {javascript} "../vitest.config.js" [vitest.config.js]

## Your tests

Then write your tests using vitest as you would normally. The rest of this 
document are examples of tests you might write for the Worker and DO above.

*/
