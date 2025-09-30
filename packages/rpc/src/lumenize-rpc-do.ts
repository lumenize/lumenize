// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serialize, deserialize } = require('@ungap/structured-clone');

import type {
  OperationChain,
  RPCRequest,
  RPCResponse,
  RPCConfig,
  RemoteFunctionMarker
} from './types';
import { serializeError } from './error-serialization';

/**
 * Default RPC configuration
 */
const DEFAULT_CONFIG: Required<RPCConfig> = {
  basePath: '/__rpc',
  maxDepth: 50,
  maxArgs: 100,
};

/**
 * Adds RPC capabilities to a Durable Object class
 * 
 * @param DOClass - The Durable Object class to enhance
 * @param config - Optional RPC configuration
 * @returns Enhanced DO class with RPC endpoints
 */
export function lumenizeRpcDo<T extends new (...args: any[]) => any>(DOClass: T, config: RPCConfig = {}): T {
  if (typeof DOClass !== 'function') {
    throw new Error(`lumenizeRpcDo() expects a Durable Object class (constructor function), got ${typeof DOClass}`);
  }

  const rpcConfig = { ...DEFAULT_CONFIG, ...config };

  // Create enhanced class that extends the original
  class LumenizedDO extends (DOClass as T) {

    async fetch(request: Request): Promise<Response> {
      return (
        await this.handleRPCRequest(request) ||
        super.fetch(request)
      );
    }

    private async handleRPCRequest(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      
      // Only handle RPC endpoints
      if (!url.pathname.startsWith(rpcConfig.basePath)) {
        return null; // Not an RPC request, let other handlers deal with it
      }

      const endpoint = url.pathname.substring(rpcConfig.basePath.length);
      
      try {
        switch (endpoint) {
          case '/call':
            return this.handleCallRequest(request);
          default:
            return new Response(`Unknown RPC endpoint: ${endpoint}`, { status: 404 });
        }
      } catch (error: any) {
        console.error('%o', {
          type: 'error',
          where: 'Lumenize.handleRPCRequest',
          message: 'RPC request handling failed',
          endpoint,
          error: error?.message || error
        });
        const response: RPCResponse = {
          success: false,
          error: serializeError(error)
        };
        return Response.json(response, { status: 500 });
      }
    }

    async handleCallRequest(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      try {
        const rpcRequest = await request.json() as RPCRequest;
        
        // Deserialize and validate the entire operations chain in one call
        const deserializedOperations = this.deserializeOperationChain(rpcRequest.operations);
        
        // Execute operation chain
        const result = await this.executeOperationChain(deserializedOperations);
        
        // Replace functions with markers before structured-clone serialization
        const processedResult = this.preprocessResult(result, rpcRequest.operations);
        
        const response: RPCResponse = {
          success: true,
          result: serialize(processedResult) // Structured-clone serialize the processed result
        };
        
        return Response.json(response); // JSON serialize the whole response
        
      } catch (error: any) {
        console.error('%o', {
          type: 'error',
          where: 'Lumenize.handleCallRequest',
          message: 'RPC call execution failed',
          error: error?.message || error
        });
        const response: RPCResponse = {
          success: false,
          error: serializeError(error) // Custom error serialization (already an object)
        };
        return Response.json(response, { status: 500 }); // JSON serialize the whole response
      }
    }

    private deserializeOperationChain(serializedOperations: any): OperationChain {
      // Deserialize the entire operations array in one call - much more efficient
      const operations: OperationChain = deserialize(serializedOperations);
      
      // Validate the deserialized operations (parse don't validate principle)
      if (!Array.isArray(operations)) {
        throw new Error('Invalid RPC request: operations must be an array');
      }
      
      if (operations.length > rpcConfig.maxDepth) {
        throw new Error(`Operation chain too deep: ${operations.length} > ${rpcConfig.maxDepth}`);
      }
      
      for (const operation of operations) {
        if (operation.type === 'apply' && operation.args.length > rpcConfig.maxArgs) {
          throw new Error(`Too many arguments: ${operation.args.length} > ${rpcConfig.maxArgs}`);
        }
      }
      
      return operations;
    }

    private async executeOperationChain(operations: OperationChain): Promise<any> {
      let current: any = this; // Start from the DO instance
      
      for (const operation of operations) {
        if (operation.type === 'get') {
          // Property/element access
          current = current[operation.key];
          if (current === undefined || current === null) {
            throw new Error(`Property '${String(operation.key)}' is undefined or null`);
          }
        } else if (operation.type === 'apply') {
          // Function call
          if (typeof current !== 'function') {
            throw new Error(`TypeError: ${String(current)} is not a function`);
          }
          
          // Find the correct 'this' context by walking back to the parent object
          const parent = this.findParentObject(operations.slice(0, operations.indexOf(operation)));
          current = await current.apply(parent, operation.args);
        }
      }
      
      return current;
    }

    private findParentObject(operations: OperationChain): any {
      if (operations.length === 0) return this;
      
      let parent: any = this;
      // Execute all operations except the last one to find the parent
      for (const operation of operations.slice(0, -1)) {
        if (operation.type === 'get') {
          parent = parent[operation.key];
        } else if (operation.type === 'apply') {
          // For apply operations, we need to execute them to get the result
          const grandParent = this.findParentObject(operations.slice(0, operations.indexOf(operation)));
          parent = parent.apply(grandParent, operation.args);
        }
      }
      return parent;
    }

    private preprocessResult(result: any, operationChain: OperationChain, seen = new WeakSet()): any {
      // Handle primitives - return as-is, structured-clone will handle them
      if (result === null || result === undefined || typeof result !== 'object') {
        return result;
      }
      
      // Handle circular references - prevent infinite recursion in our preprocessing
      if (seen.has(result)) {
        return result;
      }
      seen.add(result);
      
      // Handle built-in types that structured-clone handles natively - return as-is
      if (result instanceof Date || result instanceof RegExp || result instanceof Map || 
          result instanceof Set || result instanceof ArrayBuffer || 
          ArrayBuffer.isView(result) || result instanceof Error) {
        return result;
      }
      
      // Handle arrays - recursively process items for function replacement
      if (Array.isArray(result)) {
        return result.map((item, index) => {
          const currentChain: OperationChain = [...operationChain, { type: 'get', key: index }];
          return this.preprocessResult(item, currentChain, seen);
        });
      }
      
      // Handle plain objects - replace functions with markers, recursively process other values
      const processedObject: any = {};
      
      // Process enumerable properties
      for (const [key, value] of Object.entries(result)) {
        const currentChain: OperationChain = [...operationChain, { type: 'get', key: key }];
        
        if (typeof value === 'function') {
          // Replace function with remote function marker
          processedObject[key] = {
            __isRemoteFunction: true,
            __operationChain: currentChain,
            __functionName: key,
          } as RemoteFunctionMarker;
        } else {
          // Recursively process non-function values
          processedObject[key] = this.preprocessResult(value, currentChain, seen);
        }
      }
      
      // Also check prototype chain for methods
      let proto = Object.getPrototypeOf(result);
      while (proto && proto !== Object.prototype && proto !== null) {
        const descriptors = Object.getOwnPropertyDescriptors(proto);
        
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (key === 'constructor' || processedObject.hasOwnProperty(key)) {
            continue;
          }
          
          if (descriptor.value && typeof descriptor.value === 'function') {
            const currentChain: OperationChain = [...operationChain, { type: 'get', key: key }];
            const marker: RemoteFunctionMarker = {
              __isRemoteFunction: true,
              __operationChain: currentChain,
              __functionName: key,
            };
            processedObject[key] = marker;
          }
        }
        
        proto = Object.getPrototypeOf(proto);
      }
      
      return processedObject;
    }
  }

  // Copy static properties from original class
  Object.setPrototypeOf(LumenizedDO, DOClass);
  Object.defineProperty(LumenizedDO, 'name', { value: (DOClass as any).name });

  return LumenizedDO as T;
}
