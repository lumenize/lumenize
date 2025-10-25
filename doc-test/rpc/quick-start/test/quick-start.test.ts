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

## TODO:
- Mine @lumenize/testing for other features
- Cover access to ctx and env
- Mention must use await even for non-async calls

Here's what minimal use of Lumenize RPC looks like.
*/

/*
## Imports
*/
import { it, expect } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim } from '@lumenize/rpc';

/*
## Version(s)

This test asserts the installed version(s) and our release script warns if we 
aren't using the latest version published to npm, so this living documentation 
should always be up to date.
*/
import lumenizeRpcPackage from '../../../../packages/rpc/package.json';
it('detects package version', () => {
  expect(lumenizeRpcPackage.version).toBe('0.10.0');
});

/*
## Basic Usage (test/quick-start.test.ts)
*/

import { Counter } from '../src/index';

it('shows basic usage of Lumenize RPC', async () => {
  using client = createRpcClient<typeof Counter>(
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
There are only a few other calling patterns for using Lumenize RPC. They are 
described next in [How It Works](/docs/rpc/operation-chaining-and-nesting).
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
