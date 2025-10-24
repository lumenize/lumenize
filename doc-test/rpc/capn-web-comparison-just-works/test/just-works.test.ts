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
# vs Cap'n Web ("It just works")

Cap'n Web's documentation states that Workers RPC interoperability 
["basically, it 'just works.'"](https://github.com/cloudflare/capnweb/tree/main#cloudflare-workers-rpc-interoperability) This living documentation demonstrates 
that claim and highlights the current limitations of it.

**Bottom line**: Cap'n Web's syntax, which allows you to magically return an RpcTarget instance or Durable Object stub is quite elegant and conceptually consistent. Lumenize RPC's is more explicit but similarly concise. Still, we'd give the slight advantage to Cap'n Web except for one little thing-[unsupported types](https://github.com/cloudflare/capnweb/tree/main?tab=readme-ov-file#pass-by-value-types). We drill down on this in the next doc-test but if you want to skip ahead, there is [summary table of types supported by Workers RPC compared to those supported by Cap'n Web and Lumenize RPC](/docs/rpc/capn-web-comparison-basics-and-types#supported-types). Note, Cloudflare says some of these "may be added in the future" and if that happens we will quickly update these documents, but until then, the claim "it just works" falls short.

TODO:
- Doesn't callbacks break consistency guarantees of input/output gates because you must await a callback function.
- Maybe too much magic. I had to fight my LLM to force it to even try. It kept saying, "that won't work" but once I forced it to try, it did!
- 
*/

/*
### src/index.ts

Normally, we start off these doc-tests with the tests that show behavior, but in this case, we want you to look at the Worker, DurableObjects and RpcTargets first.

@import {typescript} "../src/index.ts" [src/index.ts]
*/


/*
## Imports
*/
import { it, expect, vi } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF, env } from 'cloudflare:test';
import { createRpcClient, getWebSocketShim } from '@lumenize/rpc';
import { newWebSocketRpcSession } from 'capnweb';

import { User, CapnWebUser } from '../src/index';

/*
## Version(s)

This test asserts the installed version(s) and our release script warns if we 
aren't using the latest version published to npm, so this living documentation 
should always be up to date.
*/
import lumenizeRpcPackage from '../../../../packages/rpc/package.json';
import capnwebPackage from '../../../../node_modules/capnweb/package.json';
it('detects package versions', () => {
  expect(lumenizeRpcPackage.version).toBe('0.10.0');
  expect(capnwebPackage.version).toBe('0.1.0');
});

/*
## Creating Clients
*/
function getLumenizeUserClient(instanceName: string) {
  return createRpcClient<typeof User>(
    'USER',
    instanceName,
    { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
  );
}

function getCapnWebUserClient() {
  const url = `wss://test.com/capnweb`;
  const ws = new (getWebSocketShim(SELF.fetch.bind(SELF)))(url);
  return newWebSocketRpcSession<CapnWebUser>(ws);
}

// Alias for brevity
const getCapnWebClient = getCapnWebUserClient;

/*
## Service-to-Service Communication via Workers RPC

A common pattern in chat applications: User service acts as a gateway/proxy,
hopping to Room services for actual storage operations.

**Lumenize RPC**:
- ✅ Seamlessly hops from User to Room via `this.env.ROOM`
- ✅ Client accesses User via Lumenize RPC
- ✅ User → Room communication uses Workers RPC automatically
- ✅ No configuration needed - it "just works"

**Cap'n Web**:
- ✅ Can hop from User to Room using stubs
- ✅ Clean pattern - just return Workers RPC stubs directly
- ✅ Works like magic when types are compatible
- ⚠️ Limited type support breaks the magic for Map, Set, etc.
*/
it('demonstrates service-to-service hopping', async () => {
  // ==========================================================================
  // Lumenize RPC
  // ==========================================================================
  using lumenizeClient = getLumenizeUserClient('user-lumenize');

  // ✅ Client → User via Lumenize RPC
  // ✅ User.room() forwards method calls to Room via Workers RPC
  // ✅ No explicit proxy methods needed - one generic forwarder!
  const msgId1 = await lumenizeClient.room('lumenize', 'addMessage', 'Hello');
  expect(msgId1).toBe(1);

  const msgId2 = await lumenizeClient.room('lumenize', 'addMessage', 'World');
  expect(msgId2).toBe(2);

  const messages = await lumenizeClient.room('lumenize', 'getMessages');
  expect(messages).toBeInstanceOf(Map); // ✅ Map works seamlessly
  expect(messages.size).toBe(2);
  expect(messages.get(1)).toBe('Hello');
  expect(messages.get(2)).toBe('World');

  // ==========================================================================
  // Cap'n Web - Map type fails
  // ==========================================================================
  using capnwebClient = getCapnWebUserClient();

  // Get a stub to the Room (uses Map)
  // - Cap'n Web User returns Workers RPC stub
  using roomStub = capnwebClient.getRoom('room-capnweb-map');

  // ✅ Client → User via Cap'n Web RPC
  //    (User is RpcTarget instantiated in worker)
  // ✅ User returns Workers RPC stub to Room
  // ✅ Client → Room via the returned Workers RPC stub
  const capnMsgId1 = await roomStub.addMessage('Hello');
  expect(capnMsgId1).toBe(1);

  const capnMsgId2 = await roomStub.addMessage('World');
  expect(capnMsgId2).toBe(2);

  // ❌ Map FAILS even though this is a Workers RPC stub!
  // While Cap'n Web proxies Workers RPC stubs, return values STILL
  // go through Cap'n Web's serialization layer, which doesn't
  // support Map.
  let capnwebThrew = false;
  let capnwebError: Error | undefined;
  try {
    await roomStub.getMessages();
  } catch (e) {
    capnwebThrew = true;
    capnwebError = e as Error;
  }
  expect(capnwebThrew).toBe(true);
  expect(capnwebError?.message).toContain('Cannot serialize value');

  // ==========================================================================
  // Cap'n Web - Plain object works
  // ==========================================================================
  
  // Get a stub to PlainRoom (uses plain object instead of Map)
  using plainRoomStub = capnwebClient.getPlainRoom(
    'room-capnweb-plain'
  );

  const plainMsgId1 = await plainRoomStub.addMessage('Hello');
  expect(plainMsgId1).toBe(1);

  const plainMsgId2 = await plainRoomStub.addMessage('World');
  expect(plainMsgId2).toBe(2);

  // ✅ Plain object works because it's Cap'n Web compatible
  const plainMessages = await plainRoomStub.getMessages();
  expect(plainMessages[1]).toBe('Hello');
  expect(plainMessages[2]).toBe('World');

  // ===========================================================================
  // CONCLUSION: "It Just Works" requires Cap'n Web-compatible types
  // ===========================================================================
  // Cap'n Web can proxy Workers RPC stubs (getRoom() and
  // getPlainRoom() work), but return values STILL go through Cap'n
  // Web serialization.
  // - Map, Set, RegExp, ArrayBuffer: ❌ Fail
  // - Plain objects, arrays, primitives: ✅ Work
  //
  // Compare with Lumenize RPC where Map works seamlessly without
  // workarounds.
});

/*
## Function Callbacks Work (With Limitations)

Cap'n Web supports passing functions as RPC parameters, leveraging Workers RPC's 
ability to pass functions as stubs. When you pass a function, the recipient gets 
a stub that makes an RPC **back** to the sender when called.

**Testing hypothesis**: Does extending RpcTarget instead of DurableObject allow 
callbacks to work across multiple hops?
*/
it('demonstrates function callback support', async () => {
  // ✅ Works: Direct call from client to CapnWebUser (RpcTarget)
  const capnwebClient = getCapnWebClient();

  const receivedMessages: string[] = [];
  
  const myCallback = (message: string) => {
    receivedMessages.push(message);
  };

  // First test: Direct callback works
  const result = await capnwebClient.testCallback(myCallback);
  expect(result).toBe('callback invoked');

  await vi.waitFor(() => {
    expect(receivedMessages).toContain('Hello from CapnWebUser!');
  }, { timeout: 500 });

  // Second test: Multi-hop callback with long-lived connection
  // The key: joinAndListen doesn't return, keeping the RPC connection alive
  const roomMessages: string[] = [];
  const roomCallback = (message: string) => {
    console.log('Client callback received:', message);
    roomMessages.push(message);
  };

  // Start listening - this won't return for 5 seconds
  const listenPromise = capnwebClient.joinRoomAndListen('room-callbacks-test', 'Alice', roomCallback);

  // Give it a moment to establish
  await new Promise(resolve => setTimeout(resolve, 100));

  // Add message which should trigger: DO → User proxy → Client
  // The callback stub is still valid because joinAndListen hasn't returned yet
  await capnwebClient.addRoomMessage('room-callbacks-test', 'Test message via proxy');

  // Wait to see if callback fires
  await vi.waitFor(() => {
    expect(roomMessages).toContain('Test message via proxy');
  }, { timeout: 500 });
  
  expect(roomMessages).toEqual(['Test message via proxy']);
  
  // The listen promise will resolve after 5 seconds (or we could cancel it)
  // For now, just let it timeout naturally
});

/*
## The Type Support Problem

Cap'n Web's "it just works" claim breaks down when you try to use 
StructuredClone types that Workers RPC supports but Cap'n Web doesn't.

**Workers RPC** (DO Storage): Supports all StructuredClone types including 
Map, Set, RegExp, ArrayBuffer, circular references, etc.

**Lumenize RPC**: Supports everything Workers RPC supports (and more).

**Cap'n Web**: Limited type support - no Map, Set, RegExp, ArrayBuffer,
circular references, etc.

For a comprehensive type support comparison, see the 
[basics and types documentation](/docs/rpc/capn-web-comparison-basics-and-types#supported-types).
*/

/*
## Configuration Comparison

**Lumenize RPC**:
- DOs extend `DurableObject` (no special base class required)
- No manual constructor or fetch method needed
- `lumenizeRpcDO()` wrapper handles all RPC setup

**Cap'n Web**:
- DOs must extend `RpcTarget` instead of `DurableObject`
- Must manually implement constructor to capture `ctx` and `env`
- Must manually implement `fetch()` method
- Cannot reuse existing DurableObjects without modification

The configuration differences show Lumenize RPC's design priority: 
make it easy to add RPC to existing DOs without refactoring.
*/

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
