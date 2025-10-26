# Transport Injection: Design & Implementation Plan

## Current Architecture

### Transport Interface
```typescript
export interface RpcTransport {
  execute(batch: RpcBatchRequest): Promise<RpcBatchResponse>;
  connect?(): Promise<void>;
  disconnect?(): void;
  isConnected?(): boolean;
}
```

### Existing Implementations

**HttpPostRpcTransport** - Stateless HTTP transport  
**WebSocketRpcTransport** - Stateful WebSocket transport with connection lifecycle

Both are well-isolated with zero dependencies on RpcClient internals.

## Design Decision

**Remove string-based transport config (`'http'` | `'websocket'`)**

Use explicit factory functions for built-in transports:
- `createHttpTransport(config)` → RpcTransport
- `createWebSocketTransport(config)` → RpcTransport

Or provide custom transport instance directly.

### Rationale
1. Clean separation of concerns (client vs transport config)
2. No pollution of RpcClientConfig with transport-specific options
3. Explicit over implicit
4. Consistent approach for built-in and custom transports
5. Pre-1.0, limited adoption makes breaking change acceptable

## New Configuration

### RpcClientConfig (Simplified)
```typescript
export interface RpcClientConfig {
  /**
   * Transport instance for RPC communication.
   * Use createWebSocketTransport() or createHttpTransport() for built-in transports.
   * 
   * @example
   * ```typescript
   * import { createRpcClient, createWebSocketTransport } from '@lumenize/rpc';
   * 
   * const client = createRpcClient({
   *   transport: createWebSocketTransport('my-do', 'instance-1')
   * });
   * ```
   */
  transport: RpcTransport; // Required
}
```

**Removed config properties** (moved to transport factories):
- ~~`transport: 'http' | 'websocket'`~~
- ~~`doBindingName`~~ → Now in transport config (DO-specific)
- ~~`doInstanceNameOrId`~~ → Now in transport config (DO-specific)
- ~~`baseUrl`~~, ~~`prefix`~~, ~~`timeout`~~
- ~~`fetch`~~, ~~`headers`~~, ~~`WebSocketClass`~~

### Factory Functions

**createWebSocketTransport(doBindingName, doInstanceNameOrId, config?)**
```typescript
export function createWebSocketTransport(
  doBindingName: string,
  doInstanceNameOrId: string,
  config?: {
    baseUrl?: string;           // Default: location.origin or 'http://localhost:8787'
    prefix?: string;            // Default: '/__rpc'
    timeout?: number;           // Default: 30000
    WebSocketClass?: typeof WebSocket;
  }
): RpcTransport;
```

**createHttpTransport(doBindingName, doInstanceNameOrId, config?)**
```typescript
export function createHttpTransport(
  doBindingName: string,
  doInstanceNameOrId: string,
  config?: {
    baseUrl?: string;
    prefix?: string;
    timeout?: number;
    fetch?: typeof globalThis.fetch;
    headers?: Record<string, string>;
  }
): RpcTransport;
```

## Usage Examples

### Built-in Transports

**WebSocket (most common):**
```typescript
import { createRpcClient, createWebSocketTransport } from '@lumenize/rpc';

const client = createRpcClient({
  transport: createWebSocketTransport('my-do', 'instance-1')
  // All optional config uses smart defaults
});
```

**HTTP:**
```typescript
const client = createRpcClient({
  transport: createHttpTransport('my-do', 'instance-1', {
    headers: { 'Authorization': 'Bearer token' }
  })
});
```

### MessagePort Transport

**Generic transport for MessagePort-based communication:**
```typescript
class MessagePortRpcTransport implements RpcTransport {
  #port: MessagePort;
  #pendingCalls = new Map();

  constructor(port: MessagePort) {
    this.#port = port;
    this.#port.onmessage = (e) => this.#handleMessage(e.data);
  }

  async execute(batch: RpcBatchRequest): Promise<RpcBatchResponse> {
    return new Promise((resolve) => {
      const id = batch.batch[0].id;
      this.#pendingCalls.set(id, resolve);
      this.#port.postMessage(batch);
    });
  }

  #handleMessage(response: RpcBatchResponse): void {
    const id = response.batch[0].id;
    const resolve = this.#pendingCalls.get(id);
    if (resolve) {
      this.#pendingCalls.delete(id);
      resolve(response);
    }
  }

  isConnected(): boolean {
    return true;
  }
}

// Usage with SharedWorker:
const worker = new SharedWorker('/rpc-worker.js');
const client = createRpcClient({
  transport: new MessagePortRpcTransport(worker.port)
});

// Also works with iframe, Service Worker, or any MessagePort
```

> **Note**: This transport works with any MessagePort. For SharedWorker/Service Worker servers, a future `lumenizeRpcSharedWorker()` helper (similar to `lumenizeRpcDO()`) would handle the server side.

### Multi-Endpoint Pattern

Use multiple clients for complex routing:
```typescript
const upstreamClient = createRpcClient({
  transport: createWebSocketTransport('upstream-do', 'instance-1')
});

const downstreamClient = createRpcClient({
  transport: createHttpTransport('downstream-do', 'instance-2')
});

// Shuttle messages between endpoints
const result = await upstreamClient.getData();
await downstreamClient.processData(result);
```

## Migration Guide

### Before (REMOVED)
```typescript
const client = createRpcClient('my-do', 'instance-1', {
  transport: 'websocket',
  baseUrl: 'https://example.com',
  timeout: 30000,
  WebSocketClass: MyWebSocket
});
```

### After
```typescript
import { createRpcClient, createWebSocketTransport } from '@lumenize/rpc';

const client = createRpcClient({
  transport: createWebSocketTransport('my-do', 'instance-1', {
    baseUrl: 'https://example.com',
    timeout: 30000,
    WebSocketClass: MyWebSocket
  })
});
```

**Migration steps:**
1. Add import for `createWebSocketTransport` or `createHttpTransport`
2. Remove `doBindingName` and `doInstanceNameOrId` from createRpcClient args
3. Pass DO params as positional args to transport factory
4. Pass other transport config as optional config object
5. Remove transport-specific props from RpcClientConfig

**Estimated time:** ~2 minutes per codebase

## Implementation Plan

### Phase 1: Type Updates
1. Export `RpcTransport` interface from index.ts
2. Export factory functions from index.ts
3. Export built-in transport classes (for advanced use)
4. Update `RpcClientConfig.transport` type to: `transport: RpcTransport` (required)
5. Update `createRpcClient` signature to: `createRpcClient(config: RpcClientConfig)`
6. Remove `doBindingName` and `doInstanceNameOrId` from createRpcClient signature
7. Remove all transport-specific config from RpcClientConfig
8. Add `transportInstance` getter to RpcClient

### Phase 2: Factory Implementation
1. Create `createHttpTransport()` factory function
2. Create `createWebSocketTransport()` factory function
3. Provide smart defaults (baseUrl, prefix, timeout)
4. Validate required params

### Phase 3: Client Updates
1. Update `createRpcClient` to take single config object (remove positional params)
2. Simplify `#createTransport()` to: `return this.#config.transport`
3. Remove all branching logic for string config and defaults
4. Update all tests to use new signature with factory functions
5. Remove tests for string-based config and old signature

### Phase 4: Documentation & Migration
1. Update all documentation examples
2. Update all doc-test examples
3. Create migration guide
4. Update CHANGELOG with breaking changes

## Benefits

✅ **Clean architecture** - Each component owns its concerns  
✅ **No config pollution** - RpcClientConfig is minimal (just transport)  
✅ **Transport agnostic** - Client has zero knowledge of DO concepts  
✅ **Consistency** - Same pattern for built-in and custom transports  
✅ **Flexibility** - Pre-configure, share, compose transports  
✅ **Simplicity** - Less branching in client code  
✅ **Explicitness** - Clear what's happening, no defaults  
✅ **Extensibility** - Custom transports are first-class citizens  
✅ **Universal** - Works for DO, SharedWorker, MessagePort, or any transport  

## Design Decisions

1. **String config removed** - Instance-based approach via factory functions
2. **Transport required** - No default transport (explicit over implicit)
3. **No DO params on client** - doBindingName/doInstanceNameOrId moved to transport config
4. **Single config object** - createRpcClient(config) not createRpcClient(binding, id, config)
5. **No runtime validation** - TypeScript only (compile-time safety)
6. **Singular transport** - One client, one transport (multi-client for complex routing)
7. **Transport owns config** - Complete decoupling from client
8. **No deprecation period** - Cold turkey removal (pre-1.0, limited adoption)
