# Upgrade Browser Class with Storage APIs

> **Blocks**: [solve-bootstrap-problem-with-lumenize-client.md](./solve-bootstrap-problem-with-lumenize-client.md)

## Open Question: Where Should Browser Live?

Currently `Browser` lives in `@lumenize/utils` (`packages/utils/src/browser.ts`) alongside DO routing utilities. It's re-exported from `@lumenize/testing` with a thin wrapper that injects `SELF.fetch`. This upgrade is a natural moment to decide on its permanent home.

### Analysis of @lumenize/utils

After this potential split, @lumenize/utils contains two cleanly separated groups:

**Group A: DO Routing (5 modules, ~728 lines)**
- `route-do-request.ts` — main DO request router with hooks & CORS
- `parse-pathname.ts` — URL path parsing
- `get-do-namespace-from-path-segment.ts` — case-insensitive binding lookup
- `get-do-stub.ts` — create DO stubs from namespace + name/ID
- `is-durable-object-id.ts` — validate 64-char hex DO IDs
- Dependencies: `@lumenize/debug` only
- Used by: `@lumenize/mesh`, `@lumenize/auth`

**Group B: Browser/HTTP Client (4 modules, ~900+ lines)**
- `browser.ts` — cookie-aware HTTP/WebSocket client
- `cookie-utils.ts` — cookie parsing, serialization, matching
- `websocket-shim.ts` — WebSocket via fetch for test environments
- `websocket-utils.ts` — detect WebSocket upgrade requests (15 lines, also used by routing)
- Dependencies: none beyond internal
- Used by: `@lumenize/testing` (re-export), `@lumenize/auth` (type import in test helpers)

**Shared**: `metrics.ts` (55 lines, type definitions only)

### Options

**Option A: Move Browser to `@lumenize/testing`** (recommended)
- Flatten the re-export indirection — Browser becomes the real implementation in @lumenize/testing
- 95%+ usage is testing; the 5% node.js scripting works fine since Browser already accepts a custom `baseFetch` argument (no cloudflare:test dependency required)
- Move cookie-utils, websocket-shim, metrics type alongside it
- Leave websocket-utils in both (15 lines, copy is fine) or extract to tiny shared module
- Rename remaining @lumenize/utils to `@lumenize/routing`

**Option B: Create `@lumenize/browser`**
- Dedicated package for the HTTP client
- Cleaner for the node.js scripting use case
- More packages to maintain
- @lumenize/testing would import from @lumenize/browser instead of @lumenize/utils

**Option C: Keep in `@lumenize/utils`, don't split**
- Least work
- Package remains a grab-bag
- @lumenize/utils as a name becomes increasingly misleading

### Decision

_TBD — decide before starting implementation._

## Motivation

The `Browser` class in `@lumenize/testing` (via `@lumenize/utils`) is the primary tool for testing `LumenizeClient` instances. Adding `sessionStorage`, `localStorage`, and `BroadcastChannel` support enables:

1. **Testing the LumenizeClient bootstrap flow** — auto-generated `instanceName` using `sessionStorage` tabId with `BroadcastChannel` duplicate detection (see [solve-bootstrap-problem-with-lumenize-client.md](./solve-bootstrap-problem-with-lumenize-client.md))
2. **Broader testing capability** — any user building browser apps with Lumenize gains realistic tab/storage simulation
3. **Duplicate-tab testing** — `browser.duplicateTab(existingTab)` clones sessionStorage, enabling the exact scenario BroadcastChannel is designed to detect

## Current State

The Browser class (~770 lines, 1020-line test suite) currently supports:
- Cookie management (comprehensive, RFC-compliant)
- Cookie-aware `fetch` with redirect following
- WebSocket shim with cookie integration
- `context(origin)` returning `{ fetch, WebSocket }` per origin with full CORS simulation
- Metrics tracking

It does NOT support: sessionStorage, localStorage, BroadcastChannel, or any concept of "tab" identity beyond origin contexts.

## Design

### Tab Model

The key insight is that `context(origin)` needs to evolve into a "tab" concept. Currently contexts are stateless wrappers — they just scope fetch/WebSocket to an origin. Tabs add per-tab state:

```typescript
// Current API
const ctx = browser.context('https://example.com');
ctx.fetch(...)   // Cookie-aware, CORS-validated
ctx.WebSocket    // Cookie-aware shim

// New API — backward compatible, adds storage
const tab = browser.tab('https://example.com');
tab.fetch(...)          // Same as before
tab.WebSocket           // Same as before
tab.sessionStorage      // Per-tab, per-origin
tab.localStorage        // Per-origin, shared across tabs
tab.BroadcastChannel    // Per-origin, cross-tab messaging
```

**Backward compatibility**: `context()` can become an alias for `tab()` or remain as-is for contexts that don't need storage. Decide during implementation.

### sessionStorage

- Scoped per-tab, per-origin
- Implements full `Storage` interface: `getItem()`, `setItem()`, `removeItem()`, `clear()`, `key()`, `length`
- Backed by `Map<string, string>` — one map per tab
- Cleared when tab is "closed" (if we support that lifecycle)

### localStorage

- Scoped per-origin, shared across all tabs from same origin
- Same `Storage` interface as sessionStorage
- Backed by `Map<string, string>` — one map per origin, shared across tabs
- Persists for Browser instance lifetime
- `storage` events fired to other tabs when values change (stretch goal)

### BroadcastChannel

- Scoped per-origin, cross-tab messaging
- Implements: `postMessage(message)`, `close()`, `onmessage` handler
- Messages from one channel instance are delivered to all other instances with the same name and origin
- **Critical**: messages must be delivered asynchronously (microtask/setTimeout), matching real browser behavior
- Extends EventTarget (same pattern as existing WebSocketShim)
- Track channels by name and origin: `Map<origin, Map<channelName, Set<BroadcastChannelInstance>>>`

### Tab Duplication

For testing duplicate-tab detection:

```typescript
const tab1 = browser.tab('https://example.com');
// tab1.sessionStorage has { lmz_tab: 'abc12345' }

const tab2 = browser.duplicateTab(tab1);
// tab2.sessionStorage is a CLONE of tab1's — { lmz_tab: 'abc12345' }
// tab2 shares localStorage with tab1 (same origin)
// tab2 shares BroadcastChannel namespace with tab1 (same origin)
// tab2 has its own fetch/WebSocket (separate cookies? or shared?)
```

This enables testing the exact scenario from the bootstrap task: two tabs with cloned sessionStorage, BroadcastChannel probe detects the collision, duplicate tab regenerates its tabId.

### Open Design Questions

1. **Tab lifecycle** — should tabs have an explicit `close()` that clears sessionStorage and unregisters BroadcastChannel listeners? Probably yes for cleanup in tests.
2. **`storage` events for localStorage** — real browsers fire `StorageEvent` on other tabs when localStorage changes. Worth implementing? Probably a stretch goal.
3. **Cookie sharing** — currently all contexts share cookies (correct browser behavior). Tabs should continue this. Confirm.
4. **`context()` vs `tab()` naming** — deprecate `context()`, or keep both? `tab()` is more intuitive for the new capabilities. Could alias `context()` → `tab()` with a deprecation notice.

## Implementation Steps

1. **Decide on package location** (open question above)
2. **Implement `Storage` mock class** — memory-backed, full interface compliance
3. **Implement `BroadcastChannel` mock class** — EventTarget-based, async message delivery
4. **Create tab abstraction** — wraps existing context with storage + channel access
5. **Implement `duplicateTab()`** — clones sessionStorage, shares localStorage and BroadcastChannel namespace
6. **Update existing context() API** — either alias to tab() or keep parallel
7. **Write comprehensive tests** — per-tab isolation, cross-tab sharing, duplicate-tab cloning, BroadcastChannel messaging, async delivery timing
8. **Update @lumenize/testing** — re-export or integrate depending on package decision

## Files to Change

Depends on package decision. If staying in @lumenize/utils:

- `packages/utils/src/browser.ts` — add tab abstraction, integrate storage/channels
- `packages/utils/src/storage-mock.ts` — **new file**, Storage interface implementation
- `packages/utils/src/broadcast-channel-mock.ts` — **new file**, BroadcastChannel implementation
- `packages/utils/test/browser.test.ts` — extend with storage/channel tests
- `packages/testing/src/index.ts` — update re-export if API changes

## Testing

- sessionStorage is per-tab isolated (tab1 writes don't appear in tab2)
- sessionStorage within same origin but different tabs is independent
- localStorage is shared across tabs of same origin
- localStorage is isolated across different origins
- BroadcastChannel delivers messages to other instances with same name/origin
- BroadcastChannel does NOT deliver messages to the posting instance
- BroadcastChannel messages are delivered asynchronously
- BroadcastChannel `close()` stops message delivery
- `duplicateTab()` clones sessionStorage contents
- `duplicateTab()` shares localStorage reference
- `duplicateTab()` shares BroadcastChannel namespace (can communicate)
- Tab close cleans up BroadcastChannel listeners and sessionStorage
- Full integration: duplicate-tab detection via BroadcastChannel probe (the bootstrap scenario)
