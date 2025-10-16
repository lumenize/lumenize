import type {
  OperationChain,
  Operation,
  RpcRequest,
  RpcResponse,
  RpcConfig,
  RemoteFunctionMarker
} from './types';
import { serializeError } from './error-serialization';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stringify, parse } = require('@ungap/structured-clone/json');

/**
 * Default RPC configuration
 */
const DEFAULT_CONFIG: Required<RpcConfig> = {
  prefix: '/__rpc',
  maxDepth: 50,
  maxArgs: 100,
};

// ============================================================================
// Standalone RPC Handler Functions (for manual routing)
// ============================================================================

/**
 * Handle RPC requests manually without using the factory function.
 * Returns Response for RPC requests, null for non-RPC requests.
 * 
 * This is useful for users who want full control over their routing
 * and want to mix RPC with other custom endpoints.
 * 
 * @param request - The incoming HTTP request
 * @param doInstance - The Durable Object instance to operate on
 * @param config - Optional RPC configuration
 * @returns Response for RPC requests, null for non-RPC requests
 * 
 * @example
 * ```typescript
 * export class MyDO extends DurableObject {
 *   async fetch(request: Request): Promise<Response> {
 *     // Handle RPC requests
 *     const rpcResponse = await handleRpcRequest(request, this);
 *     if (rpcResponse) return rpcResponse;
 *     
 *     // Handle other custom routes
 *     return new Response('Not found', { status: 404 });
 *   }
 * }
 * ```
 */
export async function handleRpcRequest(
  request: Request,
  doInstance: any,
  config: RpcConfig = {}
): Promise<Response | null> {
  const rpcConfig = { ...DEFAULT_CONFIG, ...config };
  const url = new URL(request.url);
  
  // Only handle RPC endpoints
  if (!url.pathname.startsWith(rpcConfig.prefix)) {
    return null; // Not an RPC request, let other handlers deal with it
  }

  const pathnameSegments = url.pathname.split('/');
  const endpoint = pathnameSegments.at(-1);
  
  switch (endpoint) {
    case 'call':
      return handleCallRequest(request, doInstance, rpcConfig);
    default:
      return new Response(`Unknown RPC endpoint: ${url.pathname}`, { status: 404 });
  }
}

/**
 * Handle RPC call requests
 * @internal - implementation detail of handleRpcRequest
 */
async function handleCallRequest(
  request: Request,
  doInstance: any,
  config: Required<RpcConfig>
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Parse the entire request using @ungap/structured-clone/json
    const requestBody = await request.text();
    const rpcRequest: RpcRequest = parse(requestBody);

    // Validate the operations chain
    const operations = validateOperationChain(rpcRequest.operations, config);
    
    // Execute operation chain
    const result = await executeOperationChain(operations, doInstance);
    
    // Replace functions with markers before structured-clone serialization
    const processedResult = preprocessResult(result, operations);
    
    const response: RpcResponse = {
      success: true,
      result: processedResult
    };
    
    // Use stringify on the entire response object
    const responseBody = stringify(response);
    return new Response(responseBody, {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error: any) {
    console.error('%o', {
      type: 'error',
      where: 'handleCallRequest',
      message: 'RPC call execution failed',
      error: error?.message || error
    });
    const response: RpcResponse = {
      success: false,
      error: serializeError(error)
    };
    // Use stringify on the entire error response
    const responseBody = stringify(response);
    return new Response(responseBody, {
      status: 500,
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

async function executeOperationChain(operations: OperationChain, doInstance: any): Promise<any> {
  let current: any = doInstance; // Start from the DO instance
  
  for (const operation of operations) {
    if (operation.type === 'get') {
      // Property/element access
      current = current[operation.key];
    } else if (operation.type === 'apply') {
      // Function call
      if (typeof current !== 'function') {
        throw new Error(`TypeError: ${String(current)} is not a function`);
      }
      
      // Find the correct 'this' context by walking back to the parent object
      const parent = findParentObject(operations.slice(0, operations.indexOf(operation)), doInstance);
      current = await current.apply(parent, operation.args);
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

function preprocessResult(result: any, operationChain: OperationChain, seen = new WeakMap()): any {
  // Handle primitives - return as-is, structured-clone will handle them
  if (result === null || result === undefined || typeof result !== 'object') {
    return result;
  }
  
  // Handle circular references - return the already-processed object
  if (seen.has(result)) {
    return seen.get(result);
  }
  
  // Handle built-in types that structured-clone handles natively - return as-is
  if (result instanceof Date || result instanceof RegExp || result instanceof Map || 
      result instanceof Set || result instanceof ArrayBuffer || 
      ArrayBuffer.isView(result) || result instanceof Error) {
    return result;
  }
  
  // Handle arrays - recursively process items for function replacement
  if (Array.isArray(result)) {
    // Create the processed array FIRST and add to seen map BEFORE processing children
    // This is crucial for handling circular references correctly
    const processedArray: any[] = [];
    seen.set(result, processedArray);
    
    for (let index = 0; index < result.length; index++) {
      const item = result[index];
      const currentChain: OperationChain = [...operationChain, { type: 'get', key: index }];
      
      // Check if the array item itself is a function and convert to marker
      if (typeof item === 'function') {
        const marker: RemoteFunctionMarker = {
          __isRemoteFunction: true,
          __operationChain: currentChain,
          __functionName: `[${index}]`, // Use array index as function name
        };
        processedArray[index] = marker;
      } else {
        processedArray[index] = preprocessResult(item, currentChain, seen);
      }
    }
    
    return processedArray;
  }
  
  // Handle plain objects - replace functions with markers, recursively process other values
  // Create the processed object FIRST and add to seen map BEFORE processing children
  const processedObject: any = {};
  seen.set(result, processedObject);
  
  // Process enumerable properties
  for (const [key, value] of Object.entries(result)) {
    const currentChain: OperationChain = [...operationChain, { type: 'get', key: key }];
    
    if (typeof value === 'function') {
      // Replace function with remote function marker
      const marker = {
        __isRemoteFunction: true,
        __operationChain: currentChain,
        __functionName: key,
      } as RemoteFunctionMarker;
      processedObject[key] = marker;
    } else {
      // Recursively process non-function values
      processedObject[key] = preprocessResult(value, currentChain, seen);
    }
  }
  
  // Also check prototype chain for methods and getters
  let proto = Object.getPrototypeOf(result);
  while (proto && proto !== Object.prototype && proto !== null) {
    const descriptors = Object.getOwnPropertyDescriptors(proto);
    
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'constructor' || processedObject.hasOwnProperty(key)) {
        continue;
      }
      
      const currentChain: OperationChain = [...operationChain, { type: 'get', key: key }];
      
      // Check if it's a method (function value)
      if (descriptor.value && typeof descriptor.value === 'function') {
        const marker: RemoteFunctionMarker = {
          __isRemoteFunction: true,
          __operationChain: currentChain,
          __functionName: key,
        };
        processedObject[key] = marker;
      }
      // Check if it's a getter
      else if (descriptor.get) {
        try {
          const value = descriptor.get.call(result);
          if (typeof value === 'function') {
            // Getter returns a function - create marker
            const marker: RemoteFunctionMarker = {
              __isRemoteFunction: true,
              __operationChain: currentChain,
              __functionName: key,
            };
            processedObject[key] = marker;
          } else if (value !== undefined && value !== null) {
            // Getter returns a non-function value - recursively process it
            processedObject[key] = preprocessResult(value, currentChain, seen);
          }
        } catch (error) {
          // If getter throws, just skip it
          // We could optionally mark it: processedObject[key] = '[Getter throws]';
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
 * RPC message envelope sent from client to server via WebSocket.
 * The entire request object (including the operations array) is encoded using
 * @ungap/structured-clone/json stringify() before transmission.
 */
interface RpcWebSocketRequest {
  id: string;
  type: string; // e.g., '__rpc'
  operations: OperationChain;
}

/**
 * RPC response envelope sent from server to client via WebSocket.
 * The entire response object (including result) will be encoded using
 * @ungap/structured-clone/json stringify() before transmission.
 */
interface RpcWebSocketResponse {
  id: string;
  type: string; // e.g., '__rpc'
  success: boolean;
  result?: any;
  error?: any;
}

/**
 * Handle RPC messages received via WebSocket.
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
 * @example
 * ```typescript
 * export class MyDO extends DurableObject {
 *   async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
 *     // Handle RPC messages
 *     if (await handleRpcMessage(ws, message, this)) {
 *       return; // Message was handled as RPC
 *     }
 *     
 *     // Handle other custom WebSocket messages
 *     if (message === 'ping') {
 *       ws.send('pong');
 *     }
 *   }
 * }
 * ```
 */
export async function handleRpcMessage(
  ws: WebSocket,
  message: string | ArrayBuffer,
  doInstance: any,
  config: RpcConfig = {}
): Promise<boolean> {
  // Only handle string messages
  if (typeof message !== 'string') {
    return false;
  }

  const rpcConfig = { ...DEFAULT_CONFIG, ...config };
  
  // Extract message type from prefix (remove leading/trailing slashes)
  const messageType = rpcConfig.prefix.replace(/^\/+|\/+$/g, '');

  try {
    // Parse the entire message using @ungap/structured-clone/json
    const request: RpcWebSocketRequest = parse(message);

    // Check if this is an RPC message by verifying the type field
    if (request.type !== messageType) {
      return false; // Not an RPC message
    }

    // Verify required fields
    if (!request.id || !request.operations) {
      console.warn('%o', {
        type: 'warn',
        where: 'handleRpcMessage',
        message: 'Invalid RPC WebSocket request: missing id or operations'
      });
      return false;
    }

    // Process the RPC request
    try {
      // Validate the operation chain
      const operations = validateOperationChain(request.operations, rpcConfig);
      
      // Execute operation chain
      const result = await executeOperationChain(operations, doInstance);
      
      // Replace functions with markers before serialization
      const processedResult = preprocessResult(result, operations);
      
      // Send success response
      const response: RpcWebSocketResponse = {
        id: request.id,
        type: messageType,
        success: true,
        result: processedResult
      };
      
      // Use stringify on the entire response
      ws.send(stringify(response));
      
    } catch (error: any) {
      console.error('%o', {
        type: 'error',
        where: 'handleRpcMessage',
        message: 'RPC operation execution failed',
        error: error?.message || error
      });
      
      // Send error response
      const response: RpcWebSocketResponse = {
        id: request.id,
        type: messageType,
        success: false,
        error: serializeError(error)
      };
      
      // Use stringify on the entire error response
      ws.send(stringify(response));
    }

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
 * @example
 * ```typescript
 * export class MyDO extends lumenizeRpcDO(DurableObject, {
 *   prefix: '/__rpc',
 *   maxDepth: 100
 * }) {
 *   async myMethod() {
 *     return 'Hello from DO!';
 *   }
 * }
 * ```
 */
export function lumenizeRpcDO<T extends new (...args: any[]) => any>(DOClass: T, config: RpcConfig = {}): T {
  if (typeof DOClass !== 'function') {
    throw new Error(`lumenizeRpcDO() expects a Durable Object class (constructor function), got ${typeof DOClass}`);
  }

  const rpcConfig = { ...DEFAULT_CONFIG, ...config };

  // Create enhanced class that extends the original
  class LumenizedDO extends (DOClass as T) {

    async fetch(request: Request): Promise<Response> {
      console.debug('%o', {
        type: 'debug',
        where: 'LumenizeDO in factory lumenizeRpcDO',
        url: request.url,
      });
      
      // Check for WebSocket upgrade request
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        const url = new URL(request.url);
        
        // Only handle WebSocket upgrades for RPC endpoints
        if (url.pathname.startsWith(rpcConfig.prefix)) {
          const webSocketPair = new WebSocketPair();
          const [client, server] = Object.values(webSocketPair);
          
          // Accept the WebSocket connection
          (this as any).ctx.acceptWebSocket(server);
          
          return new Response(null, {
            status: 101,
            webSocket: client,
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
      // Try to handle as RPC message
      const wasHandled = await handleRpcMessage(ws, message, this, rpcConfig);
      
      // If not handled as RPC, call parent's webSocketMessage (if it exists)
      if (!wasHandled && super.webSocketMessage) {
        return super.webSocketMessage(ws, message);
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
  Object.defineProperty(LumenizedDO, 'name', { value: (DOClass as any).name });

  return LumenizedDO as T;
}
