/**
 * RPC-specific transform hooks for structured-clone preprocessing/postprocessing
 * 
 * These hooks handle function serialization/deserialization while letting
 * structured-clone manage the tree traversal and identity tracking.
 */

import { TRANSFORM_SKIP, type PreprocessTransform, type PathElement } from '@lumenize/structured-clone';
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
