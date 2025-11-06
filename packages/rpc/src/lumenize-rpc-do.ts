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
import { stringify, parse } from '@lumenize/structured-clone';
import { walkObject } from './walk-object';
import { isStructuredCloneNativeType } from './structured-clone-utils';
import { debug } from '@lumenize/debug';

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
  const log = debug(doInstance)('rpc.downstream');
  
  // Normalize to array
  const ids = Array.isArray(clientIds) ? clientIds : [clientIds];
  
  // Build downstream message envelope
  const message = {
    type: '__downstream',
    payload
  };

  // Serialize the message with full type support
  const messageString = await stringify(message);

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
  const log = debug(doInstance)('rpc.server');
  
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Parse the batch request using @lumenize/structured-clone
    const requestBody = await request.text();
    const batchRequest: RpcBatchRequest = await parse(requestBody);

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
    
    const responseBody = await stringify(batchResponse);
    
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
    const responseBody = await stringify(batchResponse);
    return new Response(responseBody, {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function validateOperationChain(operations: OperationChain, config: Required<RpcConfig>): OperationChain {
  // Validate the operations (parse doesn't validate principle)
  if (!Array.isArray(operations)) {
    throw new Error('Invalid RPC request: operations must be an array');
  }
  
  if (operations.length > config.maxDepth) {
    throw new Error(`Operation chain too deep: ${operations.length} > ${config.maxDepth}`);
  }
  
  for (const operation of operations) {
    if (operation.type === 'apply' && operation.args.length > config.maxArgs) {
      throw new Error(`Too many arguments: ${operation.args.length} > ${config.maxArgs}`);
    }
  }
  
  return operations;
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
    // Validate the operations chain
    const validatedOperations = validateOperationChain(operations, config);
    
    // Process incoming operations to deserialize Web API objects in args
    const processedOperations = await processIncomingOperations(validatedOperations, doInstance, refIdCache);
    
    // Execute operation chain
    const result = await executeOperationChain(processedOperations, doInstance);
    
    // Replace functions with markers before serialization
    const processedResult = await preprocessResult(result, processedOperations);
    
    return {
      success: true,
      result: processedResult
    };
    
  } catch (error: any) {
    return {
      success: false,
      error // stringify() will handle Error serialization
    };
  }
}

async function executeOperationChain(operations: OperationChain, doInstance: any): Promise<any> {
  let current: any = doInstance; // Start from the DO instance
  
  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];
    
    if (operation.type === 'get') {
      // Property/element access
      current = current[operation.key];
    } else if (operation.type === 'apply') {
      // Function call
      if (typeof current !== 'function') {
        throw new Error(`TypeError: ${String(current)} is not a function`);
      }
      
      // Call the method on its parent object to preserve 'this' context.
      // This works for both regular methods and Workers RPC stub methods.
      const parent = findParentObject(operations.slice(0, i), doInstance);
      const prevOp = i > 0 ? operations[i - 1] : null;
      
      if (prevOp?.type === 'get') {
        // Previous operation was property access, call as method
        const methodName = prevOp.key;
        current = await parent[methodName](...operation.args);
      } else {
        // Direct function call (no property access), use apply
        current = await current.apply(parent, operation.args);
      }
    }
  }
  
  return current;
}

function findParentObject(operations: OperationChain, doInstance: any): any {
  if (operations.length === 0) return doInstance;
  
  let parent: any = doInstance;
  // Execute all operations except the last one to find the parent
  for (const operation of operations.slice(0, -1)) {
    if (operation.type === 'get') {
      parent = parent[operation.key];
    } else if (operation.type === 'apply') {
      // For apply operations, we need to execute them to get the result
      const grandParent = findParentObject(operations.slice(0, operations.indexOf(operation)), doInstance);
      parent = parent.apply(grandParent, operation.args);
    }
  }
  return parent;
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

async function preprocessResult(result: any, operationChain: OperationChain, seen = new WeakMap()): Promise<any> {
  // Handle primitives
  if (result === null || result === undefined) {
    return result;
  }
  
  // Handle other primitives - structured-clone will handle them (including special numbers)
  if (typeof result !== 'object') {
    return result;
  }
  
  // Handle circular references - return the already-processed object
  if (seen.has(result)) {
    return seen.get(result);
  }
  
  // Handle built-in types that structured-clone preserves perfectly - return as-is
  // This includes Web API objects, Dates, Maps, Sets, Errors, etc.
  if (isStructuredCloneNativeType(result)) {
    return result;
  }
  
  // Handle arrays - recursively process items for function replacement
  if (Array.isArray(result)) {
    const processedArray: any[] = [];
    seen.set(result, processedArray);
    
    for (let index = 0; index < result.length; index++) {
      const item = result[index];
      const currentChain: OperationChain = [...operationChain, { type: 'get', key: index }];
      
      if (typeof item === 'function') {
        const marker: RemoteFunctionMarker = {
          __isRemoteFunction: true,
          __operationChain: currentChain,
          __functionName: `[${index}]`,
        };
        processedArray[index] = marker;
      } else {
        processedArray[index] = await preprocessResult(item, currentChain, seen);
      }
    }
    
    return processedArray;
  }
  
  // Handle plain objects - use walkObject for enumerable properties and prototype chain
  const processedObject: any = {};
  seen.set(result, processedObject);
  
  // Process enumerable properties
  for (const [key, value] of Object.entries(result)) {
    const currentChain: OperationChain = [...operationChain, { type: 'get', key: key }];
    
    if (typeof value === 'function') {
      const marker: RemoteFunctionMarker = {
        __isRemoteFunction: true,
        __operationChain: currentChain,
        __functionName: key,
      };
      processedObject[key] = marker;
    } else {
      processedObject[key] = await preprocessResult(value, currentChain, seen);
    }
  }
  
  // Walk prototype chain using walkObject for getters
  let proto = Object.getPrototypeOf(result);
  while (proto && proto !== Object.prototype && proto !== null) {
    const descriptors = Object.getOwnPropertyDescriptors(proto);
    
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'constructor' || processedObject.hasOwnProperty(key)) {
        continue;
      }
      
      const currentChain: OperationChain = [...operationChain, { type: 'get', key: key }];
      
      if (descriptor.value && typeof descriptor.value === 'function') {
        const marker: RemoteFunctionMarker = {
          __isRemoteFunction: true,
          __operationChain: currentChain,
          __functionName: key,
        };
        processedObject[key] = marker;
      } else if (descriptor.get) {
        try {
          const value = descriptor.get.call(result);
          if (typeof value === 'function') {
            const marker: RemoteFunctionMarker = {
              __isRemoteFunction: true,
              __operationChain: currentChain,
              __functionName: key,
            };
            processedObject[key] = marker;
          } else if (value !== undefined && value !== null) {
            processedObject[key] = await preprocessResult(value, currentChain, seen);
          }
        } catch (error) {
          // If getter throws, just skip it
        }
      }
    }
    
    proto = Object.getPrototypeOf(proto);
  }
  
  return processedObject;
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
  const log = debug(doInstance)('rpc.websocket');
  
  // Only handle string messages
  if (typeof message !== 'string') {
    return false;
  }

  const rpcConfig = { ...DEFAULT_CONFIG, ...config };
  
  // Extract message type from prefix (remove leading/trailing slashes)
  const messageType = rpcConfig.prefix.replace(/^\/+|\/+$/g, '');

  try {
    // Parse the entire message using @lumenize/structured-clone
    const wsMessage: RpcWebSocketMessage = await parse(message);

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
    
    const responseBody = await stringify(messageResponse);
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
    #log = debug(this)('rpc.factory');

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

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      // Use blockConcurrencyWhile if configured, otherwise call directly
      if (rpcConfig.blockConcurrency) {
        await this.ctx.blockConcurrencyWhile(async () => {
          const wasHandled = await handleRpcMessage(ws, message, this, rpcConfig);
          
          // If not handled as RPC, call parent's webSocketMessage (if it exists)
          if (!wasHandled && super.webSocketMessage) {
            return super.webSocketMessage(ws, message);
          }
        });
      } else {
        const wasHandled = await handleRpcMessage(ws, message, this, rpcConfig);
        
        // If not handled as RPC, call parent's webSocketMessage (if it exists)
        if (!wasHandled && super.webSocketMessage) {
          return super.webSocketMessage(ws, message);
        }
      }
    }

    webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
      // Call parent's webSocketClose if it exists
      if (super.webSocketClose) {
        return super.webSocketClose(ws, code, reason, wasClean);
      }
    }
  }

  // Copy static properties from original class
  Object.setPrototypeOf(LumenizedDO, DOClass);
  Object.defineProperty(LumenizedDO, 'name', { value: DOClass.name });

  return LumenizedDO as T;
}
