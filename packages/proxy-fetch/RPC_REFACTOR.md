# ProxyFetch RPC Refactor

**Date**: 2025-11-15  
**Commit Before**: "About to refactor proxy fetch to use RPC to WorkerEntryPoint"

## Summary

Successfully refactored `@lumenize/proxy-fetch` from HTTP-based dispatch to RPC-based dispatch using Cloudflare Service Bindings. The new architecture uses `FetchExecutorEntrypoint` (a `WorkerEntrypoint`) invoked via RPC instead of HTTP POST requests.

## What Changed

### Architecture

**Before (HTTP)**:
1. Origin DO → FetchOrchestrator: Enqueue fetch (RPC) ✅
2. FetchOrchestrator → Worker: HTTP POST with auth header
3. Worker fetch handler → `handleProxyFetchExecution`: Validate secret, parse JSON
4. Worker → External API: Execute fetch (CPU billing) ✅
5. Worker → Origin DO: Send result (RPC) ✅

**After (RPC)**:
1. Origin DO → FetchOrchestrator: Enqueue fetch (RPC) ✅
2. FetchOrchestrator → Worker: RPC call to `FetchExecutorEntrypoint.executeFetch()`
3. Worker entrypoint → External API: Execute fetch (CPU billing) ✅
4. Worker → Origin DO: Send result (RPC) ✅

### Files Changed

**New**:
- `src/FetchExecutorEntrypoint.ts` - WorkerEntrypoint for RPC

**Modified**:
- `src/FetchOrchestrator.ts` - Uses RPC instead of HTTP dispatch
- `src/proxyFetchWorker.ts` - Updated JSDoc/examples
- `src/workerFetchExecutor.ts` - Updated JSDoc
- `src/types.ts` - Replaced HTTP options with RPC options
- `src/index.ts` - Export `FetchExecutorEntrypoint`, removed HTTP handler exports
- `test/worker/test-worker-and-dos.ts` - Export entrypoint, simplified worker export
- `test/worker/wrangler.jsonc` - Added service binding, removed vars
- `test/worker/integration.test.ts` - Removed HTTP handler tests

**Deleted**:
- `src/handleProxyFetchExecution.ts` - No longer needed
- 9 HTTP handler tests - No longer applicable

### Type Changes

```typescript
// Before
interface ProxyFetchWorkerOptions {
  workerUrl?: string;           // HTTP URL
  workerPath?: string;          // HTTP path
  secretEnvVar?: string;        // Auth secret
  // ...
}

// After
interface ProxyFetchWorkerOptions {
  executorBinding?: string;     // Service binding name (default: 'FETCH_EXECUTOR')
  // ...
}
```

### Setup Changes

**Before**:
```typescript
// Worker fetch handler
import { handleProxyFetchExecution } from '@lumenize/proxy-fetch';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxyFetchResponse = await handleProxyFetchExecution(request, env);
    if (proxyFetchResponse) return proxyFetchResponse;
    
    return routeDORequest(request, env);
  }
}
```

```bash
# Set shared secret
wrangler secret put PROXY_FETCH_SECRET
```

**After**:
```typescript
// Worker - just export the entrypoint
export { FetchExecutorEntrypoint } from '@lumenize/proxy-fetch';
```

```jsonc
// wrangler.jsonc - add service binding
{
  "services": [{
    "binding": "FETCH_EXECUTOR",
    "service": "my-worker",
    "entrypoint": "FetchExecutorEntrypoint"
  }]
}
```

## Benefits

### Removed Complexity
- ❌ No secret management (`PROXY_FETCH_SECRET`)
- ❌ No HTTP authentication headers
- ❌ No JSON parsing/validation
- ❌ No path matching (`/proxy-fetch-execute`)
- ❌ No worker URL configuration

### Added Benefits
- ✅ **Type-safe**: RPC methods are strongly typed
- ✅ **Simpler**: No auth, no HTTP handler, no worker URL
- ✅ **Single codebase**: Test and production use same code path
- ✅ **Account-scoped security**: Service bindings are isolated per account

### Preserved Benefits
- ✅ Same billing model (CPU billing for fetch execution)
- ✅ Same latency characteristics
- ✅ Same scalability (Worker pool auto-scales)
- ✅ Direct result delivery (no hop through orchestrator)

## Performance

**No change expected**: The HTTP request was already a same-account connection with negligible overhead. RPC has equivalent performance characteristics.

## Test Results

✅ All 13 integration tests pass  
✅ 89.43% statement coverage (up from 87.5% - removed untested HTTP paths)  
✅ No linting errors

## Migration Guide

For users upgrading from HTTP-based to RPC-based:

1. **Remove secret management**:
   ```bash
   # No longer needed
   # wrangler secret put PROXY_FETCH_SECRET
   ```

2. **Update worker exports**:
   ```typescript
   // Remove handleProxyFetchExecution from fetch handler
   // Add this export instead
   export { FetchExecutorEntrypoint } from '@lumenize/proxy-fetch';
   ```

3. **Update wrangler.jsonc**:
   ```jsonc
   {
     // Remove these vars
     // "vars": {
     //   "WORKER_URL": "...",
     //   "PROXY_FETCH_SECRET": "..."
     // },
     
     // Add this service binding
     "services": [{
       "binding": "FETCH_EXECUTOR",
       "service": "your-worker-name",
       "entrypoint": "FetchExecutorEntrypoint"
     }]
   }
   ```

4. **Update proxyFetchWorker calls** (optional):
   ```typescript
   // Before
   await proxyFetchWorker(
     this,
     request,
     continuation,
     { workerUrl: env.WORKER_URL, secretEnvVar: 'PROXY_FETCH_SECRET' }
   );
   
   // After
   await proxyFetchWorker(
     this,
     request,
     continuation,
     { executorBinding: 'FETCH_EXECUTOR' } // or omit for default
   );
   ```

## Why This Refactor?

**Original question**: "Why not use RPC in production also?"

The HTTP-based approach was designed to avoid service bindings for simplicity, but this created:
- Secret management overhead
- Auth validation code
- HTTP handler complexity
- Test vs production code path differences

Using RPC everywhere is **simpler**, **type-safe**, and **removes** these pain points while maintaining the same performance and billing characteristics.

## Next Steps

1. ✅ RPC refactor complete
2. ✅ Tests passing
3. ✅ Documentation updated
4. 🔄 Update website docs (if any)
5. 🔄 Release notes for breaking change

