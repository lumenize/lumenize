import type {
  OperationChain,
  RpcBatchRequest,
  RpcBatchResponse,
  RpcConfig,
  RemoteFunctionMarker,
  RpcWebSocketMessage,
  RpcWebSocketMessageResponse
} from './types';
import { isNestedOperationMarker } from './types';
import { preprocess, parse } from '@lumenize/structured-clone';
import { walkObject } from './walk-object';
import { isStructuredCloneNativeType } from './structured-clone-utils';
import { debug } from '@lumenize/debug';
import { executeOperationChain, validateOperationChain } from './ocan.js';

/**
 * Default RPC configuration
 */
const DEFAULT_CONFIG: Required<RpcConfig> = {
  prefix: '/__rpc',
  maxDepth: 50,
  maxArgs: 100,
  blockConcurrency: false,
};

// ============================================================================
// Downstream Messaging
// ============================================================================

/**
 * Send a downstream message to specific clients via their WebSocket connections.
 * 
 * Messages are sent with type '__downstream' and support full type serialization
 * via @lumenize/structured-clone (Errors, Web API objects, special numbers, etc.).
 * 
 * This is a fire-and-forget operation - messages are sent immediately to connected
 * clients. If a client is disconnected, the message is not queued or retried.
 * Use application-layer catchup patterns (e.g., fetching missed messages by ID)
 * for reliability.
 * 
 * @param clientIds - Client ID(s) to send the message to (string or array of strings)
 * @param doInstance - The Durable Object instance (pass `this`)
 * @param payload - The payload to send (supports all serializable types)
 * 
 * @see [Downstream Messaging Guide](https://lumenize.com/docs/rpc/downstream-messaging) - Complete examples with authentication
 */
export async function sendDownstream(
  clientIds: string | string[],
  doInstance: any,
  payload: any
): Promise<void> {
  const log = debug('lmz.rpc.sendDownstream');
  
  // Normalize to array
  const ids = Array.isArray(clientIds) ? clientIds : [clientIds];
  
  // Build downstream message envelope
  const message = {
    type: '__downstream',
    payload
  };

  // Serialize the message with full type support
  const intermediate = preprocess(message);
  const messageString = JSON.stringify(intermediate);

  // Get WebSockets with matching tags
  for (const clientId of ids) {
    const connections = doInstance.ctx.getWebSockets(clientId);
    
    for (const ws of connections) {
      try {
        ws.send(messageString);
      } catch (error) {
        log.warn('Failed to send downstream message', {
          clientId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}

// ============================================================================
// Standalone RPC Handler Functions (for manual routing)
// ============================================================================

/**
 * Handle RPC requests manually without using the factory function.
 * 
 * Only use this if you want more direct control over the routing inside your DO.
 * Most of the time, you will use the auto-wrapper functionality of `lumenizeRpcDO`.
 * 
 * Returns Response for RPC requests, undefined for non-RPC requests.
 * 
 * This function is called from the fetch handler to check if
 * an incoming message is an RPC request and handle it accordingly.
 * 
 * @param request - The incoming HTTP request
 * @param doInstance - The Durable Object instance to operate on
 * @param config - Optional RPC configuration
 * @returns Response for RPC requests, undefined for non-RPC requests
 * 
 * @see For working examples, see packages/rpc/test/test-worker-and-dos.ts
 */
export async function handleRpcRequest(
  request: Request,
  doInstance: any,
  config: RpcConfig = {}
): Promise<Response | undefined> {
  const rpcConfig = { ...DEFAULT_CONFIG, ...config };
  const url = new URL(request.url);
  
  // Only handle RPC endpoints
  if (!url.pathname.startsWith(rpcConfig.prefix)) {
    return undefined; // Not an RPC request, let other handlers deal with it
  }

  const pathnameSegments = url.pathname.split('/');
  const endpoint = pathnameSegments.at(-1);
  
  switch (endpoint) {
    case 'call':
      // Use blockConcurrencyWhile if configured, otherwise call directly
      if (rpcConfig.blockConcurrency) {
        return doInstance.ctx.blockConcurrencyWhile(() => 
          handleCallRequest(request, doInstance, rpcConfig)
        );
      }
      return handleCallRequest(request, doInstance, rpcConfig);
    default:
      return new Response(`Unknown RPC endpoint: ${url.pathname}`, { status: 404 });
  }
}

/**
 * Handle RPC call requests (now always in batch format)
 * @internal - implementation detail of handleRpcRequest
 */
async function handleCallRequest(
  request: Request,
  doInstance: any,
  config: Required<RpcConfig>
): Promise<Response> {
  const log = debug('lmz.rpc.handleCallRequest');
  
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Parse the batch request using @lumenize/structured-clone
    const requestBody = await request.text();
    const batchRequest: RpcBatchRequest = parse(requestBody);

    const batchResults: Array<{ id: string; success: boolean; result?: any; error?: any }> = [];
    const refIdCache = new Map<string, any>();  // Shared cache for alias detection across batch

    // Process each operation in the batch
    for (const item of batchRequest.batch) {
      const callResult = await dispatchCall(item.operations, doInstance, config, refIdCache);
      
      // Log errors for debugging
      if (!callResult.success) {
        log.warn('RPC operation execution failed', {
          id: item.id,
          error: callResult.error
        });
      }

      batchResults.push({
        id: item.id,
        ...callResult  // Spread success/result or success/error
      });
    }

    // Send batch response
    const batchResponse: RpcBatchResponse = {
      batch: batchResults
    };
    
    const intermediate = preprocess(batchResponse);
    const responseBody = JSON.stringify(intermediate);
    
    // Check if any operations failed
    const hasErrors = batchResults.some(r => !r.success);
    
    return new Response(responseBody, {
      status: hasErrors ? 500 : 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error: any) {
    // This catch is for request parsing errors, not RPC execution errors
    log.warn('Request parsing failed', {
      error: error?.message || error
    });
    // Return a batch response with a single error
    const batchResponse: RpcBatchResponse = {
      batch: [{
        id: 'parse-error',
        success: false,
        error // stringify() will handle Error serialization
      }]
    };
    const intermediate = preprocess(batchResponse);
    const responseBody = JSON.stringify(intermediate);
    return new Response(responseBody, {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Core RPC dispatch logic - validates, executes, and processes the result.
 * Handles both success and error cases consistently.
 * 
 * @param operations - The operation chain to execute
 * @param doInstance - The Durable Object instance to operate on
 * @param config - RPC configuration
 * @returns Object with success flag and either result or error
 */
async function dispatchCall(
  operations: OperationChain,
  doInstance: any,
  config: Required<RpcConfig>,
  refIdCache?: Map<string, any>  // Optional cache for alias detection (shared across batch)
): Promise<{ success: true; result: any } | { success: false; error: any }> {
  try {
    // Validate the operations chain using core's validator
    validateOperationChain(operations, { maxDepth: config.maxDepth, maxArgs: config.maxArgs });
    
    // Process incoming operations to deserialize Web API objects in args
    const processedOperations = await processIncomingOperations(operations, doInstance, refIdCache);
    
    // Execute operation chain using core's executor
    const result = await executeOperationChain(processedOperations, doInstance);
    
    return {
      success: true,
      result: copyResultForWire(result, processedOperations, new WeakMap())
    };
    
  } catch (error: any) {
    return {
      success: false,
      error // stringify() will handle Error serialization
    };
  }
}

/**
 * Process incoming operations to resolve pipelined operation markers.
 * Walks the operation chain, finds 'apply' operations, and detects nested operation markers,
 * executing them and caching results by refId (for alias detection).
 * Structured-clone handles all other deserialization.
 */
async function processIncomingOperations(
  operations: OperationChain, 
  doInstance: any,
  refIdCache: Map<string, any> = new Map()  // Cache results by refId for alias detection
): Promise<OperationChain> {
  const processedOperations: OperationChain = [];
  
  for (const operation of operations) {
    if (operation.type === 'apply' && operation.args.length > 0) {
      // Use walkObject to resolve nested operation markers in the args
      const transformer = async (value: any) => {
        // Check if this is a nested operation marker that needs to be resolved
        if (isNestedOperationMarker(value)) {
          // Check if this marker has a refId (for alias detection)
          if (value.__refId) {
            // Check cache first
            if (refIdCache.has(value.__refId)) {
              return refIdCache.get(value.__refId);
            }
            
            // Not in cache - must have __operationChain (first occurrence)
            if (!value.__operationChain) {
              throw new Error(
                `Alias marker with refId "${value.__refId}" has no operation chain and no cached result. ` +
                `This indicates the alias was encountered before the full marker.`
              );
            }
            
            // First occurrence: process and execute, then cache
            const processedChain = await processIncomingOperations(value.__operationChain, doInstance, refIdCache);
            const result = await executeOperationChain(processedChain, doInstance);
            
            // Cache the result for subsequent alias references
            refIdCache.set(value.__refId, result);
            return result;
          } else {
            // Legacy marker without refId (backward compatibility)
            if (!value.__operationChain) {
              throw new Error('Nested operation marker missing __operationChain');
            }
            const processedChain = await processIncomingOperations(value.__operationChain, doInstance, refIdCache);
            const result = await executeOperationChain(processedChain, doInstance);
            return result;
          }
        }
        // Everything else passes through unchanged
        // structured-clone handles Web API objects, Errors, and special numbers natively
        return value;
      };
      
      // Walk the args array to find and resolve nested operation markers
      // Skip recursing into built-in types that structured-clone handles natively
      const processedArgs = await walkObject(operation.args, transformer, {
        shouldSkipRecursion: isStructuredCloneNativeType
      });
      
      processedOperations.push({
        type: 'apply',
        args: processedArgs
      });
    } else {
      // 'get' operations pass through unchanged
      processedOperations.push(operation);
    }
  }
  
  return processedOperations;
}

/**
 * Copies a method's result for the wire. Every function becomes a remote
 * function marker whose operation chain leads back to it, and every class
 * instance becomes a plain object carrying its prototype's methods and getter
 * values. The copy is taken as the call returns, so a later call in the same
 * batch cannot change this call's answer, and an object reached twice, or
 * through a cycle, is copied once.
 *
 * A Map key or value, or a Set member, adds no step to the chain, since an
 * operation chain has no step into a Map or Set: a function there gets the
 * chain that reaches the container.
 */
function copyResultForWire(value: any, chain: OperationChain, seen: WeakMap<object, any>): any {
  if (typeof value === 'function') {
    const marker: RemoteFunctionMarker = {
      __isRemoteFunction: true,
      __operationChain: chain,
      __functionName: value.name || 'anonymous',
    };
    return marker;
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  // Each copy is registered before its children are copied, so a cycle back
  // to it resolves to the copy.
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [k, v] of value) {
      copy.set(copyResultForWire(k, chain, seen), copyResultForWire(v, chain, seen));
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const member of value) copy.add(copyResultForWire(member, chain, seen));
    return copy;
  }
  // structured-clone encodes the rest of these whole. A function in a returned
  // Error's own property arrives as the codec's `function` tag, not a marker.
  if (isStructuredCloneNativeType(value)) {
    seen.set(value, value);
    return value;
  }
  if (Array.isArray(value)) {
    const copy: any[] = new Array(value.length);
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) {
      if (Object.hasOwn(value, i)) {
        copy[i] = copyResultForWire(value[i], [...chain, { type: 'get', key: i }], seen);
      }
    }
    return copy;
  }

  const copy: Record<string, any> = {};
  seen.set(value, copy);
  for (const [key, val] of Object.entries(value)) {
    setOwn(copy, key, copyResultForWire(val, [...chain, { type: 'get', key }], seen));
  }
  // A class instance's methods and getters live on its prototype chain.
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (key === 'constructor' || Object.hasOwn(copy, key)) continue;
      if ('value' in descriptor) {
        setOwn(copy, key, copyResultForWire(descriptor.value, [...chain, { type: 'get', key }], seen));
      } else if (descriptor.get) {
        // Evaluated, so `__asObject()` inspection sees the value; a getter
        // that throws or answers undefined is left out.
        try {
          const getterValue = descriptor.get.call(value);
          if (getterValue !== undefined) {
            setOwn(copy, key, copyResultForWire(getterValue, [...chain, { type: 'get', key }], seen));
          }
        } catch {
          // skip it
        }
      }
    }
  }
  return copy;
}

// Defines an own property, so a key named `__proto__` is copied as data
// rather than replacing the copy's prototype.
function setOwn(target: Record<string, any>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

// ============================================================================
// WebSocket RPC Handler
// ============================================================================

/**
 * Handle RPC messages received via WebSocket.
 * 
 * Only use this if you want more direct control over the routing inside your DO.
 * Most of the time, you will use the auto-wrapper functionality of `lumenizeRpcDO`.
 * 
 * Returns true if the message was handled as an RPC message, false otherwise.
 * 
 * This function is called from the webSocketMessage handler to check if
 * an incoming message is an RPC request and handle it accordingly.
 * 
 * @param ws - The WebSocket connection
 * @param message - The incoming message
 * @param doInstance - The Durable Object instance to operate on
 * @param config - Optional RPC configuration
 * @returns true if message was handled as RPC, false if not an RPC message
 * 
 * @see For working examples, see packages/rpc/test/test-worker-and-dos.ts
 */
export async function handleRpcMessage(
  ws: WebSocket,
  message: string | ArrayBuffer,
  doInstance: any,
  config: RpcConfig = {}
): Promise<boolean> {
  const log = debug('lmz.rpc.handleRpcMessage');
  
  // Only handle string messages
  if (typeof message !== 'string') {
    return false;
  }

  const rpcConfig = { ...DEFAULT_CONFIG, ...config };
  
  // Extract message type from prefix (remove leading/trailing slashes)
  const messageType = rpcConfig.prefix.replace(/^\/+|\/+$/g, '');

  try {
    // Parse the entire message using @lumenize/structured-clone
    const wsMessage: RpcWebSocketMessage = parse(message);

    // Check if this is an RPC message by verifying the type field
    if (wsMessage.type !== messageType) {
      return false; // Not an RPC message
    }

    const batchResults: Array<{ id: string; success: boolean; result?: any; error?: any }> = [];
    const refIdCache = new Map<string, any>();  // Shared cache for alias detection across batch

    // Process each operation in the batch
    for (const item of wsMessage.batch) {
      const callResult = await dispatchCall(item.operations, doInstance, rpcConfig, refIdCache);
      
      // Log errors for debugging
      if (!callResult.success) {
        log.warn('RPC operation execution failed', {
          id: item.id,
          error: callResult.error
        });
      }

      batchResults.push({
        id: item.id,
        ...callResult  // Spread success/result or success/error
      });
    }

    // Send batch response
    const messageResponse: RpcWebSocketMessageResponse = {
      type: messageType,
      batch: batchResults
    };
    
    const intermediate = preprocess(messageResponse);
    const responseBody = JSON.stringify(intermediate);
    ws.send(responseBody);

    return true; // Message was handled as RPC
    
  } catch (parseError) {
    // Not valid JSON or not an RPC message
    return false;
  }
}

// ============================================================================
// Factory Function (uses the standalone handlers above)
// ============================================================================

/**
 * Adds RPC capabilities to a Durable Object class using a factory pattern.
 *
 * This is the recommended approach for most use cases as it provides
 * a clean separation between your business logic and RPC handling.
 * 
 * @param DOClass - The Durable Object class to enhance
 * @param config - Optional RPC configuration
 * @returns Enhanced DO class with RPC endpoints
 * 
 * @see [Usage Examples](https://lumenize.com/docs/rpc/quick-start#srcindexts) - Complete tested examples
 */
export function lumenizeRpcDO<T extends new (...args: any[]) => any>(DOClass: T, config: RpcConfig = {}): T {
  if (typeof DOClass !== 'function') {
    throw new Error(`lumenizeRpcDO() expects a Durable Object class (constructor function), got ${typeof DOClass}`);
  }

  const rpcConfig = { ...DEFAULT_CONFIG, ...config };

  // Create enhanced class that extends the original
  class LumenizedDO extends (DOClass as T) {
    #log = debug('lmz.rpc.lumenizeRpcDO');

    /**
     * The WebSocket handlers are installed per instance, after the wrapped class has constructed,
     * rather than defined on this prototype. A class may install its own handlers per instance and
     * skip any name the object already has — the Cloudflare Agents SDK does exactly that — so a
     * prototype method here would stop it installing them, and every message this wrapper does not
     * handle would reach nothing. `fetch` stays on the prototype: the classes this wraps define it
     * there, the Agents SDK's included.
     */
    constructor(...args: any[]) {
      super(...args);
      const innerMessage = (this as any).webSocketMessage;
      const innerClose = (this as any).webSocketClose;

      Object.defineProperty(this, 'webSocketMessage', {
        configurable: true,
        writable: true,
        value: async (ws: WebSocket, message: string | ArrayBuffer): Promise<void> => {
          const dispatch = async () => {
            const wasHandled = await handleRpcMessage(ws, message, this, rpcConfig);
            // Not RPC: hand it to the wrapped class's own handler, if it has one
            if (!wasHandled && typeof innerMessage === 'function') {
              return innerMessage.call(this, ws, message);
            }
          };
          // Use blockConcurrencyWhile if configured, otherwise call directly
          if (rpcConfig.blockConcurrency) await this.ctx.blockConcurrencyWhile(dispatch);
          else await dispatch();
        },
      });

      Object.defineProperty(this, 'webSocketClose', {
        configurable: true,
        writable: true,
        value: (ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> => {
          if (typeof innerClose === 'function') return innerClose.call(this, ws, code, reason, wasClean);
        },
      });
    }

    async fetch(request: Request): Promise<Response> {
      this.#log.debug('RPC fetch handler', { url: request.url });
      
      // Check for WebSocket upgrade request
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        const url = new URL(request.url);
        
        // Only handle WebSocket upgrades for RPC endpoints
        if (url.pathname.startsWith(rpcConfig.prefix)) {
          const webSocketPair = new WebSocketPair();
          const [client, server] = Object.values(webSocketPair);
          
          // Extract clientId from WebSocket protocols header
          // Client should send: ['lumenize.rpc', 'lumenize.rpc.clientId.${clientId}']
          // This smuggles the clientId securely without logging it in URLs
          let clientId: string | null = null;
          const protocolsHeader = request.headers.get('Sec-WebSocket-Protocol');
          if (protocolsHeader) {
            const protocols = protocolsHeader.split(',').map(p => p.trim());
            for (const protocol of protocols) {
              if (protocol.startsWith('lumenize.rpc.clientId.')) {
                clientId = protocol.substring('lumenize.rpc.clientId.'.length);
                break;
              }
            }
          }
          
          // Note: DOs can set up their own auto-response via this.ctx.setWebSocketAutoResponse()
          // in their constructor if needed. We don't set one here to avoid overwriting custom
          // auto-responses. RPC clients implement their own heartbeat via setKeepAlive().
          
          // Accept the hibernatable WebSocket connection with optional tag
          if (clientId) {
            this.ctx.acceptWebSocket(server, [clientId]);
            // Store clientId in WebSocket attachment for easy retrieval
            // This persists across DO hibernation and is accessible via deserializeAttachment()
            server.serializeAttachment({ clientId });
          } else {
            this.ctx.acceptWebSocket(server);
          }
          
          // Respond with the primary protocol (not the clientId one)
          return new Response(null, {
            status: 101,
            webSocket: client,
            headers: {
              'Sec-WebSocket-Protocol': 'lumenize.rpc'
            }
          });
        }
      }
      
      // Use the exported handleRpcRequest function for HTTP requests
      return (
        await handleRpcRequest(request, this, rpcConfig) ||
        super.fetch(request)
      );
    }
  }

  // Copy static properties from original class
  Object.setPrototypeOf(LumenizedDO, DOClass);
  Object.defineProperty(LumenizedDO, 'name', { value: DOClass.name });

  return LumenizedDO as T;
}
