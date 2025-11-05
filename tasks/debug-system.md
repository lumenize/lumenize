# @lumenize/debug - Scoped Debug Logging

## Goal
Replace scattered `console.debug()` calls with a structured, filterable debug logging system inspired by npm's `debug` package, optimized for Cloudflare's JSON log dashboard.

## API Design

### Server-Side (NADIC-enabled)
```typescript
// In your DO/Worker - typical usage (local const)
class MyDO extends LumenizeBase {
  myMethod() {
    const log = this.svc.createDebug('proxy-fetch.serialization');
    log.debug('processing request', { url, method });
    log.info('milestone reached', { step: 3 });
    log.warn('suspicious behavior', { retryCount: 5 });
    // Outputs: { type: 'debug', level: 'debug', namespace: '...', message: '...', data: {...} }
  }
}

// Instance variable pattern (when reusing across methods or checking enabled)
class MyDO extends LumenizeBase {
  #log = this.svc.createDebug('proxy-fetch.do');
  
  method1() {
    if (this.#log.enabled) {
      // Expensive computation only if debugging
    }
    this.#log.debug('step 1', { ... });
  }
  
  method2() {
    this.#log.debug('step 2', { ... });
  }
}
```

### Client-Side (Imported)
```typescript
import { createDebug } from '@lumenize/debug/client';

const log = createDebug('my-app.websocket');
log.debug('connection opened', { id: connectionId });
log.info('handshake complete');
log.warn('reconnecting', { attempt: 3 });
```

## Filter Pattern Syntax

Follows npm `debug` conventions with level support:

**Namespace filtering:**
- `DEBUG=proxy-fetch` - matches `proxy-fetch` and all children (`proxy-fetch.*`)
- `DEBUG=proxy-fetch.serialization` - only this namespace
- `DEBUG=*` - everything
- `DEBUG=proxy-fetch,-proxy-fetch.verbose` - include proxy-fetch, exclude proxy-fetch.verbose
- `DEBUG=proxy-fetch:*,rpc:*` - multiple patterns (colon or comma separator)

**Level filtering:**
- `DEBUG=proxy-fetch` - enables debug, info, and warn levels
- `DEBUG=proxy-fetch:warn` - only warn level for this namespace
- `DEBUG=proxy-fetch:info` - info and warn (not debug)
- `DEBUG=*:debug` - all namespaces, debug level only

## Configuration Sources

**Server (Workers/DOs):**
- `this.env.DEBUG` - from wrangler.jsonc vars or .dev.vars
- Fallback: `process.env.DEBUG` (for Node.js tooling)

**Client (Browser):**
- `localStorage.DEBUG` - standard debug pattern
- Or programmatic: `setDebugNamespaces('my-app.*')`

## API Signature

```typescript
interface DebugLogger {
  enabled: boolean;
  debug(message: string, data?: any, options?: DebugOptions): void;
  info(message: string, data?: any, options?: DebugOptions): void;
  warn(message: string, data?: any, options?: DebugOptions): void;
}

interface DebugOptions {
  // Reserved for future use (color, etc.)
}
```

## Output Format

**Preserve JSON structure for Cloudflare log dashboard:**
```typescript
{
  type: 'debug',
  level: 'debug',  // or 'info', 'warn'
  namespace: 'proxy-fetch.serialization',
  message: 'encoding request',
  timestamp: '2025-11-05T21:15:30.123Z',
  data: {
    url: 'https://...',
    method: 'POST'
  }
}
```

**Benefits:**
- Queryable in Cloudflare dashboard by namespace, level, timestamp, or data fields
- No format strings needed (`%o` removed - JSON.stringify happens inside debug)
- Message always required for human readability

## Performance

```typescript
class DebugLogger {
  enabled: boolean;  // Pre-computed from filter
  
  debug(message: string, data?: any) {
    if (!this.enabled) return;  // Zero-cost when disabled
    // ... format and output
  }
  
  info(message: string, data?: any) {
    if (!this.enabled) return;
    // ... format and output
  }
  
  warn(message: string, data?: any) {
    if (!this.enabled) return;
    // ... format and output
  }
}
```

**Pattern:** Simple `enabled` flag check (no lazy evaluation). Zero-cost when disabled.

**For expensive operations:**
```typescript
if (log.enabled) {
  const expensiveData = computeExpensiveData();
  log.debug('computed', expensiveData);
}
```

## Migration Strategy

**Phase 1:** Build `@lumenize/debug` package
- Server implementation (NADIC service)
- Client implementation (standalone)
- Pattern matching engine
- Tests

**Phase 2:** Migrate packages one at a time
- Update `where: 'ClassName.method'` → namespace: `'package.subsystem'`
- Replace `console.debug({...})` → `debug(message, data)`
- Common pattern: `proxy-fetch.do`, `proxy-fetch.queue`, `rpc.transport`, `rpc.client`

**Phase 3:** Update docs and examples
- Document DEBUG usage in README files
- Add examples to troubleshooting guides

## Package Structure

```
packages/debug/
├── src/
│   ├── index.ts          # NADIC service (server-side)
│   ├── client.ts         # Standalone (browser/client)
│   ├── pattern-matcher.ts # Filter logic
│   └── types.ts
├── test/
│   ├── server.test.ts
│   ├── client.test.ts
│   └── patterns.test.ts
└── package.json
```

## Future Enhancements

**Color Coding (v2):**
- Deterministic color assignment per namespace for terminal output
- Need to verify Cloudflare terminal supports ANSI colors without breaking JSON parsing
- Would only color the namespace part, not the entire log

**Distributed Tracing (v2):**
- Auto-propagate `traceId` through RPC calls
- `ctx.traceId` available in all handlers
- For now: users can manually add `{ traceId }` to data

**Security Filtering (v2):**
- Global disallow list for sensitive field names (e.g., 'token', 'password')
- Deep object traversal to redact nested sensitive data
- Configurable: exact match vs substring match

**Separate Error Logging:**
- `console.error()` remains unfiltered (always logs)
- This system only handles debug/info/warn

## Next Steps

1. ✅ Review and refine this doc
2. Implement `@lumenize/debug` package
3. Migrate `@lumenize/proxy-fetch` first (lots of debug logs already)
4. Migrate other packages

