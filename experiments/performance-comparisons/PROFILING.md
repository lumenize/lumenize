# Performance Profiling Instrumentation

## Overview

Performance instrumentation code has been added to the RPC package to measure operation timing and payload sizes. This code is marked with special comments for easy identification and removal.

## Instrumented Files

- `packages/rpc/src/websocket-rpc-transport.ts` - Client-side timing
- `packages/rpc/src/lumenize-rpc-do.ts` - Server-side timing

## What's Measured

**Client-side (websocket-rpc-transport.ts):**
- Request stringify time
- WebSocket send time  
- Response parse time
- Request/response payload sizes

**Server-side (lumenize-rpc-do.ts):**
- Request body read time (HTTP only)
- Request parse time
- Operation execution time
- Result preprocessing time (function replacement)
- Response stringify time
- Request/response payload sizes

## Marker Pattern

All instrumentation is wrapped in comments:

```typescript
// PERF_INSTRUMENTATION: START - Remove this block when profiling complete
const t0 = performance.now();
// ... timing code ...
console.log(JSON.stringify({ type: 'perf', ... }));
// PERF_INSTRUMENTATION: END
```

## Removal

### Option 1: Automated Script

```bash
cd experiments/performance-comparisons
./remove-perf-instrumentation.sh
git diff  # Review changes
```

### Option 2: Manual Search/Replace

1. Search for `// PERF_INSTRUMENTATION: START`
2. Delete from START through END marker (inclusive)
3. Review and test

### Option 3: Keep It

The instrumentation is:
- ✅ Clearly marked and documented
- ✅ Only active when console.log is visible
- ❌ Has runtime overhead (performance.now() + JSON.stringify)
- ❌ Clutters hot code paths

**Recommendation**: Remove after profiling is complete and documented in MEASUREMENTS.md

## Current Status

- ✅ Instrumentation added: 2025-01-20
- ✅ Findings documented in MEASUREMENTS.md
- ⏳ Next: Measure payload sizes
- ⏳ Then: Remove instrumentation before merge to main

## Testing After Removal

```bash
cd packages/rpc
npm test  # Ensure all tests still pass
```
