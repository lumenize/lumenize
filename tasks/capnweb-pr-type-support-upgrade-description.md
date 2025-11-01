# Add Support for Additional Serialization Types

Adds serialization support for additional JavaScript types to align with Cloudflare Workers RPC capabilities.

## Types Added

### Special Numbers
`["special-number", "NaN"|"Infinity"|"-Infinity"]`

### JavaScript Built-in Types
- **RegExp**: `["regexp", {source: string, flags: string}]`
- **Map**: `["map", [[[key1, val1]], [[key2, val2]], ...]]`
- **Set**: `["set", [[val1], [val2], ...]]`
- **ArrayBuffer**: `["arraybuffer", "base64string"]` (same encoding as `Uint8Array`/`"bytes"`, different tag to preserve type)

### Web API Objects
- **URL**: `["url", url.href]`
- **Headers**: `["headers", [[key, val], ...]]`

### Enhanced Error Support
New format: `["error", {name: string, message: string, stack?: string, cause?: unknown, customProps?: Record<string, unknown>}]`

Backward compatible with old format: `["error", name, message, stack?]`

Error serialization follows existing `onSendError` hook behavior (stack included only if hook returns an Error with stack property). New format adds support for `cause` chain and custom properties.

## Implementation

All changes follow existing Cap'n Web patterns. Type detection uses prototype matching (or `instanceof` for `URL`/`Headers`). Serialization/deserialization follows the existing `["type", data]` array format. Recursive types (Map, Set) use the same 64-level depth limit as objects and arrays.

## Format Examples

```javascript
// Map - entries wrapped in arrays (following Cap'n Web's array-wrapping convention)
new Map([["foo", "bar"]]) → ["map", [[["foo","bar"]]]]

// Set - array values wrapped
new Set(["foo", "bar"]) → ["set", ["foo","bar"]]

// ArrayBuffer - base64 with padding removed
new ArrayBuffer(4) → ["arraybuffer", "AAAA"]

// Headers - normalized to lowercase
headers.set("Content-Type", "application/json") → ["headers", [["content-type","application/json"]]]
```

## WebKit Test Failures

Two pre-existing test failures exist in the WebKit browser environment (HTTP requests and WebSocket connections). These are unrelated to serialization changes and appear to be Playwright/WebKit compatibility issues with localhost connectivity. Tests pass in Chromium, Firefox, Node.js, and workerd environments. We are running these tests on a MacBook Pro M4 running macOS 15.6.1 (24G90).

## Notes

- **Backward Compatible**: Old serialized data (e.g., old Error format) deserializes correctly. New serializations automatically use upgraded formats.
- **No Dependencies**: Code is inlined, maintaining Cap'n Web's "<10kB with no dependencies" goal.
- **No Cycle Support**: Explicitly does not support cycles/aliases (as desired by Cap'n Web authors).
- **Browser-Specific Error Properties**: Filtered out for consistent cross-browser behavior (WebKit: `line`, `column`, `sourceURL`; Firefox: `fileName`, `lineNumber`, `columnNumber`).

