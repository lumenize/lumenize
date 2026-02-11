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
["it just works"](https://github.com/cloudflare/capnweb/tree/main#cloudflare-workers-rpc-interoperability)
This living documentation explores that claim and highlights what we've learned 
about its limitations.

**Our experience**: Cap'n Web's syntax is quite elegant—you can magically 
return an RpcTarget instance or Durable Object stub, and it's conceptually 
consistent. Lumenize RPC is more explicit but similarly concise. We'd give the 
win to Cap'n Web's elegance, except that once you get past the, "Wow! That's 
cool!" we discovered some things that "just don't work" as expected. 

1. **Limited type support**: Cap'n Web doesn't support many types that Workers 
   RPC handles seamlessly (Map, Set, RegExp, ArrayBuffer, circular references, 
   etc.). See the [type support comparison](/docs/rpc/capn-web-comparison-basics-and-types#supported-types).

2. **No hibernating WebSocket support**: Cap'n Web uses `server.accept()` 
   instead of `ctx.acceptWebSocket()`, meaning Durable Objects can't maintain 
   connections through hibernations, which makes sense because...

3. **Workarounds may be required for callbacks**: While passing a function 
   callback over RPC works (which is impressive!), it requires keeping the DO 
   in memory because you can't serialize a callback to restore from storage 
   after it wakes up. We used `setTimeout()`.

4. **Potentially confusing magic**: The syntax is so elegant it might seem "too 
   good to be true"—even our AI coding LLM initially refused to try patterns 
   that actually work, assuming they wouldn't!

**Important**: We might be missing something fundamental. If there are 
different patterns that work better and/or if Cloudflare adds support for more 
types, we'll quickly update this document. Cloudflare has noted that some 
type support "may be added in the future." For now, based on our testing, the 
claim "it just works" comes with significant caveats.
*/

/*
### src/index.ts

Normally, we start off these doc-tests with the tests that show behavior, but 
in this case, we want you to look at the Worker, DurableObjects and RpcTargets 
first.

@import {typescript} "../src/index.ts" [src/index.ts]

Some observations about the three implementations above:

**Lumenize RPC**:
- DOs extend `DurableObject` (no special base class required)
- `lumenizeRpcDO()` wrapper handles all RPC setup, hibernating WebSockets, etc.
- `client.env.ROOM.getByName().addMesssage()` syntax not as slick but works.

**Cap'n Web**:
- Allows you to return DurableObject stubs (`CapnWebRoom` and 
  `CapnWebPlainRoom`)
- Magical syntax for returing an `RpcTarget` instance (`CapnWebUser`)
- `newWorkersRpcResponse` handles all Cap'n Web setup
- Function callbacks require keeping RPC connections alive with `setTimeout()`

**Trade-offs**: Lumenize RPC prioritizes making it easy to add 
RPC to existing DOs without refactoring, while Cap'n Web's elegant syntax of 
directly returning stubs comes with keep alive considerations and dangling 
resource risks.
*/

/*
## Imports
*/
import { it, expect, vi } from 'vitest';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { SELF, env } from 'cloudflare:test';
import { createRpcClient, createWebSocketTransport } from '@lumenize/rpc';
import { getWebSocketShim } from '@lumenize/testing';
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
  expect(lumenizeRpcPackage.version).toBe('0.19.0');
  expect(capnwebPackage.version).toBe('0.1.0');
});

/*
## Creating Clients
*/
function getLumenizeUserClient(instanceName: string) {
  return createRpcClient<typeof User>({
    transport: createWebSocketTransport('USER', instanceName,
      { WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)) }
    )
  });
}

function getCapnWebUserClient() {
  const url = `wss://test.com/capnweb`;
  const ws = new (getWebSocketShim(SELF.fetch.bind(SELF)))(url);
  return newWebSocketRpcSession<CapnWebUser>(ws);
}

// Alias for brevity
const getCapnWebClient = getCapnWebUserClient;

/*
## Service-to-Service Communication

A common pattern in chat applications: User service acts as a gateway/proxy,
hopping to Room services for actual storage operations.
*/

/*
### Hop Between DOs Using `env`

Lumenize RPC seamlessly hops from User to Room via `client.env.ROOM`:
- ✅ Client → User via Lumenize RPC → Room via Workers RPC
- ✅ Map and other StructuredClone types work seamlessly
- ✅ it "just works"

Beware, batching by not `await`ing makes this look more transactional locally 
than it is in reality.
*/
it('demonstrates Lumenize RPC hopping over Workers RPC', async () => {
  using lumenizeClient = getLumenizeUserClient('env-hopping');

  // Client → User via Lumenize RPC → Room via Workers RPC

  // Get stub for room - not as slick as Cap'n Web syntax but works
  const roomStub = lumenizeClient.env.ROOM.getByName('lumenize');

  // In these next two lines, we don't `await` but that's just telling
  // Lumenize RPC to build a batch. When this executes in the ROOM DO
  // it will `await` each of these. That's good and bad. Good because it builds
  // the batch. Bad because it looks more transactional locally than reality.
  roomStub.addMessage('Hello');
  roomStub.addMessage('World');

  const messages = await roomStub.getMessages();
  expect(messages).toBeInstanceOf(Map); // ✅ Map works seamlessly
  expect(messages.size).toBe(2);
  expect(messages.get(1)).toBe('Hello');
  expect(messages.get(2)).toBe('World');
});

/*
### Cap'n Web Type Limitations

Cap'n Web can hop from User to Room by returning Workers RPC stubs directly—a 
clean and elegant pattern. However, even though you're getting a Workers RPC 
stub, return values **still go through Cap'n Web's serialization layer**, which 
has limited type support:

- ✅ Plain objects, arrays, primitives: Work
- ❌ Map, Set, RegExp, ArrayBuffer: Fail
- ❌ Objects with cycles or aliases: Fail
- ❌ it "just doesn't work"

This means you must constrain your DO's return types to Cap'n Web-compatible 
types, even when using Workers RPC stubs or pre/post process.
*/
it('demonstrates Cap\'n Web type limitations', async () => {
  using capnwebClient = getCapnWebUserClient();

  // ==========================================================================
  // Cap'n Web - Map type fails
  // ==========================================================================
  
  // Get a stub to the Room (uses Map)
  // Cap'n Web User returns a Workers RPC stub
  using roomStub = capnwebClient.getRoom('room-capnweb-map');

  // ✅ Client → User via Cap'n Web RPC (User is RpcTarget)
  // ✅ User returns Workers RPC stub to Room DO
  // ✅ Client → Room via the returned stub
  const capnMsgId1 = await roomStub.addMessage('Hello');
  expect(capnMsgId1).toBe(1);

  const capnMsgId2 = await roomStub.addMessage('World');
  expect(capnMsgId2).toBe(2);

  // ❌ Map FAILS even though this is a Workers RPC stub!
  // Return values go through Cap'n Web serialization
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
  using plainRoomStub = capnwebClient.getPlainRoom('room-capnweb-plain');

  const plainMsgId1 = await plainRoomStub.addMessage('Hello');
  expect(plainMsgId1).toBe(1);

  const plainMsgId2 = await plainRoomStub.addMessage('World');
  expect(plainMsgId2).toBe(2);

  // ✅ Plain object works because it's Cap'n Web compatible
  const plainMessages = await plainRoomStub.getMessages();
  expect(plainMessages[1]).toBe('Hello');
  expect(plainMessages[2]).toBe('World');
});

/*
**The bottom line**: Cap'n Web's elegant stub-returning syntax works 
beautifully when your return types are Cap'n Web-compatible (plain objects, 
arrays, primitives). But the moment you need Map, Set, RegExp, ArrayBuffer, or 
objects with cycles or aliases-types that Workers RPC handles seamlessly—you'll 
hit serialization errors or need workarounds.

Lumenize RPC supports all the types that Workers RPC supports (except 
Readable/WritableStream, which Cap'n Web also doesn't support), without 
requiring you to change your DO's return types or add pre/post processing.
*/

/*
## Function Callbacks Work (With Limitations)

Cap'n Web duplicates Workers RPC's ability to pass functions as RPC parameters.
 When you pass a function, the recipient gets a stub that it can use to make a 
 call a **back** to the sender.

**Our Understanding (possibly incomplete)**: Based on our testing, RPC callback 
stubs cannot be serialized, stored, or survive Durable Object hibernation and 
they break when the method that they were passed into returns. This means:

- ✅ The method receiving the callback can invoke it immediately
- ✅ The method can store it in memory and invoke it later
- ❌ But, the callback goes away once the scope is exited or the callee leaves 
     memory

This is why our `join()` method returns a Promise that doesn't resolve for 5 
seconds - it keeps the RPC connection (and thus the callback stub) alive. Maybe 
we're missing something fundamental, and if someone from Cloudflare points out 
our mistake, we'll quickly update this document. But this was the only pattern 
that allows callbacks to survive long enough to be useful.

**Hibernating WebSockets**: Imagine our surprise when we noticed that Cap'n Web 
uses [`server.accept()`](https://github.com/cloudflare/capnweb/blob/c3409357b1c84dd515b4e739786addbdd135c244/src/websocket.ts#L33), 
instead of `ctx.acceptWebSocket()`, meaning that it's not using hibernating 
WebSockets. Then again, when we thought about it, it made sense. Since callback 
stubs can't be serialized, they'd be lost when the DO hibernates anyway. Even 
with hibernating WebSockets, you'd still need to keep the DO instance alive and 
the RPC connection open to use callbacks.

To be fair, until we release LumenizeBase, which solves all of this (supports 
hibernating WebSockets, no dangling resources, etc.) we aren't showing an 
equivalent Lumenize way to support any server to client updates. Stay tuned.

**Bottom line**: Function callbacks provide a syntactically elegant way for the 
server to call the client, but require a `setTimeout()` to prevent losing the 
callback. If there's a batter pattern we've missed, please let us know!
*/
it('demonstrates function callback support', async () => {
  const capnwebClient = getCapnWebClient();

  // Multi-hop callback - client → User → PlainRoom
  const roomMessages: string[] = [];
  const roomCallback = (message: string) => {
    roomMessages.push(message);
  };

  // Get the DO stub directly from User
  const plainRoomStub = capnwebClient.getPlainRoom('room-callbacks-test');
  plainRoomStub.join('Alice', roomCallback);  // join accepts callback. Slick!
  await plainRoomStub.addMessage('Test message direct');

  await vi.waitFor(() => {
    expect(roomMessages).toContain('Test message direct');
  });
  
  expect(roomMessages).toEqual(['Test message direct']);
});

/*
## Installation

```bash npm2yarn
npm install --save-dev vitest@3.2
npm install --save-dev @vitest/coverage-istanbul@3.2
npm install --save-dev @cloudflare/vitest-pool-workers
npm install --save-dev @lumenize/rpc
npm install --save-dev @lumenize/routing
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
