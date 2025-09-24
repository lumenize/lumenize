// eslint-disable-next-line @typescript-eslint/no-require-imports
const { serialize, deserialize } = require('@ungap/structured-clone');

import type { 
  OperationChain, 
  RPCRequest, 
  RPCResponse, 
  RPCConfig,
  RemoteFunctionMarker 
} from './types';
import { serializeError } from './serialization';

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
export function lumenize<T>(DOClass: T, config: RPCConfig = {}): T {
  if (typeof DOClass !== 'function') {
    return DOClass;
  }

  const rpcConfig = { ...DEFAULT_CONFIG, ...config };

  // Create enhanced class that extends the original
  class LumenizedDO extends (DOClass as any) {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      
      // Handle RPC endpoints
      if (url.pathname.startsWith(rpcConfig.basePath)) {
        return this.handleRPCRequest(request);
      }
      
      // Delegate to original user's fetch method
      return super.fetch(request);
    }

    async handleRPCRequest(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        const endpoint = url.pathname.substring(rpcConfig.basePath.length);
        
        switch (endpoint) {
          case '/info':
            return this.handleInfoRequest();
          case '/call':
            return this.handleCallRequest(request);
          default:
            return new Response('RPC endpoint not found', { status: 404 });
        }
      } catch (error: any) {
        console.error('[RPC] Request handling error:', error);
        const response: RPCResponse = {
          success: false,
          error: serializeError(error)
        };
        return Response.json(response, { status: 500 });
      }
    }

    async handleInfoRequest(): Promise<Response> {
      return Response.json({
        className: this.constructor.name,
        timestamp: Date.now(),
        isLumenized: true,
        availableEndpoints: [
          `${rpcConfig.basePath}/info`,
          `${rpcConfig.basePath}/call`
        ],
        config: rpcConfig
      });
    }

    async handleCallRequest(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      try {
        const rpcRequest = await request.json() as RPCRequest;
        
        // Validate request
        this.validateRPCRequest(rpcRequest);
        
        // Deserialize arguments in apply operations
        const deserializedOperations = this.deserializeOperationChain(rpcRequest.operations);
        
        // Execute operation chain
        const result = await this.executeOperationChain(deserializedOperations);
        
        // Process result for serialization
        const processedResult = this.preprocessResult(result, rpcRequest.operations);
        
        const response: RPCResponse = {
          success: true,
          result: serialize(processedResult) // Structured-clone serialize the result
        };
        
        return Response.json(response); // JSON serialize the whole response
        
      } catch (error: any) {
        console.error('[RPC] Call execution error:', error);
        const response: RPCResponse = {
          success: false,
          error: serializeError(error) // Custom error serialization (already an object)
        };
        return Response.json(response, { status: 500 }); // JSON serialize the whole response
      }
    }

    private validateRPCRequest(request: RPCRequest): void {
      if (!Array.isArray(request.operations)) {
        throw new Error('Invalid RPC request: operations must be an array');
      }
      
      if (request.operations.length > rpcConfig.maxDepth) {
        throw new Error(`Operation chain too deep: ${request.operations.length} > ${rpcConfig.maxDepth}`);
      }
      
      for (const operation of request.operations) {
        if (operation.type === 'apply' && operation.args.length > rpcConfig.maxArgs) {
          throw new Error(`Too many arguments: ${operation.args.length} > ${rpcConfig.maxArgs}`);
        }
      }
    }

    private deserializeOperationChain(operations: OperationChain): OperationChain {
      return operations.map(operation => {
        if (operation.type === 'apply') {
          // Deserialize the entire args array that was structured-clone serialized by the client
          return {
            ...operation,
            args: deserialize(operation.args)
          };
        }
        return operation; // 'get' operations don't have args to deserialize
      });
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
            throw new Error(`Cannot call non-function value: ${typeof current}`);
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

    private preprocessResult(result: any, operationChain: OperationChain, seen = new WeakMap()): any {
      // Handle primitive types and null/undefined
      if (result === null || result === undefined || typeof result !== 'object') {
        return result;
      }
      
      // Handle circular references
      if (seen.has(result)) {
        return seen.get(result);
      }
      
      // Handle arrays
      if (Array.isArray(result)) {
        const processedArray: any[] = [];
        seen.set(result, processedArray);
        processedArray.push(...result.map((item, index) => {
          const currentChain: OperationChain = [...operationChain, { type: 'get', key: index }];
          return this.preprocessResult(item, currentChain, seen);
        }));
        return processedArray;
      }
      
      // Handle built-in types that structured clone handles natively
      if (result instanceof Date || result instanceof RegExp || result instanceof Map || 
          result instanceof Set || result instanceof ArrayBuffer || 
          ArrayBuffer.isView(result) || result instanceof Error) {
        return result;
      }
      
      // Handle plain objects
      const processedObject: any = {};
      seen.set(result, processedObject);
      
      // Process enumerable properties
      for (const [key, value] of Object.entries(result)) {
        const currentChain: OperationChain = [...operationChain, { type: 'get', key: key }];
        
        if (typeof value === 'function') {
          // Create remote function marker
          const marker: RemoteFunctionMarker = {
            __isRemoteFunction: true,
            __operationChain: currentChain,
            __functionName: key,
          };
          processedObject[key] = marker;
        } else {
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