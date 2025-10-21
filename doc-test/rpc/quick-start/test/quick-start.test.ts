/*
# Quick Start
*/

/*
Here's what minimal use of Lumenize RPC looks like.

## test/quick-start.test.ts
*/
import { it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim } from '@lumenize/rpc';

import { Counter } from '../src/index';

it('shows basic usage of Lumenize RPC', async () => {
  await using client = createRpcClient<typeof Counter>(
    'COUNTER', // or 'counter' if you want pretty URLs
    'test-counter',
    // Since we're doc-testing in a vitest-pool-worker env, we need to provide
    // this WebSocketClass, but you woudldn't in production
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );

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
To run the example above, put it in `test/quick-start.test.ts` and perform the 
following setup.

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

You `wrangler` config should look something like this:

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
