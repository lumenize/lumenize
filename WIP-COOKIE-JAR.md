# Cookie Jar Implementation - WIP & Design Doc

**Status:** Design & Planning  
**Target Package:** `@lumenize/utils`  
**Date Started:** October 4, 2025

---

## 🎯 Goal

Provide cookie jar functionality for testing user-built Durable Objects and Workers that rely on cookie-based session management. This is a **testing utility** - NOT for use in the RPC client itself.

---

## 📋 Use Case

Users building DOs/Workers with cookie-based authentication need to test cookie flows:

```typescript
import { CookieJar } from '@lumenize/utils';
import { createRpcClient } from '@lumenize/rpc';

// Create cookie jar and get cookie-aware fetch
const cookieJar = new CookieJar();
const cookieAwareFetch = cookieJar.getFetch(SELF.fetch.bind(SELF));

// Regular RPC client for state inspection (NO cookies)
const client = createRpcClient({
  fetch: SELF.fetch.bind(SELF), // Plain fetch, no cookies
  baseUrl: 'https://example.com',
  doBindingName: 'MY_DO',
  doInstanceNameOrId: 'test-instance',
});

// Test user's authentication flow with cookies
const loginResponse = await cookieAwareFetch(
  'https://my-do/instance-name/login?username=me&password=123'
);
expect(loginResponse.ok).toBe(true);

// Cookie automatically included in next request
const response = await cookieAwareFetch(
  'https://my-do/instance-name/set-something-which-requires-cookie-from-login'
);
expect(response.ok).toBe(true);

// Inspect DO state via RPC (separate from cookie flow)
expect(await client.ctx.storage.kv.get('something')).toBe('expected');

// Manual cookie inspection/manipulation
expect(cookieJar.getCookie('session')).toBe('session-token');
cookieJar.setCookie('custom', 'value', { domain: 'example.com' });
```

---

## 🏗️ Architecture

### Package Location

**`@lumenize/utils`** - Pure utility with no RPC dependencies

Files to add:
```
packages/utils/src/
  cookie-jar.ts          # CookieJar class with getFetch() method
  cookie-utils.ts        # Cookie parsing/serialization utilities
  index.ts               # Export CookieJar and utilities
```

### API Design

#### **CookieJar Class**

```typescript
export class CookieJar {
  /**
   * Create a cookie-aware fetch function that automatically manages cookies
   * 
   * @param baseFetch - The base fetch function to wrap (e.g., SELF.fetch.bind(SELF))
   * @returns A fetch function that automatically handles cookies
   */
  getFetch(baseFetch: typeof fetch): typeof fetch;

  /**
   * Get a specific cookie by name
   * 
   * @param name - Cookie name
   * @param domain - Optional domain filter
   * @returns Cookie value or undefined if not found
   */
  getCookie(name: string, domain?: string): string | undefined;

  /**
   * Manually set a cookie
   * 
   * @param name - Cookie name
   * @param value - Cookie value
   * @param options - Optional cookie attributes (domain, path, expires, etc.)
   */
  setCookie(name: string, value: string, options?: CookieOptions): void;

  /**
   * Get all cookies as an array of cookie objects
   */
  getAllCookies(): Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: Date;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  }>;

  /**
   * Remove a cookie
   * 
   * @param name - Cookie name
   * @param domain - Optional domain filter
   * @param path - Optional path filter
   */
  removeCookie(name: string, domain?: string, path?: string): void;

  /**
   * Clear all cookies
   */
  clear(): void;

  /**
   * Set the default hostname for manually set cookies
   * 
   * @param hostname - Default hostname for cookies
   */
  setDefaultHostname(hostname: string): void;

  /**
   * Enable or disable cookie jar functionality
   * 
   * @param enabled - Whether to enable cookie jar
   */
  setEnabled(enabled: boolean): void;

  /**
   * Check if cookie jar is enabled
   */
  isEnabled(): boolean;
}
```

#### **Cookie Utilities**

```typescript
export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function parseSetCookie(setCookieHeader: string): Cookie | null;
export function parseSetCookies(setCookieHeaders: string[]): Cookie[];
export function serializeCookies(cookies: Cookie[]): string;
export function cookieMatches(cookie: Cookie, domain: string, path: string): boolean;
```

---

## 🔌 Integration with WebSocket Shim

### Current Issue

`getWebSocketShim()` currently accepts the entire `SELF` object:

```typescript
// Current signature
export function getWebSocketShim(SELF: any, factoryInit?: FactoryInit): WebSocketClass
```

But it only uses `SELF.fetch()` internally:

```typescript
// Inside websocket-shim.ts, line 220
const resp = await SELF.fetch(req);
```

### Proposed Solution

**Change signature to accept fetch function directly:**

```typescript
// New signature
export function getWebSocketShim(
  fetchFn: typeof fetch, 
  factoryInit?: FactoryInit
): WebSocketClass
```

**Benefits:**
1. ✅ More explicit about dependencies
2. ✅ Allows passing `cookieAwareFetch` for WebSocket connections
3. ✅ Better separation of concerns
4. ✅ Easier to test (can mock fetch directly)

**Migration impact:**
```typescript
// Old usage
const WebSocketClass = getWebSocketShim(SELF);

// New usage
const WebSocketClass = getWebSocketShim(SELF.fetch.bind(SELF));

// With cookie jar
const cookieJar = new CookieJar();
const cookieAwareFetch = cookieJar.getFetch(SELF.fetch.bind(SELF));
const WebSocketClass = getWebSocketShim(cookieAwareFetch);
```

---

## 🧪 WebSocket + Cookie Jar Use Case

```typescript
import { CookieJar } from '@lumenize/utils';
import { createRpcClient, getWebSocketShim } from '@lumenize/rpc';

const cookieJar = new CookieJar();
const cookieAwareFetch = cookieJar.getFetch(SELF.fetch.bind(SELF));

// WebSocket with cookies (for user's custom WebSocket endpoint)
const WebSocketClass = getWebSocketShim(cookieAwareFetch);
const customWs = new WebSocketClass('wss://my-do/instance-name/custom-ws');

// RPC client with regular fetch (for state inspection)
const client = createRpcClient({
  fetch: SELF.fetch.bind(SELF), // No cookies
  baseUrl: 'https://example.com',
  doBindingName: 'MY_DO',
  doInstanceNameOrId: 'instance-name',
  transport: 'websocket',
  WebSocketClass: getWebSocketShim(SELF.fetch.bind(SELF)), // Separate WS for RPC
});

// Test flow:
// 1. Login via HTTP (sets cookie)
await cookieAwareFetch('https://my-do/instance-name/login?user=me&pass=123');

// 2. Custom WebSocket upgrade includes session cookie automatically
customWs.onopen = () => {
  customWs.send('authenticated-command');
};

// 3. Inspect DO state via RPC
expect(await client.ctx.storage.get('user-session')).toBeDefined();
```

---

## ✅ Implementation Checklist

### Phase 0: WebSocket Shim Update (COMPLETED ✅)
- [x] Update `getWebSocketShim()` signature in `@lumenize/rpc`
  - [x] Change parameter from `SELF: any` to `fetchFn: typeof fetch`
  - [x] Update internal usage (line 220)
  - [x] Update JSDoc examples
- [x] Update all test files using `getWebSocketShim()`
  - [x] `test/client.test.ts` - 3 usages
  - [x] `test/websocket-integration.test.ts` - 2 usages  
  - [x] `test/matrix.test.ts` - 2 usages
  - [x] `test/subclass.test.ts` - 5 usages
  - [x] All 129 tests passing ✅

**Decision:** Updated in place first, will move to `@lumenize/utils` after cookie jar implementation

### Phase 1: Cookie Utilities (COMPLETED ✅)
- [x] Port `cookie-utils.ts` to `@lumenize/utils/src/`
  - [x] `Cookie` interface
  - [x] `parseSetCookie()` function
  - [x] `parseSetCookies()` function
  - [x] `serializeCookies()` function
  - [x] `cookieMatches()` function
- [x] Add tests for cookie utilities
  - [x] Parsing Set-Cookie headers (18 tests)
  - [x] Domain/path matching (15 tests)
  - [x] Expiration handling
  - [x] Edge cases
  - [x] All 33 cookie-utils tests passing ✅

### Phase 2: CookieJar Class (COMPLETED ✅)
- [x] Port `cookie-jar.ts` to `@lumenize/utils/src/`
  - [x] Implement `getFetch()` method (NEW API - clean design!)
  - [x] Migrate `storeCookiesFromResponse()`
  - [x] Migrate `getCookiesForRequest()`
  - [x] Migrate `getCookie()`, `setCookie()`, `getAllCookies()`
  - [x] Migrate `removeCookie()`, `clear()`
  - [x] Migrate `setDefaultHostname()`, hostname inference
  - [x] Migrate `setEnabled()`, `isEnabled()`
- [x] Add tests for CookieJar
  - [x] `getFetch()` wraps fetch correctly
  - [x] Cookies stored from response
  - [x] Cookies sent in subsequent requests
  - [x] Domain/path isolation
  - [x] Hostname inference behavior
  - [x] Enable/disable toggle
  - [x] Integration tests (full login/session flow, multi-domain)
  - [x] All 23 CookieJar tests passing ✅
- [x] Export from `@lumenize/utils/src/index.ts`
- [x] **Total: 128 tests passing in @lumenize/utils** ✅

### Phase 3: Move WebSocket Shim to @lumenize/utils (COMPLETED ✅)
- [x] Move `websocket-shim.ts` from `@lumenize/rpc/src` to `@lumenize/utils/src`
- [x] Update `@lumenize/utils/src/index.ts` to export `getWebSocketShim`
- [x] Update `@lumenize/rpc/src/index.ts` to re-export from `@lumenize/utils`
- [x] Add `@lumenize/utils` dependency to `@lumenize/rpc/package.json`
- [x] Remove old `websocket-shim.ts` from `@lumenize/rpc`
- [x] Verify all tests still pass
  - [x] All 129 RPC tests passing ✅
  - [x] All 128 utils tests passing ✅

**Result:** WebSocket shim now lives in `@lumenize/utils` and is re-exported by `@lumenize/rpc` for backward compatibility. Users can now import from either package, enabling cookie-aware WebSocket connections!

### Phase 4: Documentation & Examples
- [ ] Add CookieJar to `@lumenize/utils` README
- [ ] Document WebSocket + CookieJar pattern
- [ ] Add example test showing full flow:
  - [ ] HTTP login with cookies
  - [ ] Subsequent HTTP requests with cookies
  - [ ] WebSocket upgrade with cookies
  - [ ] RPC client for state inspection (without cookies)
- [ ] Update migration guide for `getWebSocketShim()` signature change

### Phase 5: Integration Testing
- [ ] Test CookieJar with HTTP requests
- [ ] Test CookieJar with WebSocket upgrades
- [ ] Test coexistence of:
  - [ ] Cookie-aware custom WebSocket
  - [ ] Cookie-less RPC WebSocket
  - [ ] Both using same DO instance
- [ ] Test real-world authentication flow

---

## 🔍 Open Questions

1. **Breaking Change:** Changing `getWebSocketShim(SELF)` to `getWebSocketShim(SELF.fetch.bind(SELF))` is a breaking change. Should we:
   - ✅ Just make the change (simple, clean)
   - ⚠️ Support both signatures temporarily (complex, confusing)
   - ⚠️ Create new function `getWebSocketShimFromFetch()` (verbose)

2. **Export Strategy:** Should we re-export CookieJar from `@lumenize/rpc` for convenience?
   - Pro: Users already import from `@lumenize/rpc` for tests
   - Con: Creates coupling between packages
   - **Decision:** Keep in `@lumenize/utils`, document clearly

3. **Hostname Inference:** Current implementation has complex rules:
   - First fetch sets hostname if not manually set
   - Manual setting always wins (last manual wins)
   - Should we simplify this? Current behavior seems reasonable.

4. **TypeScript Types:** Should `getFetch()` return a more specific type than `typeof fetch`?
   - Current: Returns generic fetch function
   - Could add branded type to track it came from CookieJar
   - **Decision:** Keep simple for now

---

## 📝 Implementation Notes

### Source Files from @lumenize/testing

Copy and adapt from:
- `packages/testing/src/cookie-jar.ts` (267 lines)
- `packages/testing/src/cookie-utils.ts` (121 lines)

**Changes needed:**
1. Remove `createCookieAwareSELF()` helper (not needed)
2. Add `getFetch()` method to CookieJar class
3. Update imports/exports for `@lumenize/utils`

### WebSocket Shim Changes

File: `packages/rpc/src/websocket-shim.ts`

**Line 220 change:**
```typescript
// Before
const resp = await SELF.fetch(req);

// After
const resp = await fetchFn(req);
```

**Function signature change (line ~88):**
```typescript
// Before
export function getWebSocketShim(SELF: any, factoryInit?: FactoryInit): WebSocketClass

// After  
export function getWebSocketShim(fetchFn: typeof fetch, factoryInit?: FactoryInit): WebSocketClass
```

---

## 🚀 Next Steps

1. **Review this design doc** - Confirm approach before implementation
2. **Port cookie utilities** - Start with pure utility functions (no side effects)
3. **Port CookieJar class** - Add `getFetch()` method
4. **Update WebSocket shim** - Change signature to accept fetch function
5. **Update all tests** - Migrate ~12 call sites
6. **Add integration tests** - Test full cookie flow with WebSockets
7. **Document** - Update READMEs and add examples

---

## 📚 References

- Original implementation: `packages/testing/src/cookie-jar.ts`
- WebSocket shim: `packages/rpc/src/websocket-shim.ts`
- Example test: `packages/testing/test/demonstrate-features.test.ts`
- Comprehensive test: `examples/testing-plain-do/test/comprehensive.test.ts` (Cookie Management tests)
