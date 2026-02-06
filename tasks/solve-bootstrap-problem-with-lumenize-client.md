# Solve Bootstrap Problem with LumenizeClient

## Problem

There's a bootstrap problem with `LumenizeClient`:

1. User clicks magic link → server sets `refresh_token` httpOnly cookie
2. Browser JS needs to create `EditorClient` with `instanceName: ${sub}.${tabId}`
3. But JS can't read the `sub` from the httpOnly cookie or the JWT it hasn't fetched yet

Currently, the API requires `instanceName` upfront, but the user has no way to get the `sub` without first calling the refresh endpoint.

## Solution

Hybrid approach combining server-side sub delivery and client-side tabId management:

### Part 1: Server returns `sub` in refresh response

Change refresh endpoint response from:
```json
{ "access_token": "eyJ..." }
```

To:
```json
{ "access_token": "eyJ...", "sub": "user-uuid" }
```

This avoids client-side JWT decoding and doesn't require exposing the public key to the browser.

### Part 2: Auto-generate `instanceName` with sessionStorage tabId

Client auto-constructs `instanceName` as `${sub}.${tabId}` where:
- `sub` comes from refresh response
- `tabId` comes from sessionStorage with duplicate-tab mitigation via BroadcastChannel

**Duplicate tab detection using BroadcastChannel:**

When a tab is duplicated, `sessionStorage` is cloned — both tabs would have the same tabId. We use BroadcastChannel to detect this, with the tabId itself as the channel name:

```typescript
async function getOrCreateTabId(): Promise<string> {
  const stored = sessionStorage.getItem('lmz_tab');

  if (stored) {
    // Check if another tab is already using this tabId
    const isInUse = await checkTabIdInUse(stored);
    if (!isInUse) {
      // No other tab responded — safe to reuse
      setupTabIdListener(stored);
      return stored;
    }
    // Another tab has this tabId — we're a duplicate, regenerate
  }

  const tabId = crypto.randomUUID().slice(0, 8);
  sessionStorage.setItem('lmz_tab', tabId);
  setupTabIdListener(tabId);
  return tabId;
}

function setupTabIdListener(tabId: string): void {
  // Permanent listener responds to probes from duplicate tabs
  const channel = new BroadcastChannel(tabId);
  channel.onmessage = () => {
    channel.postMessage('in-use');
  };
  // Note: channel stays open for lifetime of tab
}

function checkTabIdInUse(tabId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(tabId);
    const timeout = setTimeout(() => {
      channel.close();
      resolve(false); // No response — tabId is available
    }, 50);

    channel.onmessage = () => {
      clearTimeout(timeout);
      channel.close();
      resolve(true); // Got response — tabId is in use
    };

    channel.postMessage('probe');
  });
}
```

**Why tabId as channel name**: Using the tabId itself as the channel name means:
- Each tabId has exactly one listener (the tab that owns it)
- Probes go directly to the tab we're checking, not broadcast to all tabs
- No need to coordinate message formats or filter by tabId in handlers

**Parallel optimization**: The 50ms duplicate check can run in parallel with the token refresh call. We wait for the longer of the two to complete before constructing the `instanceName`. This avoids adding 50ms latency to the critical path.

```typescript
// Both operations start simultaneously
const [tabId, refreshResponse] = await Promise.all([
  getOrCreateTabId(),      // 50ms max
  fetchRefreshToken(),     // Network latency (usually >50ms)
]);
const instanceName = `${refreshResponse.sub}.${tabId}`;
```

**When not in a browser**: If LumenizeClient is not running in a browser, you don't need refresh protection which is good because you wouldn't have sessionStorage or BroadcastChannel. We just need to make sure that we fail gracefully if these APIs are not available.

### Part 3: Updated API

```typescript
// Minimal — everything auto-detected
using client = new EditorClient({
  baseUrl: 'https://example.com',
  refresh: '/auth/refresh-token',
});
```

**Alternatives considered**:
- Providing an optional instanceName overide. Rejected as YAGNI and preference for batteries included fewer config options

### Part 4: Consider Returning `sub` in Additional Cookie

Maybe as a standard session cookie.

## Implementation Steps

1. **Update `@lumenize/auth` refresh endpoint** to include `sub` in response body
2. **Update `LumenizeClient`** to:
   - Make `instanceName` optional in config
   - Add `getOrCreateTabId()` helper with duplicate-tab detection
   - On connect (if no `instanceName`): call refresh first, extract `sub`, construct `instanceName`
   - Store the auto-generated `instanceName` for reconnection
3. **Update tests** to work with optional `instanceName`
4. **Update docs** — getting-started.mdx example becomes simpler

## Files to Change

- `packages/auth/src/lumenize-auth.ts` — refresh endpoint response
- `packages/mesh/src/lumenize-client.ts` — optional instanceName, auto-generation
- `packages/mesh/test/for-docs/getting-started/index.test.ts` — update test
- `website/docs/mesh/getting-started.mdx` — simplify example
- `website/docs/mesh/lumenize-client.mdx` — document new behavior

## Testing

- Test that client connects successfully without explicit `instanceName`
- Test that tab refresh reconnects to same Gateway (same tabId via sessionStorage)
- Test that duplicate tab gets different tabId (BroadcastChannel detects conflict)
- Test that parallel optimization works (check and refresh run concurrently)
- Test graceful fallback when sessionStorage/BroadcastChannel unavailable (non-browser)
