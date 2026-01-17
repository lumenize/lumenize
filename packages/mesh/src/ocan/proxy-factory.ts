import type { Operation, OperationChain, NestedOperationMarker } from './types.js';
import { isNestedOperationMarker } from './types.js';

/**
 * WeakMap to track proxy objects and their operation chains.
 * Used for nesting detection - when a proxy is used as an argument
 * to another operation, we can detect it and convert to a marker.
 * 
 * @internal
 */
const proxyToOperationChain = new WeakMap<object, OperationChain>();

/**
 * Get the operation chain associated with a proxy object.
 * Returns undefined if the object is not a continuation proxy.
 * 
 * @internal
 */
export function getOperationChain(proxy: any): OperationChain | undefined {
  return proxyToOperationChain.get(proxy);
}

/**
 * Process arguments to detect nested continuations and convert them to markers.
 * This enables operation nesting where one continuation's result becomes
 * the input to another continuation.
 * 
 * @internal
 */
function processArgumentsForNesting(args: any[]): any[] {
  return args.map(arg => {
    // Check if this argument is a continuation proxy
    const chain = proxyToOperationChain.get(arg);
    if (chain) {
      // Convert to nested operation marker
      return {
        __isNestedOperation: true,
        __operationChain: chain
      } as NestedOperationMarker;
    }
    return arg;
  });
}

/**
 * Create a continuation proxy that builds an operation chain.
 * 
 * The returned proxy intercepts property access and function calls,
 * building an operation chain that can be executed later.
 * 
 * Supports:
 * - **Chaining**: `c().method1().method2().method3()`
 * - **Nesting**: `c().combine(c().getData(), c().getMore())`
 * 
 * @example
 * ```typescript
 * // Simple chaining
 * const chain = newContinuation<MyDO>()
 *   .getUserData(userId)
 *   .formatResponse();
 * 
 * // Nesting
 * const chain = newContinuation<MyDO>()
 *   .combineData(
 *     newContinuation<RemoteDO>().getUserData(userId),
 *     newContinuation<RemoteDO>().getOrgData(orgId)
 *   );
 * ```
 * 
 * @typeParam T - The target object type (for type safety)
 * @returns A proxy that builds an operation chain
 */
export function newContinuation<T = any>(): T {
  return createProxyWithChain([]) as T;
}

/**
 * Internal helper to create a proxy with a given operation chain.
 * Supports both chaining (property access) and nesting (proxy arguments).
 * 
 * @internal
 */
function createProxyWithChain(chain: OperationChain): any {
  // Use a function as the proxy target so it can be called
  const proxy = new Proxy(() => {}, {
    get(target: any, key: string | symbol): any {
      // Symbols can't be serialized, return undefined
      if (typeof key === 'symbol') {
        return undefined;
      }
      
      // Build new chain with property access
      const newChain: OperationChain = [...chain, { type: 'get', key }];
      return createProxyWithChain(newChain);
    },
    
    apply(target: any, thisArg: any, args: any[]): any {
      // Process arguments to detect nested continuations
      const processedArgs = processArgumentsForNesting(args);
      
      // Build new chain with function call
      const newChain: OperationChain = [...chain, { type: 'apply', args: processedArgs }];
      return createProxyWithChain(newChain);
    }
  });
  
  // Register this proxy in the WeakMap for nesting detection
  proxyToOperationChain.set(proxy, chain);
  
  return proxy;
}

