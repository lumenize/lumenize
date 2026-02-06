# Upgrade Browser Class with Storage APIs

> **Blocks**: [solve-bootstrap-problem-with-lumenize-client.md](./solve-bootstrap-problem-with-lumenize-client.md)

## Decision: Move Browser to `@lumenize/testing`

Browser and its dependencies (cookie-utils, websocket-shim, websocket-utils, metrics) move from `@lumenize/utils` to `@lumenize/testing`. The existing thin wrapper that injects `SELF.fetch` gets flattened — Browser becomes the real implementation directly in `@lumenize/testing`. Node.js scripting use case still works since Browser accepts a custom `baseFetch` argument (no cloudflare:test dependency required).

Renaming the remaining `@lumenize/utils` → `@lumenize/routing` is a separate follow-up (see backlog.md).

## Motivation

The `Browser` class is the primary tool for testing `LumenizeClient` instances. Adding `sessionStorage` and `BroadcastChannel` support enables:

1. **Testing the LumenizeClient bootstrap flow** — auto-generated `instanceName` using `sessionStorage` tabId with `BroadcastChannel` duplicate detection (see [solve-bootstrap-problem-with-lumenize-client.md](./solve-bootstrap-problem-with-lumenize-client.md))
2. **Broader testing capability** — any user building browser apps with Lumenize gains realistic tab/storage simulation
3. **Duplicate-tab testing** — `browser.duplicateContext(existingContext)` clones sessionStorage, enabling the exact scenario BroadcastChannel is designed to detect

## Current State

The Browser class (~770 lines, 1020-line test suite) currently supports:
- Cookie management (comprehensive, RFC-compliant)
- Cookie-aware `fetch` with redirect following
- WebSocket shim with cookie integration
- `context(origin)` returning `{ fetch, WebSocket }` per origin with full CORS simulation
- Metrics tracking

It does NOT support: sessionStorage, BroadcastChannel, or any concept of per-context state beyond origin scoping.

## Design

### Context Evolution

`context(origin)` currently returns a plain object `{ fetch, WebSocket, lastPreflight }`. It evolves to return a `Context` class instance that adds per-context state while remaining backward compatible (existing destructuring still works):

```typescript
// Current API — still works
const { fetch, WebSocket } = browser.context('https://example.com');

// New API — same method, richer return type
const ctx = browser.context('https://example.com');
ctx.fetch(...)              // Same as before
ctx.WebSocket               // Same as before
ctx.sessionStorage          // Per-context, per-origin
ctx.BroadcastChannel        // Constructor, scoped to origin
```

Each `browser.context()` call creates a new `Context` instance (conceptually a new "tab"). Multiple contexts with the same origin share the BroadcastChannel namespace but have independent sessionStorage.

### `Context` Class

```typescript
class Context {
  readonly fetch: typeof fetch;
  readonly WebSocket: typeof WebSocket;
  readonly sessionStorage: Storage;
  readonly BroadcastChannel: typeof BroadcastChannel;  // constructor
  readonly lastPreflight: PreflightInfo | null;
  close(): void;  // cleanup: clear sessionStorage, close BroadcastChannels
}
```

### sessionStorage

- Scoped per-context (each `browser.context()` call gets its own)
- Implements `Storage` interface: `getItem()`, `setItem()`, `removeItem()`, `clear()`, `key()`, `length`
- Backed by `Map<string, string>`
- Cleared when context is closed
- No Proxy-based index access (`storage['key']`, `storage[0]`) — method API only. Note this in docs as a known limitation.

### BroadcastChannel

- Scoped per-origin, cross-context messaging
- Implements: `postMessage(message)`, `close()`, `onmessage` handler
- Messages from one channel instance delivered to all other instances with same name and origin
- **Critical**: messages delivered asynchronously via `queueMicrotask()`, matching real browser behavior
- Extends EventTarget (same pattern as existing WebSocketShim)
- Registry tracked by Browser instance: `Map<origin, Map<channelName, Set<BroadcastChannelInstance>>>`

### Context Duplication

For testing duplicate-tab detection:

```typescript
const ctx1 = browser.context('https://example.com');
// ctx1.sessionStorage has { lmz_tab: 'abc12345' }

const ctx2 = browser.duplicateContext(ctx1);
// ctx2.sessionStorage is a CLONE of ctx1's — { lmz_tab: 'abc12345' }
// ctx2 shares BroadcastChannel namespace with ctx1 (same origin)
// ctx2 shares cookies with ctx1 (same browser — already the case)
// ctx2 has its own fetch/WebSocket
```

### Deferred: localStorage and StorageEvent

localStorage is skipped for now. The bootstrap task only needs sessionStorage and BroadcastChannel. localStorage's main cross-tab feature is `StorageEvent` (fired on other tabs when values change), which adds real complexity. When there's demand, add both together. Note this in docs as a planned future enhancement.

## Design Decisions

1. **Keep `context()` name** — it's the correct browser spec term ("browsing context") and already established in the API
2. **Return a `Context` class** instead of plain object — backward compatible, adds lifecycle management
3. **BroadcastChannel delivery via `queueMicrotask()`** — matches real browser async semantics, important for bootstrap task's Promise-based duplicate detection
4. **Skip Proxy-based index access on Storage** — nobody uses `storage[0]` or `storage['key']` in practice; method API only
5. **Skip localStorage and StorageEvent** — not needed for bootstrap task; add later when there's demand
6. **Package move is first commit** — move files, verify tests pass, then add features

## Implementation Steps

### Phase 1: Package Move

1. **Move Browser modules** from `packages/utils/src/` to `packages/testing/src/`:
   - `browser.ts`, `cookie-utils.ts`, `websocket-shim.ts`, `metrics.ts`
   - Copy `websocket-utils.ts` (15 lines, also used by routing — keep in both)
2. **Move Browser tests** from `packages/utils/test/` to `packages/testing/test/`
3. **Flatten @lumenize/testing's Browser wrapper** — remove the subclass indirection, make Browser the primary implementation with optional `SELF.fetch` injection
4. **Update imports** across monorepo:
   - `@lumenize/auth` test helpers: `Browser` import → `@lumenize/testing`
   - Any other consumers of Browser from `@lumenize/utils`
5. **Remove moved files** from `@lumenize/utils`
6. **Update package.json** files (exports, dependencies)
7. **Verify all tests pass**

### Phase 2: BroadcastChannel (implement first — highest risk)

1. **Implement BroadcastChannel mock** — EventTarget-based, async delivery via `queueMicrotask()`
2. **Add channel registry to Browser** — tracks channels by origin and name
3. **Wire into Context** — each context gets a `BroadcastChannel` constructor scoped to its origin
4. **Test**: cross-context messaging, async delivery, close() cleanup, same-name isolation

### Phase 3: sessionStorage

1. **Implement Storage mock** — Map-backed, full interface (getItem/setItem/removeItem/clear/key/length)
2. **Add per-context storage to Context class**
3. **Test**: per-context isolation, clear on close

### Phase 4: Context Class and `duplicateContext()`

1. **Replace plain object return** from `context()` with `Context` class
2. **Add `close()` method** — clears sessionStorage, closes BroadcastChannels
3. **Implement `browser.duplicateContext(ctx)`** — clones sessionStorage, shares BroadcastChannel namespace
4. **Test**: duplication clones storage, channels can communicate across original and duplicate

### Phase 5: Integration Test

1. **Full bootstrap scenario test** — duplicate-context detection via BroadcastChannel probe
   - Create context, set `lmz_tab` in sessionStorage
   - Duplicate the context
   - Duplicated context probes via BroadcastChannel, detects conflict
   - Duplicated context regenerates tabId

## Files to Change

### Phase 1 (package move)
- `packages/testing/src/browser.ts` — **moved from utils**, flatten SELF.fetch wrapper
- `packages/testing/src/cookie-utils.ts` — **moved from utils**
- `packages/testing/src/websocket-shim.ts` — **moved from utils**
- `packages/testing/src/metrics.ts` — **moved from utils**
- `packages/testing/src/index.ts` — update exports
- `packages/testing/test/browser.test.ts` — **moved from utils**
- `packages/testing/package.json` — update if needed
- `packages/utils/src/index.ts` — remove Browser-related exports
- `packages/utils/package.json` — update if needed
- `packages/auth/src/test-helpers.ts` — update Browser import

### Phase 2-5 (features)
- `packages/testing/src/browser.ts` — Context class, duplicateContext(), channel registry
- `packages/testing/src/storage-mock.ts` — **new file**
- `packages/testing/src/broadcast-channel-mock.ts` — **new file**
- `packages/testing/test/browser.test.ts` — extend with storage/channel/duplication tests

## Testing

- sessionStorage is per-context isolated (ctx1 writes don't appear in ctx2)
- BroadcastChannel delivers messages to other instances with same name/origin
- BroadcastChannel does NOT deliver to the posting instance itself
- BroadcastChannel messages are delivered asynchronously (verify with timing)
- BroadcastChannel `close()` stops message delivery to that instance
- `duplicateContext()` clones sessionStorage contents
- `duplicateContext()` shares BroadcastChannel namespace (can communicate)
- Context `close()` cleans up BroadcastChannel listeners and sessionStorage
- Full integration: duplicate-tab detection via BroadcastChannel probe (the bootstrap scenario)
- All existing Browser tests still pass after package move (Phase 1 gate)
