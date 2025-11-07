/**
 * RPC-specific transform hooks for structured-clone preprocessing/postprocessing
 * 
 * These hooks handle function serialization/deserialization while letting
 * structured-clone manage the tree traversal and identity tracking.
 */

import { TRANSFORM_SKIP, type PreprocessTransform, type PostprocessTransform, type PathElement } from '@lumenize/structured-clone';
import type { OperationChain, RemoteFunctionMarker } from './types';

/**
 * Converts PathElement array to OperationChain
 */
function pathToOperationChain(path: PathElement[]): OperationChain {
  return path.map(element => ({
    type: 'get' as const,
    key: element.key
  }));
}

/**
 * Server-side preprocess transform: converts functions to remote function markers
 * 
 * @param baseOperationChain - The base operation chain to prepend (e.g., the method call that returned this result)
 * @returns Transform function for use with structured-clone preprocess
 */
export function createRpcPreprocessTransform(baseOperationChain: OperationChain): PreprocessTransform {
  return (value, context) => {
    // Only handle functions - let structured-clone handle everything else
    if (typeof value === 'function') {
      // Build the full operation chain: base + path to this function
      const pathChain = pathToOperationChain(context.path);
      const fullChain = [...baseOperationChain, ...pathChain];
      
      // Return a remote function marker
      const marker: RemoteFunctionMarker = {
        __isRemoteFunction: true,
        __operationChain: fullChain,
        __functionName: value.name || 'anonymous',
      };
      
      return marker;
    }
    
    // Not a function - let structured-clone handle it
    return TRANSFORM_SKIP;
  };
}

/**
 * Client-side postprocess transform: converts remote function markers to proxies
 * 
 * @param createProxy - Function that creates a proxy for a given operation chain
 * @returns Transform function for use with structured-clone postprocess
 */
export function createRpcPostprocessTransform(
  createProxy: (operationChain: OperationChain) => any
): PostprocessTransform {
  return (value, context) => {
    // Check if this is a remote function marker
    if (value && typeof value === 'object' && value.__isRemoteFunction === true) {
      const marker = value as RemoteFunctionMarker;
      // Convert marker to proxy
      return createProxy(marker.__operationChain);
    }
    
    // Not a marker - let structured-clone handle it
    return TRANSFORM_SKIP;
  };
}

/**
 * Check if value is a nested operation marker
 */
function isNestedOperationMarker(value: any): boolean {
  return value && 
         typeof value === 'object' && 
         (value.__operationChain !== undefined || value.__refId !== undefined);
}

/**
 * Server-side postprocess transform for incoming operations: converts nested operation markers to results
 * 
 * @param doInstance - The DO instance to execute operations against
 * @param refIdCache - Cache for tracking resolved nested operations by refId
 * @param executeOperationChain - Function to execute an operation chain
 * @returns Transform function for use with structured-clone postprocess
 */
export function createIncomingOperationsTransform(
  doInstance: any,
  refIdCache: Map<string, any>,
  executeOperationChain: (operations: OperationChain, doInstance: any) => Promise<any>
): PostprocessTransform {
  return async (value, context) => {
    // Check if this is a nested operation marker
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
        
        // First occurrence: execute and cache
        // Note: This will recursively call postprocess on the nested operations
        const result = await executeOperationChain(value.__operationChain, doInstance);
        
        // Cache the result for subsequent alias references
        refIdCache.set(value.__refId, result);
        return result;
      } else {
        // Legacy marker without refId (backward compatibility)
        if (!value.__operationChain) {
          throw new Error('Nested operation marker missing __operationChain');
        }
        const result = await executeOperationChain(value.__operationChain, doInstance);
        return result;
      }
    }
    
    // Not a marker - let structured-clone handle it
    return TRANSFORM_SKIP;
  };
}
